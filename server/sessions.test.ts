import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';

// The store reads the live SQLite via getDb(). Swap in a fresh in-memory db
// per test, carrying the final sessions/session_events shape.
const h = vi.hoisted(() => ({ db: { value: null as null | InstanceType<typeof Database> } }));
vi.mock('./db', () => ({ getDb: () => h.db.value }));

import {
  startSession, sessionOwnershipHint, setSessionWaiting, logEvent, endSession,
  listRecentlyEnded, getSession,
} from './sessions';

function makeDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE sessions (
      id            TEXT PRIMARY KEY,
      work_item_id  INTEGER NOT NULL,
      started_at    TEXT NOT NULL,
      ended_at      TEXT,
      client        TEXT NOT NULL DEFAULT 'claude-code',
      summary       TEXT,
      cwd           TEXT,
      waiting_note  TEXT,
      waiting_since TEXT
    );
    CREATE TABLE session_events (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id      TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      work_item_id    INTEGER NOT NULL,
      type            TEXT NOT NULL,
      text            TEXT NOT NULL,
      created_at      TEXT NOT NULL,
      standup_summary TEXT
    );
  `);
  return db;
}

beforeEach(() => {
  h.db.value = makeDb();
});

describe('startSession cwd stamp', () => {
  it('stores the given cwd on a new session', () => {
    const s = startSession({ workItemId: 1, cwd: 'repo-x' });
    expect(s.cwd).toBe('repo-x');
    expect(s.waitingNote).toBeNull();
    expect(s.waitingSince).toBeNull();
  });

  it('stores null when cwd is explicitly null (unknown launch dir)', () => {
    const s = startSession({ workItemId: 2, cwd: null });
    expect(s.cwd).toBeNull();
  });

  it('is idempotent and backfills a null cwd on the existing open session', () => {
    // Simulate an OLD session row (pre-migration: cwd null).
    h.db.value!
      .prepare(`INSERT INTO sessions (id, work_item_id, started_at, client) VALUES ('old-1', 3, '2026-06-30T08:00:00.000Z', 'claude-code')`)
      .run();
    const s = startSession({ workItemId: 3, cwd: 'repo-x' });
    expect(s.id).toBe('old-1'); // same session, not a new one
    expect(s.cwd).toBe('repo-x'); // learned its home
    const stored = h.db.value!.prepare(`SELECT cwd FROM sessions WHERE id = 'old-1'`).get() as { cwd: string };
    expect(stored.cwd).toBe('repo-x');
  });

  it('does not overwrite an existing cwd on the idempotent path', () => {
    startSession({ workItemId: 4, cwd: 'repo-x' });
    const again = startSession({ workItemId: 4, cwd: 'repo-y' });
    expect(again.cwd).toBe('repo-x');
  });
});

describe('sessionOwnershipHint', () => {
  it("returns 'mine' when both sides match", () => {
    expect(sessionOwnershipHint('repo-x', 'repo-x')).toBe('mine');
  });
  it("returns 'other-repo' when both known and different", () => {
    expect(sessionOwnershipHint('repo-x', 'repo-y')).toBe('other-repo');
  });
  it("returns 'unknown' when either side is null", () => {
    expect(sessionOwnershipHint(null, 'repo-x')).toBe('unknown');
    expect(sessionOwnershipHint('repo-x', null)).toBe('unknown');
    expect(sessionOwnershipHint(null, null)).toBe('unknown');
  });
});

describe('waiting flag', () => {
  it('sets the question and timestamp on an open session', () => {
    const s = startSession({ workItemId: 10, cwd: 'repo-x' });
    const w = setSessionWaiting({ sessionId: s.id, question: 'Which cluster should I target?' });
    expect(w?.waitingNote).toBe('Which cluster should I target?');
    expect(w?.waitingSince).not.toBeNull();
  });

  it('returns null for a missing or ended session (nothing stored)', () => {
    expect(setSessionWaiting({ sessionId: 'nope', question: 'q' })).toBeNull();
    const s = startSession({ workItemId: 11, cwd: 'repo-x' });
    endSession({ sessionId: s.id });
    expect(setSessionWaiting({ sessionId: s.id, question: 'q' })).toBeNull();
  });

  it('clears on the next session_log event', () => {
    const s = startSession({ workItemId: 12, cwd: 'repo-x' });
    setSessionWaiting({ sessionId: s.id, question: 'q' });
    logEvent({ sessionId: s.id, type: 'progress', text: 'he answered; moving on' });
    expect(getSession(s.id)?.waitingNote).toBeNull();
    expect(getSession(s.id)?.waitingSince).toBeNull();
  });

  it('clears on session end', () => {
    const s = startSession({ workItemId: 13, cwd: 'repo-x' });
    setSessionWaiting({ sessionId: s.id, question: 'q' });
    endSession({ sessionId: s.id, summary: 'done for now' });
    expect(getSession(s.id)?.waitingNote).toBeNull();
    expect(getSession(s.id)?.waitingSince).toBeNull();
  });
});

describe('listRecentlyEnded', () => {
  it('returns sessions ended inside the window and skips older or open ones', () => {
    const now = new Date('2026-07-01T12:00:00.000Z');
    const db = h.db.value!;
    const ins = db.prepare(
      `INSERT INTO sessions (id, work_item_id, started_at, ended_at, client) VALUES (?, ?, ?, ?, 'claude-code')`,
    );
    ins.run('recent', 20, '2026-07-01T09:00:00.000Z', '2026-07-01T10:30:00.000Z'); // 1.5h ago — in
    ins.run('old', 21, '2026-07-01T01:00:00.000Z', '2026-07-01T02:00:00.000Z');    // 10h ago — out
    ins.run('open', 22, '2026-07-01T11:00:00.000Z', null);                          // open — out
    const got = listRecentlyEnded(4, now);
    expect(got.map(s => s.id)).toEqual(['recent']);
  });
});
