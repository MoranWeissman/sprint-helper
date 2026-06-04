/**
 * Standup builder (R9). Pulls yesterday's and today's session activity
 * into the shape Moran reads aloud to the delivery manager: a short
 * "what I did" + "what I'm doing" block, optimized for glancing and
 * speaking. No new ADO calls — works from the sessions DB only, joined
 * to titles already in the dashboard payload.
 *
 * Surfaced only in the Daily view (per Moran 2026-06-03 — he doesn't
 * want this card in front of him during deep work).
 */
import { getDb } from './db';

export interface StandupEntry {
  workItemId: number;
  /** Pre-formatted `**title** (#id)` ready to echo. */
  displayName: string;
  /** Parent story title (no id), for at-a-glance context. */
  parentStoryTitle: string | null;
  /** First-sentence summary of the latest progress event in window. Null when there are no progress events. */
  summary: string | null;
  /**
   * Total minutes the session(s) for this task were open within the window.
   * Pulled from session start/end timestamps, capped at window duration to
   * avoid counting ghost-time. Null when the session is still live.
   */
  minutesInWindow: number | null;
  /** State for visual cue. */
  state: 'live' | 'paused' | 'closed';
}

export interface StandupBlock {
  /** ISO date of "yesterday" used for the lookup (most-recent prior calendar day). */
  yesterdayDate: string;
  /** ISO date of "today" used for the lookup. */
  todayDate: string;
  yesterday: StandupEntry[];
  today: StandupEntry[];
}

const MS_PER_MIN = 60 * 1000;

interface SessionRow {
  id: string;
  work_item_id: number;
  started_at: string;
  ended_at: string | null;
}

interface ProgressEventRow {
  work_item_id: number;
  text: string;
  created_at: string;
}

/** First sentence of a progress text, truncated to ~110 chars. */
function firstSentence(text: string): string {
  const trimmed = text.trim();
  const m = trimmed.match(/^[^.!?]+[.!?]/);
  const s = (m ? m[0] : trimmed).trim();
  return s.length > 110 ? s.slice(0, 107).trimEnd() + '…' : s;
}

function startOfLocalDay(d: Date): Date {
  const out = new Date(d);
  out.setHours(0, 0, 0, 0);
  return out;
}

