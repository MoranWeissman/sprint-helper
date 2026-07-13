/**
 * Orientation packet (slice R4).
 *
 * Builds a short "where Moran left off and what's waiting" read for the start
 * of every Claude Code session. The MCP `orient` tool returns this; the
 * assistant uses it to write a friendly 2-4 sentence greeting (time of day,
 * last task, day of sprint, any open helper notes) — not to dump the data.
 *
 * Reads from sources already in memory or local SQLite, plus the cached
 * Azure DevOps fetch. No new network calls.
 */
import type { Capacity } from './capacity';
import { buildDashboardCached } from './dashboard-cache';
import { getDb } from './db';
import { ensureCapacityNudge, getHelperNotes, scanStaleRemaining } from './helper-notes';
import { getPlanningHome } from './planning-home';
import { STALE_IDLE_MINUTES } from './session-activity';
import {
  chatCwdBasename,
  getLastEventTimestampMap,
  listActiveSessions,
  sessionOwnershipHint,
  type SessionRow,
} from './sessions';

export interface OrientLiveSession {
  /**
   * The sessions-table id. REQUIRED for `session_end` / `session_log` calls
   * — without this, a session that came back into view after an MCP
   * reconnect would have no way to be stopped from this chat. See the
   * STALE LIVE SESSION block in SERVER_INSTRUCTIONS.
   */
  sessionId: string;
  workItemId: number;
  title: string;
  /** Pre-formatted `**title** (#id)` ready to echo verbatim. */
  displayName: string;
  startedAt: string;
  minutesOpen: number;
  /**
   * Minutes since the most recent `session_log` event against this session,
   * or `minutesOpen` if no events have been logged yet. R7c uses this to
   * surface sessions that may have been left open by accident.
   */
  idleMinutes: number;
  /**
   * `true` when `idleMinutes` crosses {@link STALE_IDLE_MINUTES}. The
   * assistant should gently ask Moran whether the session is still going or
   * should be closed. Never act on this without confirming.
   */
  mayBeStale: boolean;
  /**
   * Id of the parent story (or feature) the live task hangs under, if any.
   * R7d uses this so the assistant can compare against `story_match.topMatch`
   * and ask once if the chat's cwd seems to be on a different story now.
   */
  parentStoryId: number | null;
  /**
   * Pre-formatted `**title** (#id)` for the parent story; null when the task
   * has no parent. Echo verbatim — don't assemble.
   */
  parentStoryDisplayName: string | null;
  /** Repo folder the session's chat was started in; null on older sessions. */
  cwd: string | null;
  /**
   * Pre-shipped plain-English read on whose session this is, compared against
   * THIS chat's repo. Echo verbatim — don't assemble your own phrasing. See
   * SERVER_INSTRUCTIONS → PARALLEL CHATS.
   */
  repoHint: string;
}

export interface OrientPlanningHome {
  /** Absolute path Moran has configured (or the default). */
  configuredPath: string;
  /** True if Moran explicitly set the path; false if it's the default. */
  isExplicitlyConfigured: boolean;
}

export interface OrientLastSession {
  workItemId: number;
  title: string;
  /** Pre-formatted `**title** (#id)` ready to echo verbatim. */
  displayName: string;
  endedAt: string;
  summary: string | null;
  minutesAgo: number;
}

export interface OrientPacket {
  greeting: string;
  fetchedAt: string;
  sprint: {
    name: string;
    dayOfSprint: number;
    totalDays: number;
    daysRemaining: number;
    startDate: string;
    finishDate: string;
  };
  liveNow: OrientLiveSession[];
  /**
   * One-line plain-English nudge to open a session, set ONLY when no session
   * is open (liveNow is empty). Null when a session is already open. The
   * assistant surfaces this in its greeting. See SERVER_INSTRUCTIONS →
   * OPENING GREETING.
   */
  sessionReminder: string | null;
  lastSession: OrientLastSession | null;
  helperNotes: {
    /**
     * Number of un-dismissed helper notes. Bodies are NOT included in this
     * packet — call `helper_notes_get` to fetch them on demand. Keeping
     * bodies out of the greeting prevents pasting them verbatim.
     */
    openNudgeCount: number;
  };
  gaps: {
    storiesMissingPlanning: number;
    tasksMissingEstimate: number;
  };
  /**
   * Hours-available-after-meetings vs planned hours for the sprint (from
   * Outlook). Null when the dashboard couldn't compute it.
   */
  capacity: Capacity | null;
  /**
   * Pre-formatted plain-English sentence about capacity. Null when no
   * calendar is wired up. Echo verbatim in the greeting instead of
   * computing your own phrasing from `capacity` — that's where the
   * banned word "slack" used to slip in.
   */
  capacitySummary: string | null;
  /**
   * Where Moran's sprint-helper planning home folder lives. The model
   * compares this against the chat's cwd: when they match (or a
   * `.sprint-helper-home` marker file is in the cwd), the model skips the
   * story-anchor ritual and runs sprint-wide skills. See SERVER_INSTRUCTIONS
   * → PLANNING HOME.
   */
  planningHome: OrientPlanningHome;
}

