/**
 * Claude Code session tracking. Each session is a stretch of work Claude Code
 * reports via the MCP plugin: started against a work item, accumulating events
 * (focus changes, summaries, blockers, decisions), closed when Moran finishes.
 *
 * This is the storage + read layer. The MCP server (slice 2.1b) wraps these.
 */
import { randomUUID } from 'node:crypto';
import { getDb } from './db';

export type SessionEventType = 'focus' | 'progress' | 'blocker' | 'decision' | 'note';

const EVENT_TYPES: SessionEventType[] = ['focus', 'progress', 'blocker', 'decision', 'note'];

export function isSessionEventType(v: unknown): v is SessionEventType {
  return typeof v === 'string' && (EVENT_TYPES as string[]).includes(v);
}

export interface SessionRow {
  id: string;
  work_item_id: number;
  started_at: string;
  ended_at: string | null;
  client: string;
  summary: string | null;
}

export interface SessionEventRow {
  id: number;
  session_id: string;
  work_item_id: number;
  type: SessionEventType;
  text: string;
  created_at: string;
}

export interface Session {
  id: string;
  workItemId: number;
  startedAt: string;
  endedAt: string | null;
  client: string;
  summary: string | null;
}

export interface SessionEvent {
  id: number;
  sessionId: string;
  workItemId: number;
  type: SessionEventType;
  text: string;
  createdAt: string;
}

function toSession(r: SessionRow): Session {
  return {
    id: r.id,
    workItemId: r.work_item_id,
    startedAt: r.started_at,
    endedAt: r.ended_at,
    client: r.client,
    summary: r.summary,
  };
}

function toEvent(r: SessionEventRow): SessionEvent {
  return {
    id: r.id,
    sessionId: r.session_id,
    workItemId: r.work_item_id,
    type: r.type,
    text: r.text,
    createdAt: r.created_at,
  };
}

/* ============================================================ */
/*  Mutations                                                    */
/* ============================================================ */

/**
 * Start a new session for a work item. If one is already active, returns it
 * unchanged (idempotent) — Claude Code can call this on every reconnect.
 */
export function startSession({
  workItemId,
  client = 'claude-code',
}: {
  workItemId: number;
  client?: string;
}): Session {
  const db = getDb();
  const existing = db
    .prepare<[number], SessionRow>(
      `SELECT * FROM sessions
       WHERE work_item_id = ? AND ended_at IS NULL
       ORDER BY started_at DESC LIMIT 1`,
    )
    .get(workItemId);
  if (existing) return toSession(existing);

  const id = randomUUID();
  const startedAt = new Date().toISOString();
  db.prepare(
    `INSERT INTO sessions (id, work_item_id, started_at, client)
     VALUES (?, ?, ?, ?)`,
  ).run(id, workItemId, startedAt, client);
  return {
    id,
    workItemId,
    startedAt,
    endedAt: null,
    client,
    summary: null,
  };
}

/**
 * End a session. Optionally records a final summary. No-op if the session is
 * already ended or doesn't exist.
 */
export function endSession({
  sessionId,
  summary,
}: {
  sessionId: string;
  summary?: string;
}): Session | null {
  const db = getDb();
  const row = db
    .prepare<[string], SessionRow>(`SELECT * FROM sessions WHERE id = ?`)
    .get(sessionId);
  if (!row || row.ended_at != null) return row ? toSession(row) : null;

  const endedAt = new Date().toISOString();
  db.prepare(`UPDATE sessions SET ended_at = ?, summary = ? WHERE id = ?`).run(
    endedAt,
    summary ?? row.summary,
    sessionId,
  );
  if (summary && summary.trim().length > 0) {
    logEvent({ sessionId, type: 'progress', text: summary });
  }
  return { ...toSession(row), endedAt, summary: summary ?? row.summary };
}

/**
 * Log an event against a session. `workItemId` is denormalized into the row so
 * we can query "recent activity for task X" without a join.
 *
 * If the event's `type` is "focus" and the text references a different work
 * item, callers should `startSession` against that item first — this function
 * trusts whatever it's given.
 */