function isoDate(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function sessionsTouchingWindow(startISO: string, endISO: string): SessionRow[] {
  // Any session whose [started_at, ended_at-or-now] interval overlaps the
  // window. Open sessions (ended_at IS NULL) count as ending "now".
  return getDb()
    .prepare<[string, string], SessionRow>(
      `SELECT id, work_item_id, started_at, ended_at
         FROM sessions
        WHERE datetime(started_at) < datetime(?)
          AND datetime(COALESCE(ended_at, ?)) >= datetime(?)
        ORDER BY datetime(started_at) ASC`,
    )
    .all(endISO, endISO, startISO);
}

function latestProgressByItem(
  workItemIds: number[],
  startISO: string,
  endISO: string,
): Map<number, ProgressEventRow> {
  if (workItemIds.length === 0) return new Map();
  const placeholders = workItemIds.map(() => '?').join(',');
  const rows = getDb()
    .prepare<(number | string)[], ProgressEventRow>(
      `SELECT work_item_id, text, created_at
         FROM session_events
        WHERE type = 'progress'
          AND work_item_id IN (${placeholders})
          AND datetime(created_at) >= datetime(?)
          AND datetime(created_at) < datetime(?)
        ORDER BY work_item_id ASC, datetime(created_at) DESC`,
    )
    .all(...workItemIds, startISO, endISO);
  const out = new Map<number, ProgressEventRow>();
  for (const r of rows) {
    if (!out.has(r.work_item_id)) out.set(r.work_item_id, r);
  }
  return out;
}

function clampMs(value: number, max: number): number {
  return Math.max(0, Math.min(value, max));
}

function minutesInWindow(sessions: SessionRow[], startISO: string, endISO: string, nowMs: number): number {
  const winStart = Date.parse(startISO);
  const winEnd = Date.parse(endISO);
  let total = 0;
  for (const s of sessions) {
    const sStart = Date.parse(s.started_at);
    const sEnd = s.ended_at ? Date.parse(s.ended_at) : nowMs;
    const overlap = clampMs(Math.min(sEnd, winEnd) - Math.max(sStart, winStart), winEnd - winStart);
    total += overlap;
  }
  return Math.round(total / MS_PER_MIN);
}

interface BuildOpts {
  /**
   * Used to look up the title, parent story, and work-item type for each id.
   * Type lets the standup skip Feature/Epic entries — sessions on those are
   * always a data mistake (sessions belong on Tasks, occasionally Stories),
   * and Moran doesn't want them appearing in his Yesterday/Today read.
   */
  taskMeta: Map<number, { title: string; parentTitle: string | null; type: string }>;
  /** Override "now" for tests; defaults to the current clock. */
  now?: Date;
}

const STANDUP_SKIP_TYPES = new Set(['feature', 'epic']);

function entriesForWindow(
  startISO: string,
  endISO: string,
  opts: BuildOpts,
  nowMs: number,
): StandupEntry[] {
  const sessions = sessionsTouchingWindow(startISO, endISO);
  if (sessions.length === 0) return [];

  // Bucket sessions per work item.
  const byItem = new Map<number, SessionRow[]>();
  for (const s of sessions) {
    const arr = byItem.get(s.work_item_id) ?? [];
    arr.push(s);
    byItem.set(s.work_item_id, arr);
  }

  const progressByItem = latestProgressByItem(Array.from(byItem.keys()), startISO, endISO);

  const entries: StandupEntry[] = [];
  for (const [workItemId, rows] of byItem) {
    const meta = opts.taskMeta.get(workItemId);
    if (meta && STANDUP_SKIP_TYPES.has(meta.type.toLowerCase())) continue;
    const title = meta?.title ?? `#${workItemId}`;
    // Only Tasks carry a meaningful parent line — the parent of a Task is a
    // Story (the context Moran is talking about). A Story's parent is a
    // Feature, a Bug's parent is usually a Feature too — neither belongs on
    // the standup card, per his 2026-06-04 read.
    const parentStoryTitle =
      meta && meta.type.toLowerCase() === 'task' ? (meta.parentTitle ?? null) : null;

    const hasOpen = rows.some(r => r.ended_at == null);
    const allClosed = rows.every(r => r.ended_at != null);
    const state: StandupEntry['state'] = hasOpen ? 'live' : allClosed ? 'closed' : 'paused';

    const minutes = hasOpen ? null : minutesInWindow(rows, startISO, endISO, nowMs);
    const progressEvent = progressByItem.get(workItemId);
    const summary = progressEvent ? firstSentence(progressEvent.text) : null;

    entries.push({
      workItemId,
      displayName: `**${title}** (#${workItemId})`,
      parentStoryTitle,
      summary,
      minutesInWindow: minutes,
      state,
    });
  }

  // Live items first, then by most-recent session start (newest last touched).
  entries.sort((a, b) => {
    if (a.state === 'live' && b.state !== 'live') return -1;
    if (b.state === 'live' && a.state !== 'live') return 1;
    return 0;
  });

  return entries;
}

export function buildStandup(opts: BuildOpts): StandupBlock {
  const now = opts.now ?? new Date();
  const todayStart = startOfLocalDay(now);
  const tomorrowStart = new Date(todayStart);
  tomorrowStart.setDate(tomorrowStart.getDate() + 1);
  const yesterdayStart = new Date(todayStart);
  yesterdayStart.setDate(yesterdayStart.getDate() - 1);

  const yesterdayISO = todayStart.toISOString();
  const yesterday = entriesForWindow(
    yesterdayStart.toISOString(),
    yesterdayISO,
    opts,
    now.getTime(),
  );
  const today = entriesForWindow(
    todayStart.toISOString(),
    tomorrowStart.toISOString(),
    opts,
    now.getTime(),
  );

  return {
    yesterdayDate: isoDate(yesterdayStart),
    todayDate: isoDate(todayStart),
    yesterday,
    today,
  };
}