function displayNameFor(workItemId: number, title: string): string {
  return `**${title}** (#${workItemId})`;
}

function plainCapacitySummary(c: Capacity | null): string | null {
  if (!c) return null;
  if (!c.hasUrl) return null;
  if (c.fetchError) return null;
  const planned = Math.round(c.plannedHours);
  const available = Math.round(c.availableHours);
  const diff = Math.round(c.difference);
  if (diff >= 8) {
    return `You've planned about ${planned} hours of work this sprint and your calendar leaves about ${available} hours available after meetings, so you're roughly ${diff} hours over what fits.`;
  }
  if (diff <= -8) {
    return `You've planned about ${planned} hours of work this sprint and your calendar leaves about ${available} hours available after meetings, so there's about ${Math.abs(diff)} hours of room left if you want to pull something in.`;
  }
  return `You've planned about ${planned} hours of work this sprint and your calendar leaves about ${available} hours available after meetings — close to balanced.`;
}

/**
 * One-line nudge for the assistant when NO work session is open. Naming
 * `session_start` here is also what prompts the assistant to reach for that
 * (possibly deferred) tool. Returns null when a session is already open —
 * don't nag. See SERVER_INSTRUCTIONS → OPENING GREETING.
 */
export function sessionReminderFor(liveSessionCount: number): string | null {
  if (liveSessionCount > 0) return null;
  return "You don't have a work session open. When you start working a task, call session_start on it so your progress gets recorded.";
}

/**
 * Plain-English label for a live session's home repo, from this chat's point
 * of view. 'unknown' sides never warn and never claim a match.
 */
export function repoHintFor(sessionCwd: string | null, chatCwd: string | null): string {
  const ownership = sessionOwnershipHint(sessionCwd, chatCwd);
  if (ownership === 'mine') return `started from \`${sessionCwd}\` — matches this chat`;
  if (ownership === 'other-repo') return `started from \`${sessionCwd}\` — a different chat's work`;
  return sessionCwd ? `started from \`${sessionCwd}\`` : 'repo unknown (older session)';
}

const MS_PER_DAY = 1000 * 60 * 60 * 24;
const MS_PER_MIN = 1000 * 60;

function greetingFor(d: Date): string {
  const h = d.getHours();
  if (h < 5) return 'Hey, still up';
  if (h < 12) return 'Good morning';
  if (h < 14) return 'Around noon';
  if (h < 18) return 'Good afternoon';
  return 'Good evening';
}

function sprintProgress(
  startISO: string,
  finishISO: string,
  now: Date,
): { dayOfSprint: number; totalDays: number; daysRemaining: number } {
  const start = new Date(startISO);
  const finish = new Date(finishISO);
  const totalDays = Math.max(1, Math.round((finish.getTime() - start.getTime()) / MS_PER_DAY) + 1);
  const raw = Math.floor((now.getTime() - start.getTime()) / MS_PER_DAY) + 1;
  const dayOfSprint = Math.max(1, Math.min(totalDays, raw));
  const daysRemaining = Math.max(0, totalDays - dayOfSprint);
  return { dayOfSprint, totalDays, daysRemaining };
}

function minutesSince(iso: string, now: Date): number {
  return Math.max(0, Math.floor((now.getTime() - new Date(iso).getTime()) / MS_PER_MIN));
}

function getLastEndedSession(): SessionRow | null {
  return (
    getDb()
      .prepare<[], SessionRow>(
        `SELECT * FROM sessions
         WHERE ended_at IS NOT NULL
         ORDER BY datetime(ended_at) DESC, id DESC
         LIMIT 1`,
      )
      .get() ?? null
  );
}

