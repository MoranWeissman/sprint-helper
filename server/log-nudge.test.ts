import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

// checkStaleLogNudge reads the live SQLite store via getDb(). We swap in a
// fresh in-memory database per test so the dedup/re-arm behavior can be driven
// end-to-end without touching ~/.sprint-helper/data.db.
const h = vi.hoisted(() => ({ db: { value: null as null | InstanceType<typeof Database> } }));
vi.mock('./db', () => ({ getDb: () => h.db.value }));

import { checkStaleLogNudge } from './log-nudge';

const T0 = '2026-06-07T09:00:00.000Z';
const minutes = (n: number) => n * 60 * 1000;
const at = (m: number) => new Date(Date.parse(T0) + minutes(m));

function makeDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      work_item_id INTEGER NOT NULL,
      started_at TEXT NOT NULL,
      ended_at TEXT,
      client TEXT NOT NULL DEFAULT 'claude-code',
      summary TEXT
    );
    CREATE TABLE session_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      work_item_id INTEGER NOT NULL,
      type TEXT NOT NULL,
      text TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE settings ( key TEXT PRIMARY KEY, value TEXT NOT NULL );
  `);
  return db;
}

function addSession(id: string, workItemId: number, startedAt: string, endedAt: string | null = null) {
  h.db
    .value!.prepare(
      `INSERT INTO sessions (id, work_item_id, started_at, ended_at) VALUES (?, ?, ?, ?)`,
    )
    .run(id, workItemId, startedAt, endedAt);
}

function addEvent(sessionId: string, workItemId: number, createdAt: string) {
  h.db
    .value!.prepare(
      `INSERT INTO session_events (session_id, work_item_id, type, text, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(sessionId, workItemId, 'progress', 'work', createdAt);
}

beforeEach(() => {
  h.db.value = makeDb();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  h.db.value?.close();
  h.db.value = null;
});

describe('checkStaleLogNudge', () => {
  it('returns null when no sessions are open', () => {
    vi.setSystemTime(at(0));
    expect(checkStaleLogNudge()).toBeNull();
  });

  it('does not nudge a session that had activity within the last 45 minutes', () => {
    addSession('s1', 100, T0);
    addEvent('s1', 100, T0);
    vi.setSystemTime(at(30));
    expect(checkStaleLogNudge()).toBeNull();
  });

  it('nudges once a session goes quiet past 45 minutes, naming the work item', () => {
    addSession('s1', 433653, T0);
    addEvent('s1', 433653, T0);
    vi.setSystemTime(at(46));
    const out = checkStaleLogNudge();
    expect(out).toContain('433653');
    expect(out).toContain('46');
    expect(out).toMatch(/stale session/i);
  });

  it('falls back to started_at as the activity clock when a session has no events', () => {
    addSession('s1', 100, T0); // never logged an event
    vi.setSystemTime(at(50));
    expect(checkStaleLogNudge()).not.toBeNull();
  });

  it('ignores closed sessions', () => {
    addSession('s1', 100, T0, at(5).toISOString());
    vi.setSystemTime(at(90));
    expect(checkStaleLogNudge()).toBeNull();
  });

  it('fires only once per stale window, not on every check', () => {
    addSession('s1', 100, T0);
    vi.setSystemTime(at(46));
    expect(checkStaleLogNudge()).not.toBeNull(); // first fire
    expect(checkStaleLogNudge()).toBeNull(); // deduped, same window
    vi.setSystemTime(at(60));
    expect(checkStaleLogNudge()).toBeNull(); // still deduped, no new activity
  });

  it('re-arms after fresh activity, then nudges again once it goes quiet', () => {
    addSession('s1', 100, T0);
    vi.setSystemTime(at(46));
    expect(checkStaleLogNudge()).not.toBeNull(); // first nudge

    // Activity resumes — this should re-arm the nudge.
    addEvent('s1', 100, at(50).toISOString());

    vi.setSystemTime(at(70));
    expect(checkStaleLogNudge()).toBeNull(); // only 20 min since activity — fresh

    vi.setSystemTime(at(100));
    expect(checkStaleLogNudge()).not.toBeNull(); // quiet again past threshold — re-fires
  });
});
