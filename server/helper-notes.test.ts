import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';

// The store reads the live SQLite via getDb(). Swap in a fresh in-memory db
// per test, carrying the final helper_notes shape (with the new columns).
const h = vi.hoisted(() => ({ db: { value: null as null | InstanceType<typeof Database> } }));
vi.mock('./db', () => ({ getDb: () => h.db.value }));

import { addNote, listNotes, pinNote, unpinNote, dismissNote, ensureCapacityNudge } from './helper-notes';

function makeDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE helper_notes (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      body         TEXT NOT NULL,
      created_at   TEXT NOT NULL,
      dismissed_at TEXT,
      pinned_at    TEXT,
      work_item_id INTEGER
    );
    CREATE TABLE settings ( key TEXT PRIMARY KEY, value TEXT NOT NULL );
  `);
  return db;
}

beforeEach(() => {
  h.db.value = makeDb();
});

describe('addNote', () => {
  it('stores an optional work item id and returns it', () => {
    const note = addNote('CODEOWNERS model has gone quiet', 426267);
    expect(note.workItemId).toBe(426267);
    expect(note.pinnedAt).toBeNull();
    const [read] = listNotes();
    expect(read.workItemId).toBe(426267);
  });

  it('defaults work item id to null when omitted', () => {
    const note = addNote('You have room left this sprint');
    expect(note.workItemId).toBeNull();
  });
});

describe('pinNote / unpinNote', () => {
  it('pins a note and surfaces it before newer unpinned notes', () => {
    const older = addNote('older note');
    addNote('newer note');
    pinNote(older.id);

    const ordered = listNotes();
    expect(ordered[0].id).toBe(older.id);
    expect(ordered[0].pinnedAt).not.toBeNull();
  });

  it('unpins a note so it returns to newest-first order', () => {
    const older = addNote('older note');
    const newer = addNote('newer note');
    pinNote(older.id);
    unpinNote(older.id);

    const ordered = listNotes();
    expect(ordered[0].id).toBe(newer.id);
    expect(ordered.find(n => n.id === older.id)!.pinnedAt).toBeNull();
  });
});

describe('ensureCapacityNudge — refresh behaviour', () => {
  it('fires once when the gap clears the threshold', () => {
    const note = ensureCapacityNudge({ sprintName: '26_13', difference: -60, availableHours: 73, plannedHours: 13 });
    expect(note).not.toBeNull();
    expect(listNotes()).toHaveLength(1);
    expect(listNotes()[0].body).toContain('60h');
  });

  it('does NOT re-fire when the numbers are essentially unchanged', () => {
    ensureCapacityNudge({ sprintName: '26_13', difference: -60, availableHours: 73, plannedHours: 13 });
    const again = ensureCapacityNudge({ sprintName: '26_13', difference: -61, availableHours: 74, plannedHours: 13 });
    expect(again).toBeNull();
    expect(listNotes()).toHaveLength(1);
  });

  it('REPLACES the old note with fresh numbers when capacity drifts a lot (same sprint)', () => {
    ensureCapacityNudge({ sprintName: '26_13', difference: -60, availableHours: 73, plannedHours: 13 });
    // Big drift: room jumps to ~72h after a meeting was cancelled.
    const refreshed = ensureCapacityNudge({ sprintName: '26_13', difference: -72, availableHours: 85, plannedHours: 13 });
    expect(refreshed).not.toBeNull();
    const open = listNotes();
    expect(open).toHaveLength(1); // old one retired, not stacked
    expect(open[0].body).toContain('72h');
    expect(open[0].body).not.toContain('60h');
  });

  it('REPLACES a stale previous-sprint note when the sprint rolls over', () => {
    ensureCapacityNudge({ sprintName: '26_12', difference: -60, availableHours: 73, plannedHours: 13 });
    const next = ensureCapacityNudge({ sprintName: '26_13', difference: -72, availableHours: 85, plannedHours: 13 });
    expect(next).not.toBeNull();
    const open = listNotes();
    expect(open).toHaveLength(1);
    expect(open[0].body).toContain('72h');
  });

  it('does NOT resurrect a note Moran already dismissed (same sprint, similar numbers)', () => {
    const first = ensureCapacityNudge({ sprintName: '26_13', difference: -60, availableHours: 73, plannedHours: 13 })!;
    dismissNote(first.id);
    // Same sprint, numbers basically unchanged → he already said no, leave it dismissed.
    const again = ensureCapacityNudge({ sprintName: '26_13', difference: -61, availableHours: 74, plannedHours: 13 });
    expect(again).toBeNull();
    expect(listNotes()).toHaveLength(0);
  });
});