export async function buildOrientPacket(): Promise<OrientPacket> {
  const { payload } = await buildDashboardCached();
  if (!payload.sprint) {
    throw new Error('No current sprint — set a sprint first.');
  }
  const sprint = payload.sprint;
  const now = new Date();

  const titleById = new Map<number, string>();
  const parentByTaskId = new Map<number, { id: number; title: string }>();
  for (const list of [payload.workItems.inProgress, payload.workItems.upNext, payload.workItems.done]) {
    for (const w of list) {
      titleById.set(Number(w.id), w.title);
      if (w.parent) {
        parentByTaskId.set(Number(w.id), {
          id: Number(w.parent.id),
          title: w.parent.title,
        });
      }
    }
  }
  for (const g of payload.userStories) {
    titleById.set(Number(g.id), g.title);
  }

  const activeSessions = listActiveSessions();
  const lastEventBySession = getLastEventTimestampMap(activeSessions.map(s => s.id));
  const chatCwd = chatCwdBasename();
  const liveNow: OrientLiveSession[] = activeSessions.map(s => {
    const title = titleById.get(s.workItemId) ?? `#${s.workItemId}`;
    const lastActivity = lastEventBySession.get(s.id) ?? s.startedAt;
    const idleMinutes = minutesSince(lastActivity, now);
    const parent = parentByTaskId.get(s.workItemId) ?? null;
    return {
      sessionId: s.id,
      workItemId: s.workItemId,
      title,
      displayName: displayNameFor(s.workItemId, title),
      startedAt: s.startedAt,
      minutesOpen: minutesSince(s.startedAt, now),
      idleMinutes,
      mayBeStale: idleMinutes >= STALE_IDLE_MINUTES,
      parentStoryId: parent?.id ?? null,
      parentStoryDisplayName: parent ? displayNameFor(parent.id, parent.title) : null,
      cwd: s.cwd,
      repoHint: repoHintFor(s.cwd, chatCwd),
    };
  });

  const lastRow = getLastEndedSession();
  const lastSession: OrientLastSession | null = lastRow
    ? (() => {
        const title = titleById.get(lastRow.work_item_id) ?? `#${lastRow.work_item_id}`;
        return {
          workItemId: lastRow.work_item_id,
          title,
          displayName: displayNameFor(lastRow.work_item_id, title),
          endedAt: lastRow.ended_at as string,
          summary: lastRow.summary,
          minutesAgo: minutesSince(lastRow.ended_at as string, now),
        };
      })()
    : null;

  let storiesMissingPlanning = 0;
  for (const g of payload.userStories) {
    if (g.storyPoints == null || g.effort == null) storiesMissingPlanning++;
  }
  let tasksMissingEstimate = 0;
  for (const w of [...payload.workItems.inProgress, ...payload.workItems.upNext]) {
    if (w.originalEstimate == null) tasksMissingEstimate++;
  }

  // Surface capacity from the dashboard payload; fire a once-per-sprint nudge
  // if the gap is big and we actually have calendar data to back it.
  const capacity = payload.outlookCapacity;
  if (capacity && capacity.hasUrl && !capacity.fetchError) {
    ensureCapacityNudge({
      sprintName: sprint.name,
      difference: capacity.difference,
      availableHours: capacity.availableHours,
      plannedHours: capacity.plannedHours,
    });
  }

  // Stale-Remaining scan: tasks in 'going' state with no session activity in
  // 2+ days get a helper note naming the task. Deduped per task per sprint.
  const staleCandidates = payload.workItems.inProgress
    .filter(w => w.type.toLowerCase() === 'task')
    .map(w => ({
      workItemId: Number(w.id),
      title: w.title,
      remainingWork: w.remainingWork ?? null,
    }));
  scanStaleRemaining({ sprintName: sprint.name, candidates: staleCandidates });

  // Read helper notes AFTER the nudge, so a just-added capacity nudge shows
  // up in this same orient response. (Cached payload.helperNotes would miss it.)
  const helperNotes = getHelperNotes();

  const planningHome = getPlanningHome();

  return {
    greeting: greetingFor(now),
    fetchedAt: now.toISOString(),
    sprint: {
      name: sprint.name,
      ...sprintProgress(sprint.startDate, sprint.finishDate, now),
      startDate: sprint.startDate,
      finishDate: sprint.finishDate,
    },
    liveNow,
    sessionReminder: sessionReminderFor(liveNow.length),
    lastSession,
    helperNotes: {
      openNudgeCount: helperNotes.notes.length,
    },
    gaps: {
      storiesMissingPlanning,
      tasksMissingEstimate,
    },
    capacity,
    capacitySummary: plainCapacitySummary(capacity),
    planningHome: {
      configuredPath: planningHome.configuredPath,
      isExplicitlyConfigured: planningHome.isExplicitlyConfigured,
    },
  };
}
