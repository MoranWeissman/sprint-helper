/**
 * Timer operations against the local SQLite store.
 *
 * Multiple work items can be running at once (Moran works in parallel).
 * Each timer "session" is a row in time_entries; resuming a paused timer
 * creates a new row rather than mutating the old one.
 */
import { getDb } from './db';

export interface TimeEntryRow {
  id: number;
  work_item_id: number;
  started_at: string;
  ended_at: string | null;
  note: string | null;
  synced_to_ado: number;
}

export interface TimerSnapshot {
  workItemId: number;
  /** Currently-running entry, if any. */
  running: TimeEntryRow | null;
  /** Total elapsed seconds across ALL entries for this item (running + closed). */
  totalSeconds: number;
  /** Seconds tracked locally that haven't been pushed to ADO. */
  unsyncedSeconds: number;
}

/* ============================================================ */
/*  Mutations                                                    */
/* ============================================================ */

/**
 * Start a timer for a work item. Idempotent: if one is already running for
 * this item, returns the existing row unchanged.
 */
export function startTimer(workItemId: number): TimeEntryRow {
  const db = getDb();
  const existing = db
    .prepare<[number], TimeEntryRow>(
      `SELECT * FROM time_entries
       WHERE work_item_id = ? AND ended_at IS NULL
       ORDER BY id DESC LIMIT 1`,
    )
    .get(workItemId);
  if (existing) return existing;

  const startedAt = new Date().toISOString();
  const info = db
    .prepare(
      `INSERT INTO time_entries (work_item_id, started_at, ended_at)
       VALUES (?, ?, NULL)`,
    )
    .run(workItemId, startedAt);
  return db
    .prepare<[number], TimeEntryRow>(`SELECT * FROM time_entries WHERE id = ?`)
    .get(Number(info.lastInsertRowid))!;
}

/**
 * Pause the running timer for a work item. No-op if none is running.
 * Returns the closed row, or null if there was nothing to close.
 *
 * Also marks the closed entry as `synced_to_ado = 1`. This is the new
 * model after Moran caught the 211h-of-ghost-time bug 2026-06-02:
 * `localUncapturedSeconds` is only meaningful for currently-running
 * timers (i.e. live elapsed counters). Once a session ends, its time
 * should NOT keep contributing to capacity — by then the assistant has
 * called `remainingHoursAfter` to keep ADO's RemainingWork honest, and
 * `CompletedWork` is derived from the burndown (Estimate − Remaining).
 * Keeping closed-unsynced rows around just inflates the numbers forever.
 */
export function pauseTimer(workItemId: number): TimeEntryRow | null {
  const db = getDb();
  const running = db
    .prepare<[number], TimeEntryRow>(
      `SELECT * FROM time_entries
       WHERE work_item_id = ? AND ended_at IS NULL
       ORDER BY id DESC LIMIT 1`,
    )
    .get(workItemId);
  if (!running) return null;
  const endedAt = new Date().toISOString();
  db.prepare(`UPDATE time_entries SET ended_at = ?, synced_to_ado = 1 WHERE id = ?`).run(
    endedAt,
    running.id,
  );
  return { ...running, ended_at: endedAt, synced_to_ado: 1 };
}

/** Mark all CLOSED entries for an item as synced. Called after a successful push. */
export function markEntriesSynced(workItemId: number): void {
  getDb()
    .prepare(
      `UPDATE time_entries
       SET synced_to_ado = 1
       WHERE work_item_id = ? AND ended_at IS NOT NULL AND synced_to_ado = 0`,
    )
    .run(workItemId);
}

/* ============================================================ */
/*  Reads                                                        */
/* ============================================================ */

export function getTimerSnapshot(workItemId: number): TimerSnapshot {
  const db = getDb();
  const entries = db
    .prepare<[number], TimeEntryRow>(
      `SELECT * FROM time_entries WHERE work_item_id = ? ORDER BY id ASC`,
    )
    .all(workItemId);

  const now = Date.now();
  let totalSeconds = 0;
  let unsyncedSeconds = 0;
  let running: TimeEntryRow | null = null;

  for (const e of entries) {
    const start = new Date(e.started_at).getTime();
    const end = e.ended_at ? new Date(e.ended_at).getTime() : now;
    const sec = Math.max(0, Math.round((end - start) / 1000));
    totalSeconds += sec;
    if (e.synced_to_ado === 0) unsyncedSeconds += sec;
    if (e.ended_at == null) running = e;
  }
  return { workItemId, running, totalSeconds, unsyncedSeconds };
}

/** All currently-running timers. Used to render live elapsed counters. */
export function listActiveTimers(): Array<{ workItemId: number; startedAt: string }> {
  return getDb()
    .prepare<[], { work_item_id: number; started_at: string }>(
      `SELECT work_item_id, started_at FROM time_entries WHERE ended_at IS NULL`,
    )
    .all()
    .map(r => ({ workItemId: r.work_item_id, startedAt: r.started_at }));
}

