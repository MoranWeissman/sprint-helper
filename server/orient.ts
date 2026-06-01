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
import { ensureCapacityNudge, getHelperNotes } from './helper-notes';
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
  /**
   * Real desk time vs planned hours for the sprint (from Outlook). Null when
   * the dashboard couldn't compute it. The opening greeting should mention
   * capacity only when there's a meaningful gap and `hasUrl` is true.
   */
  capacity: Capacity | null;
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
      realDeskHours: capacity.realDeskHours,
      plannedHours: capacity.plannedHours,
    });
  }

  // Read helper notes AFTER the nudge, so a just-added capacity nudge shows
  // up in this same orient response. (Cached payload.helperNotes would miss it.)
  const helperNotes = getHelperNotes();

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
    capacity,
  };
}
