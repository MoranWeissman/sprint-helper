// server/sh-created.ts
/**
 * Local marker store: which Azure DevOps work items did sprint-helper itself
 * create? (R12 Thread 2.)
 *
 * Used so the dashboard can show a discreet "SH" pip on items the MCP made
 * via `task_create` / `story_create`. Nothing goes to ADO — invisible to
 * anyone else viewing the board. If `~/.sprint-helper/data.db` is wiped,
 * the markers are gone; that's acceptable (the data lives on Moran's laptop
 * already alongside timers, sessions, helper notes).
 */
import { getDb } from './db';

export type SHCreatedKind = 'task' | 'story';

export interface SHCreatedRow {
  workItemId: number;
  kind: SHCreatedKind;
  createdAt: string;
}

/** Insert a marker. Idempotent (PRIMARY KEY on work_item_id). */
export function markSHCreated(workItemId: number, kind: SHCreatedKind): void {
  getDb()
    .prepare(
      `INSERT OR IGNORE INTO sh_created_items (work_item_id, kind, created_at)
       VALUES (?, ?, ?)`,
    )
    .run(workItemId, kind, new Date().toISOString());
}

/** Returns the IDs sprint-helper created, optionally filtered by kind. */
export function getSHCreatedIdSet(opts: { kind?: SHCreatedKind } = {}): Set<number> {
  const db = getDb();
  const rows = opts.kind
    ? db
        .prepare<[string], { work_item_id: number }>(
          `SELECT work_item_id FROM sh_created_items WHERE kind = ?`,
        )
        .all(opts.kind)
    : db
        .prepare<[], { work_item_id: number }>(
          `SELECT work_item_id FROM sh_created_items`,
        )
        .all();
  return new Set(rows.map(r => r.work_item_id));
}

/** Used in retros — full rows including timestamps. */
export function listSHCreated(): SHCreatedRow[] {
  return getDb()
    .prepare<[], { work_item_id: number; kind: SHCreatedKind; created_at: string }>(
      `SELECT work_item_id, kind, created_at FROM sh_created_items ORDER BY created_at DESC`,
    )
    .all()
    .map(r => ({ workItemId: r.work_item_id, kind: r.kind, createdAt: r.created_at }));
}
