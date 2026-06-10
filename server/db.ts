/**
 * Local SQLite store at ~/.sprint-helper/data.db.
 *
 * Holds state that doesn't belong in Azure DevOps:
 *  - time_entries: every start/stop session per work item (multiple per item).
 *  - pending_changes: changes we tried to push to ADO and failed; retry queue.
 *  - settings: misc key/value config.
 *  - sessions / session_events: Claude Code sessions reported via MCP — what
 *    Moran is working on right now, plus summaries, blockers, decisions.
 *  - helper_notes: the assistant's plain-English nudges (R3); soft-dismissed.
 *  - sh_created_items: items the MCP itself created (Task / Story); local
 *    marker only, never reaches Azure DevOps.
 *
 * Connection is opened lazily and cached for the life of the process.
 */
import Database, { type Database as DB } from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

let cached: DB | null = null;

export function getDb(): DB {
  if (cached) return cached;
  const dir = join(homedir(), '.sprint-helper');
  mkdirSync(dir, { recursive: true });
  const dbPath = join(dir, 'data.db');
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  migrate(db);
  cached = db;
  return db;
}

function migrate(db: DB) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS time_entries (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      work_item_id  INTEGER NOT NULL,
      started_at    TEXT NOT NULL,
      ended_at      TEXT,
      note          TEXT,
      synced_to_ado INTEGER NOT NULL DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS idx_time_entries_wi
      ON time_entries(work_item_id);

    CREATE TABLE IF NOT EXISTS pending_changes (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      work_item_id INTEGER NOT NULL,
      kind         TEXT NOT NULL,
      payload      TEXT NOT NULL,
      created_at   TEXT NOT NULL,
      applied_at   TEXT,
      error        TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_pending_open
      ON pending_changes(work_item_id) WHERE applied_at IS NULL;

    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id           TEXT PRIMARY KEY,
      work_item_id INTEGER NOT NULL,
      started_at   TEXT NOT NULL,
      ended_at     TEXT,
      client       TEXT NOT NULL DEFAULT 'claude-code',
      summary      TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_sessions_wi
      ON sessions(work_item_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_active
      ON sessions(work_item_id) WHERE ended_at IS NULL;

    CREATE TABLE IF NOT EXISTS session_events (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id   TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      work_item_id INTEGER NOT NULL,
      type         TEXT NOT NULL,
      text         TEXT NOT NULL,
      created_at   TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_session_events_wi
      ON session_events(work_item_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_session_events_session
      ON session_events(session_id);

    CREATE TABLE IF NOT EXISTS helper_notes (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      body         TEXT NOT NULL,
      created_at   TEXT NOT NULL,
      dismissed_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_helper_notes_open
      ON helper_notes(created_at DESC) WHERE dismissed_at IS NULL;

    CREATE TABLE IF NOT EXISTS sh_created_items (
      work_item_id INTEGER PRIMARY KEY,
      kind         TEXT NOT NULL,
      created_at   TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_sh_created_kind
      ON sh_created_items(kind);
  `);

  // Idempotent ADD COLUMN for session_events.standup_summary (R22, 2026-06-04).
  // Optional AI-written 1-2 sentence read-this-tomorrow blurb for the standup
  // card. Long-form progress text stays in `text`; this is the concise version
  // Moran reads on his Yesterday/Today rows.
  const hasStandupSummary = db
    .prepare("SELECT 1 FROM pragma_table_info('session_events') WHERE name = 'standup_summary'")
    .get();
  if (!hasStandupSummary) {
    db.exec('ALTER TABLE session_events ADD COLUMN standup_summary TEXT');
  }

  // Idempotent ADD COLUMN for helper_notes.pinned_at (2026-06-09). Null = not
  // kept; an ISO timestamp = Moran pinned it ("Keep"), so it sorts first and
  // can't get buried under newer notes.
  const hasPinnedAt = db
    .prepare("SELECT 1 FROM pragma_table_info('helper_notes') WHERE name = 'pinned_at'")
    .get();
  if (!hasPinnedAt) {
    db.exec('ALTER TABLE helper_notes ADD COLUMN pinned_at TEXT');
  }

  // Idempotent ADD COLUMN for helper_notes.work_item_id (2026-06-09). Null =
  // the note isn't about a specific work item (capacity / free-form notes);
  // otherwise the Azure DevOps id it refers to, so Focus mode can show the
  // notes about the task in front of him.
  const hasWorkItemId = db
    .prepare("SELECT 1 FROM pragma_table_info('helper_notes') WHERE name = 'work_item_id'")
    .get();
  if (!hasWorkItemId) {
    db.exec('ALTER TABLE helper_notes ADD COLUMN work_item_id INTEGER');
  }
}

/** For tests or graceful shutdown. */
export function closeDb() {
  if (cached) {
    cached.close();
    cached = null;
  }
}
