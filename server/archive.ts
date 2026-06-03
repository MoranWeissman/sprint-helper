/**
 * Markdown archive (R8). The SQLite DB at `~/.sprint-helper/data.db` stays
 * the source of truth; this module mirrors session activity to plain
 * markdown files under `~/sprint-helper/sprints/<sprint>/<title> (#id).md`
 * so Moran can browse, search, and archive without the app running.
 *
 * Decisions (locked with Moran 2026-06-02):
 *   - Location: `~/sprint-helper/` (visible folder, side-by-side with repos).
 *   - Granularity: one file per TASK (all sittings inside one markdown file).
 *   - Update trigger: every session_start / session_log / session_end —
 *     each call rewrites the file in full. Files are kilobytes; this is fine.
 *   - Per-sprint `summary.md` and `helper-notes.md` are added by other
 *     functions in this module.
 *
 * Atomic writes: write to `<path>.tmp` then rename. A crash mid-write
 * leaves either the old file or the new one, never a half-written file.
 */
import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { buildDashboardCached } from './dashboard-cache';
import {
  listEventsForSession,
  listSessionsForWorkItem,
  type Session,
  type SessionEvent,
} from './sessions';

const ARCHIVE_ROOT = join(homedir(), 'sprint-helper', 'sprints');

/** Reserved chars + control bytes stripped from filesystem paths. */
function safeFilename(s: string): string {
  return s
    .replace(/[\/\\:*?"<>|]/g, '-')
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 180);
}

async function writeAtomic(filePath: string, content: string): Promise<void> {
  await fs.mkdir(dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp`;
  await fs.writeFile(tmp, content, 'utf8');
  await fs.rename(tmp, filePath);
}

function fmtISODate(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function fmtISODateTime(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${fmtISODate(iso)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fmtClock(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fmtHours(h: number | null | undefined): string {
  if (h == null) return '—';
  if (h === 0) return '0h';
  if (h < 1) {
    const m = Math.round(h * 60);
    return `${m}m`;
  }
  const whole = Math.floor(h);
  const m = Math.round((h - whole) * 60);
  return m === 0 ? `${whole}h` : `${whole}h ${m}m`;
}

const EVENT_TYPE_LABEL: Record<SessionEvent['type'], string> = {
  focus: 'Focus',
  progress: 'Progress',
  blocker: 'Blocker',
  decision: 'Decision',
  note: 'Note',
};

/**
 * Light cleanup for legacy session_log bodies that were written as one
 * dense paragraph. Mirrors the same logic the Focus UI applies in
 * `prepEventBody` (src/components/Dashboard.tsx) — keep them in sync.
 * Modern writers should produce markdown directly; this helps the old
 * stuff render well in any markdown viewer.
 */
function prepBodyForMarkdown(text: string): string {
  if (text.length < 160) return text;
  if (/(\n\n)|(^[\-*] )|(^#{1,6} )|(^```)|(\n[\-*] )/m.test(text)) return text;
  // Sentence-end punctuation + space + (uppercase letter OR open-paren
  // OR backtick code span) — break into its own line.
  let out = text.replace(/([.!?])\s+(?=[A-Z(`])/g, '$1\n');
  // Colon or semicolon followed by `(N) ` is a "intro: list" pattern —
  // break too.
  out = out.replace(/([:;])\s+(?=\(\d+\)\s)/g, '$1\n');
  // Numbered items at line start → markdown ordered-list items.
  let inList = false;
  out = out
    .split('\n')
    .map(line => {
      const m = line.match(/^\((\d+)\)\s+(.*)$/);
      if (m) {
        const [, num, rest] = m;
        const prefix = inList ? '' : '\n';
        inList = true;
        return `${prefix}${num}. ${rest}`;
      }
      inList = false;
      return line;
    })
    .join('\n');
  return out;
}

function renderSittingMarkdown(session: Session, events: SessionEvent[]): string {
  const opened = fmtISODateTime(session.startedAt);
  const closed = session.endedAt ? fmtISODateTime(session.endedAt) : 'still open';
  const summary = session.summary ? `\n\n_Summary:_ ${session.summary}` : '';
  const eventLines = events
    .map(e => {
      const label = EVENT_TYPE_LABEL[e.type] ?? e.type;
      return `### ${fmtClock(e.createdAt)} · ${label}\n\n${prepBodyForMarkdown(e.text)}`;
    })
    .join('\n\n');
  return `## Sitting — ${opened} → ${closed}${summary}${eventLines ? '\n\n' + eventLines : ''}`;
}

interface TaskContext {
  id: number;
  title: string;
  type: string;
  state: string;
  url?: string;
  parent?: {
    id: number;
    title: string;
    type: string;
  };
  originalEstimate: number | null;
  remainingWork: number | null;
  completedWork: number | null;
  sprintName: string;
}

/**
 * Pull task + sprint context for a workItemId out of the current dashboard
 * payload. Returns null when the work item isn't in the current sprint (e.g.
 * a past-sprint task) — we don't mirror those for now.
 */
async function loadTaskContext(workItemId: number): Promise<TaskContext | null> {
  const { payload } = await buildDashboardCached();
  if (!payload.sprint) return null;
  const all = [
    ...payload.workItems.inProgress,
    ...payload.workItems.upNext,
    ...payload.workItems.done,
  ];
  const w = all.find(x => Number(x.id) === workItemId);
  if (!w) return null;
  return {
    id: Number(w.id),
    title: w.title,
    type: w.type,
    state: w.state,
    url: w.url,
    parent: w.parent
      ? {
          id: Number(w.parent.id),
          title: w.parent.title,
          type: w.parent.type,
        }
      : undefined,
    originalEstimate: w.originalEstimate ?? null,
    remainingWork: w.remainingWork ?? null,
    completedWork: w.completedWork ?? null,
    sprintName: payload.sprint.name,
  };
}

function renderTaskMarkdown(
  ctx: TaskContext,
  sessions: Session[],
  eventsBySession: Map<string, SessionEvent[]>,
): string {
  const lines: string[] = [];
  lines.push(`# ${ctx.title}`);
  lines.push('');
  const idLine = ctx.url
    ? `**Task:** [#${ctx.id}](${ctx.url})  `
    : `**Task:** #${ctx.id}  `;
  lines.push(idLine);
  if (ctx.parent) {
    lines.push(`**Story:** ${ctx.parent.title} (#${ctx.parent.id})  `);
  }
  lines.push(`**Sprint:** ${ctx.sprintName}  `);
  lines.push(`**State:** ${ctx.state}  `);
  const eff: string[] = [];
  if (ctx.originalEstimate != null) eff.push(`Estimate ${fmtHours(ctx.originalEstimate)}`);
  if (ctx.completedWork != null) eff.push(`Logged ${fmtHours(ctx.completedWork)}`);
  if (ctx.remainingWork != null) eff.push(`Remaining ${fmtHours(ctx.remainingWork)}`);
  if (eff.length) lines.push(`**Effort:** ${eff.join(' · ')}  `);
  lines.push('');

  if (sessions.length === 0) {
    lines.push('_No sittings recorded yet._');
  } else {
    for (const s of sessions) {
      const events = eventsBySession.get(s.id) ?? [];
      lines.push(renderSittingMarkdown(s, events));
      lines.push('');
    }
  }

  return lines.join('\n') + '\n';
}

/**
 * Rewrite the markdown file for a single task. Safe to call on every
 * session_start / session_log / session_end — the file is regenerated
 * in full each time.
 *
 * Failures are swallowed: archive writes must NEVER break the MCP tool
 * call that triggered them. The DB is the source of truth; a missing
 * file just means the next event call will rewrite it.
 */
export async function mirrorTaskFile(workItemId: number): Promise<{
  ok: boolean;
  path?: string;
  reason?: string;
}> {
  try {
    const ctx = await loadTaskContext(workItemId);
    if (!ctx) {
      return { ok: false, reason: `Task #${workItemId} not in current sprint` };
    }
    const sessions = listSessionsForWorkItem(workItemId);
    const eventsBySession = new Map<string, SessionEvent[]>();
    for (const s of sessions) {
      eventsBySession.set(s.id, listEventsForSession(s.id));
    }
    const md = renderTaskMarkdown(ctx, sessions, eventsBySession);
    const sprintDir = join(ARCHIVE_ROOT, safeFilename(ctx.sprintName));
    const fileName = `${safeFilename(ctx.title)} (#${ctx.id}).md`;
    const filePath = join(sprintDir, fileName);
    await writeAtomic(filePath, md);
    return { ok: true, path: filePath };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Rewrite the per-sprint summary.md. Pulls the current dashboard payload
 * and renders a calm overview: capacity verdict, story rollup, hours
 * planned vs logged vs remaining. Triggered at session_end so it
 * refreshes as work lands; safe to call more often.
 */
export async function mirrorSprintSummary(): Promise<{
  ok: boolean;
  path?: string;
  reason?: string;
}> {
  try {
    const { payload } = await buildDashboardCached();
    if (!payload.sprint) return { ok: false, reason: 'No current sprint' };
    const sprint = payload.sprint;
    const sprintDir = join(ARCHIVE_ROOT, safeFilename(sprint.name));

    const lines: string[] = [];
    lines.push(`# Sprint ${sprint.name}`);
    lines.push('');
    lines.push(`**Window:** ${fmtISODate(sprint.startDate)} → ${fmtISODate(sprint.finishDate)}  `);
    if (payload.outlookCapacity && payload.outlookCapacity.hasUrl && !payload.outlookCapacity.fetchError) {
      const c = payload.outlookCapacity;
      const planned = Math.round(c.plannedHours);
      const desk = Math.round(c.realDeskHours);
      const diff = Math.round(c.difference);
      let verdict: string;
      if (diff >= 8) verdict = `roughly ${diff}h over what fits`;
      else if (diff <= -8) verdict = `about ${Math.abs(diff)}h of room left`;
      else verdict = 'close to balanced';
      lines.push(`**Capacity:** ${planned}h planned · ${desk}h real desk · ${verdict}  `);
    }
    const totals = payload.capacity;
    lines.push(
      `**Hours:** ${Math.round(totals.totalEstimateHours)}h estimated · ${Math.round(totals.completedHours)}h logged · ${Math.round(totals.remainingHours)}h remaining  `,
    );
    lines.push('');

    lines.push('## Stories');
    lines.push('');
    if (payload.userStories.length === 0) {
      lines.push('_No stories in this sprint yet._');
    } else {
      for (const g of payload.userStories) {
        const counts = g.counts;
        const total = counts.inProgress + counts.upNext + counts.done;
        const countNote =
          total === 0
            ? ''
            : ` — ${counts.done}/${total} tasks done${counts.inProgress ? `, ${counts.inProgress} going` : ''}${counts.upNext ? `, ${counts.upNext} waiting` : ''}`;
        lines.push(`- **${g.title}** (#${g.id}) · ${g.state}${countNote}`);
      }
    }
    lines.push('');

    const filePath = join(sprintDir, 'summary.md');
    await writeAtomic(filePath, lines.join('\n') + '\n');
    return { ok: true, path: filePath };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Append-friendly daily-standup snapshot. Writes
 * `~/sprint-helper/sprints/<sprint>/standups/<today>.md` so Moran can
 * scroll back through what he said at standup over the sprint. Always
 * rewritten in full from the same data the dashboard's StandupCard
 * shows; safe to call as often as you like.
 */
export async function mirrorStandupForToday(): Promise<{
  ok: boolean;
  path?: string;
  reason?: string;
}> {
  try {
    const { payload } = await buildDashboardCached();
    if (!payload.sprint) return { ok: false, reason: 'No current sprint' };
    const { standup } = payload;
    const sprintDir = join(ARCHIVE_ROOT, safeFilename(payload.sprint.name), 'standups');
    const filePath = join(sprintDir, `${standup.todayDate}.md`);

    const lines: string[] = [];
    lines.push(`# Standup — ${standup.todayDate}`);
    lines.push('');
    lines.push(`Sprint **${payload.sprint.name}**.`);
    lines.push('');

    lines.push(`## Yesterday — ${standup.yesterdayDate}`);
    lines.push('');
    if (standup.yesterday.length === 0) {
      lines.push('_Nothing logged._');
    } else {
      for (const e of standup.yesterday) {
        // Session-open duration is a poor proxy for work time (overnight
        // sessions inflate it). Skip it; the summary captures what got done.
        lines.push(`- ${e.displayName}`);
        if (e.parentStoryTitle) lines.push(`  - Under: _${e.parentStoryTitle}_`);
        if (e.summary) lines.push(`  - ${e.summary}`);
      }
    }
    lines.push('');

    lines.push(`## Today — ${standup.todayDate}`);
    lines.push('');
    if (standup.today.length === 0) {
      lines.push('_No session yet._');
    } else {
      for (const e of standup.today) {
        const tag = e.state === 'live' ? ' _(live)_' : '';
        lines.push(`- ${e.displayName}${tag}`);
        if (e.parentStoryTitle) lines.push(`  - Under: _${e.parentStoryTitle}_`);
        if (e.summary) lines.push(`  - ${e.summary}`);
      }
    }
    lines.push('');

    await writeAtomic(filePath, lines.join('\n') + '\n');
    return { ok: true, path: filePath };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
}

export const ARCHIVE_PATHS = { root: ARCHIVE_ROOT };
