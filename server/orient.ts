/**
 * Orientation packet (slice R4).
 *
 * Composes a single high-signal read of "where Moran left off and what's
 * waiting" — surfaced to Claude Code on the first tool call of a session via
 * the MCP `orient` tool. The shape is tight on purpose: the assistant should
 * compose a brief plain-English greeting from this, not dump the whole sprint.
 *
 * Pulls from existing sources only — no new ADO calls beyond the cached
 * dashboard fetch.
 */
import { buildDashboardCached } from './dashboard-cache';
import { getDb } from './db';
import { getHelperNotes } from './helper-notes';
import { listActiveSessions, type SessionRow } from './sessions';

export interface OrientLiveSession {
  workItemId: number;
  title: string;
  startedAt: string;
  minutesOpen: number;
}

export interface OrientLastSession {
  workItemId: number;
  title: string;
  endedAt: string;
  summary: string | null;
  minutesAgo: number;
}

export interface OrientNudge {
  id: number;
  body: string;
  createdAt: string;
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
  lastSession: OrientLastSession | null;
  helperNotes: {
    summary: string | null;
    summaryAt: string | null;
    openNudges: OrientNudge[];
  };
  gaps: {
    storiesMissingPlanning: number;
    tasksMissingEstimate: number;
  };
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
  const now = new Date();

  const titleById = new Map<number, string>();
  for (const list of [payload.workItems.inProgress, payload.workItems.upNext, payload.workItems.done]) {
    for (const w of list) titleById.set(Number(w.id), w.title);
  }
  for (const g of payload.userStories) {
    titleById.set(Number(g.id), g.title);
  }

  const liveNow: OrientLiveSession[] = listActiveSessions().map(s => ({
    workItemId: s.workItemId,
    title: titleById.get(s.workItemId) ?? `#${s.workItemId}`,
    startedAt: s.startedAt,
    minutesOpen: minutesSince(s.startedAt, now),
  }));

  const lastRow = getLastEndedSession();
  const lastSession: OrientLastSession | null = lastRow
    ? {
        workItemId: lastRow.work_item_id,
        title: titleById.get(lastRow.work_item_id) ?? `#${lastRow.work_item_id}`,
        endedAt: lastRow.ended_at as string,
        summary: lastRow.summary,
        minutesAgo: minutesSince(lastRow.ended_at as string, now),
      }
    : null;

  const helperNotes = payload.helperNotes ?? getHelperNotes();

  let storiesMissingPlanning = 0;
  for (const g of payload.userStories) {
    if (g.storyPoints == null || g.effort == null) storiesMissingPlanning++;
  }
  let tasksMissingEstimate = 0;
  for (const w of [...payload.workItems.inProgress, ...payload.workItems.upNext]) {
    if (w.originalEstimate == null) tasksMissingEstimate++;
  }

  return {
    greeting: greetingFor(now),
    fetchedAt: now.toISOString(),
    sprint: {
      name: payload.sprint.name,
      ...sprintProgress(payload.sprint.startDate, payload.sprint.finishDate, now),
      startDate: payload.sprint.startDate,
      finishDate: payload.sprint.finishDate,
    },
    liveNow,
    lastSession,
    helperNotes: {
      summary: helperNotes.summary,
      summaryAt: helperNotes.summaryAt,
      openNudges: helperNotes.notes.map(n => ({ id: n.id, body: n.body, createdAt: n.createdAt })),
    },
    gaps: {
      storiesMissingPlanning,
      tasksMissingEstimate,
    },
  };
}