/**
 * Local logged time per work item, as a {workItemId: seconds} map.
 * Includes both unsynced AND already-synced entries — this is total time
 * the user has tracked locally on the item.
 */
export function getLocalLoggedMap(): Map<number, number> {
  const rows = getDb()
    .prepare<[], { work_item_id: number; started_at: string; ended_at: string | null }>(
      `SELECT work_item_id, started_at, ended_at FROM time_entries`,
    )
    .all();
  const now = Date.now();
  const m = new Map<number, number>();
  for (const r of rows) {
    const start = new Date(r.started_at).getTime();
    const end = r.ended_at ? new Date(r.ended_at).getTime() : now;
    const sec = Math.max(0, Math.round((end - start) / 1000));
    m.set(r.work_item_id, (m.get(r.work_item_id) ?? 0) + sec);
  }
  return m;
}

/**
 * Unsynced seconds per work item — i.e. time that ADO doesn't know about yet.
 * Only counts CLOSED entries; a running timer is "in flight" and won't be
 * pushed until you pause/stop it.
 */
export function getUnsyncedSecondsMap(): Map<number, number> {
  const rows = getDb()
    .prepare<[], { work_item_id: number; started_at: string; ended_at: string }>(
      `SELECT work_item_id, started_at, ended_at
       FROM time_entries
       WHERE ended_at IS NOT NULL AND synced_to_ado = 0`,
    )
    .all();
  const m = new Map<number, number>();
  for (const r of rows) {
    const sec = Math.max(
      0,
      Math.round((new Date(r.ended_at).getTime() - new Date(r.started_at).getTime()) / 1000),
    );
    m.set(r.work_item_id, (m.get(r.work_item_id) ?? 0) + sec);
  }
  return m;
}

/**
 * Seconds-not-yet-in-ADO per work item: closed-unsynced entries plus any
 * currently-running session's elapsed time. This is what the UI should add
 * to ADO's CompletedWork to show "real" logged hours.
 */
export function getUncapturedSecondsMap(): Map<number, number> {
  const rows = getDb()
    .prepare<[], { work_item_id: number; started_at: string; ended_at: string | null; synced_to_ado: number }>(
      `SELECT work_item_id, started_at, ended_at, synced_to_ado
       FROM time_entries
       WHERE ended_at IS NULL OR synced_to_ado = 0`,
    )
    .all();
  const now = Date.now();
  const m = new Map<number, number>();
  for (const r of rows) {
    const start = new Date(r.started_at).getTime();
    const end = r.ended_at ? new Date(r.ended_at).getTime() : now;
    const sec = Math.max(0, Math.round((end - start) / 1000));
    m.set(r.work_item_id, (m.get(r.work_item_id) ?? 0) + sec);
  }
  return m;
}

/** {workItemId: startedAt ISO} for items with a currently-running timer. */
export function getRunningStartsMap(): Map<number, string> {
  const rows = getDb()
    .prepare<[], { work_item_id: number; started_at: string }>(
      `SELECT work_item_id, started_at FROM time_entries WHERE ended_at IS NULL`,
    )
    .all();
  const m = new Map<number, string>();
  for (const r of rows) m.set(r.work_item_id, r.started_at);
  return m;
}

/** Count of unpushed local changes (closed time entries + failed sync queue). */
export function getPendingChangesCount(): number {
  const db = getDb();
  const a = db
    .prepare<[], { n: number }>(
      `SELECT COUNT(*) AS n FROM time_entries WHERE ended_at IS NOT NULL AND synced_to_ado = 0`,
    )
    .get()!.n;
  const b = db
    .prepare<[], { n: number }>(
      `SELECT COUNT(*) AS n FROM pending_changes WHERE applied_at IS NULL`,
    )
    .get()!.n;
  return a + b;
}

/* ============================================================ */
/*  Pending changes queue (for failed ADO pushes)                */
/* ============================================================ */

export function recordFailedSync(
  workItemId: number,
  kind: 'effort' | 'state',
  payload: unknown,
  error: string,
): void {
  getDb()
    .prepare(
      `INSERT INTO pending_changes (work_item_id, kind, payload, created_at, error)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(workItemId, kind, JSON.stringify(payload), new Date().toISOString(), error);
}

/* ============================================================ */
/*  Settings helpers                                             */
/* ============================================================ */

export function getSetting(key: string): string | undefined {
  const row = getDb()
    .prepare<[string], { value: string }>(`SELECT value FROM settings WHERE key = ?`)
    .get(key);
  return row?.value;
}

export function setSetting(key: string, value: string): void {
  getDb()
    .prepare(
      `INSERT INTO settings (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    )
    .run(key, value);
}