export function logEvent({
  sessionId,
  type,
  text,
}: {
  sessionId: string;
  type: SessionEventType;
  text: string;
}): SessionEvent | null {
  const db = getDb();
  const session = db
    .prepare<[string], SessionRow>(`SELECT * FROM sessions WHERE id = ?`)
    .get(sessionId);
  if (!session) return null;

  const createdAt = new Date().toISOString();
  const info = db
    .prepare(
      `INSERT INTO session_events (session_id, work_item_id, type, text, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(sessionId, session.work_item_id, type, text, createdAt);
  return {
    id: Number(info.lastInsertRowid),
    sessionId,
    workItemId: session.work_item_id,
    type,
    text,
    createdAt,
  };
}

/* ============================================================ */
/*  Reads                                                        */
/* ============================================================ */

export function getActiveSession(workItemId: number): Session | null {
  const row = getDb()
    .prepare<[number], SessionRow>(
      `SELECT * FROM sessions
       WHERE work_item_id = ? AND ended_at IS NULL
       ORDER BY started_at DESC LIMIT 1`,
    )
    .get(workItemId);
  return row ? toSession(row) : null;
}

/** All currently-active sessions (one per work item, in practice). */
export function listActiveSessions(): Session[] {
  return getDb()
    .prepare<[], SessionRow>(
      `SELECT * FROM sessions WHERE ended_at IS NULL ORDER BY started_at DESC`,
    )
    .all()
    .map(toSession);
}

export function getRecentEvents(workItemId: number, limit = 10): SessionEvent[] {
  return getDb()
    .prepare<[number, number], SessionEventRow>(
      `SELECT * FROM session_events
       WHERE work_item_id = ?
       ORDER BY id DESC
       LIMIT ?`,
    )
    .all(workItemId, limit)
    .map(toEvent);
}

/**
 * Bulk variant for dashboard payloads. Returns a map keyed by workItemId,
 * each value the most recent `limit` events (newest first). Items with no
 * events are omitted from the map.
 */
export function getRecentEventsMap(
  workItemIds: number[],
  limit = 5,
): Map<number, SessionEvent[]> {
  const m = new Map<number, SessionEvent[]>();
  if (workItemIds.length === 0) return m;

  const placeholders = workItemIds.map(() => '?').join(',');
  const rows = getDb()
    .prepare<number[], SessionEventRow>(
      `SELECT * FROM session_events
       WHERE work_item_id IN (${placeholders})
       ORDER BY work_item_id ASC, id DESC`,
    )
    .all(...workItemIds);

  for (const r of rows) {
    const list = m.get(r.work_item_id);
    if (list) {
      if (list.length < limit) list.push(toEvent(r));
    } else {
      m.set(r.work_item_id, [toEvent(r)]);
    }
  }
  return m;
}

/**
 * For a list of session ids, return the timestamp of the most recent event
 * logged against each. Sessions with no events are omitted. Used by orient to
 * tell whether an open session has gone quiet for a long time (R7c).
 */
export function getLastEventTimestampMap(sessionIds: string[]): Map<string, string> {
  const m = new Map<string, string>();
  if (sessionIds.length === 0) return m;
  const placeholders = sessionIds.map(() => '?').join(',');
  const rows = getDb()
    .prepare<string[], { session_id: string; last_at: string }>(
      `SELECT session_id, MAX(created_at) AS last_at
       FROM session_events
       WHERE session_id IN (${placeholders})
       GROUP BY session_id`,
    )
    .all(...sessionIds);
  for (const r of rows) m.set(r.session_id, r.last_at);
  return m;
}

/** {workItemId → activeSession} map. Used by the dashboard payload. */
export function getActiveSessionMap(): Map<number, Session> {
  const m = new Map<number, Session>();
  for (const s of listActiveSessions()) m.set(s.workItemId, s);
  return m;
}

/**
 * {workItemId → number of sessions (open or closed)} for the given items.
 * Used by the dashboard to show a calm "N sittings" total. Items with no
 * sessions are omitted from the map.
 */
export function getSessionCountMap(workItemIds: number[]): Map<number, number> {
  const m = new Map<number, number>();
  if (workItemIds.length === 0) return m;
  const placeholders = workItemIds.map(() => '?').join(',');
  const rows = getDb()
    .prepare<number[], { work_item_id: number; n: number }>(
      `SELECT work_item_id, COUNT(*) AS n FROM sessions
       WHERE work_item_id IN (${placeholders})
       GROUP BY work_item_id`,
    )
    .all(...workItemIds);
  for (const r of rows) m.set(r.work_item_id, r.n);
  return m;
}
