/**
 * Helper's notes store (slice R3).
 *
 * Two halves, both local-only (never in Azure DevOps):
 *  - summary: a single always-current plain-English read of the sprint, kept in
 *    the shared `settings` table under one JSON key. The assistant rewrites it.
 *  - notes:   individual nudges in `helper_notes`, newest-first, soft-dismissed
 *    (Moran ticks them off — we set dismissed_at, we don't delete).
 *
 * The assistant writes these via MCP; the Day dashboard reads them via the payload.
 */
import { getDb } from './db';

const SUMMARY_KEY = 'helper_summary';
const CAPACITY_NUDGE_KEY = 'capacity_nudge_state';

/** Once-per-sprint-per-direction guard so the capacity nudge doesn't re-fire. */
interface StoredCapacityNudge {
  sprintName: string;
  direction: 'over' | 'under';
  addedAt: string;
}

export interface HelperNote {
  id: number;
  body: string;
  createdAt: string;
}

export interface HelperNotes {
  summary: string | null;
  summaryAt: string | null;
  notes: HelperNote[];
}

interface StoredSummary {
  body: string;
  at: string;
}

/** Replace the living summary. Empty/whitespace clears it. */
export function setSummary(body: string): { summary: string | null; summaryAt: string | null } {
  const db = getDb();
  const trimmed = body.trim();
  if (!trimmed) {
    db.prepare(`DELETE FROM settings WHERE key = ?`).run(SUMMARY_KEY);
    return { summary: null, summaryAt: null };
  }
  const stored: StoredSummary = { body: trimmed, at: new Date().toISOString() };
  db.prepare(
    `INSERT INTO settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(SUMMARY_KEY, JSON.stringify(stored));
  return { summary: stored.body, summaryAt: stored.at };
}

export function getSummary(): { summary: string | null; summaryAt: string | null } {
  const db = getDb();
  const row = db.prepare(`SELECT value FROM settings WHERE key = ?`).get(SUMMARY_KEY) as
    | { value: string }
    | undefined;
  if (!row) return { summary: null, summaryAt: null };
  try {
    const parsed = JSON.parse(row.value) as StoredSummary;
    return { summary: parsed.body ?? null, summaryAt: parsed.at ?? null };
  } catch {
    return { summary: null, summaryAt: null };
  }
}

/** Add a nudge. Returns the created note. */
export function addNote(body: string): HelperNote {
  const db = getDb();
  const trimmed = body.trim();
  if (!trimmed) throw new Error('Note body is required.');
  const createdAt = new Date().toISOString();
  const info = db
    .prepare(`INSERT INTO helper_notes (body, created_at) VALUES (?, ?)`)
    .run(trimmed, createdAt);
  return { id: Number(info.lastInsertRowid), body: trimmed, createdAt };
}

/** Open (not-yet-dismissed) notes, newest first. */
export function listNotes(limit = 5): HelperNote[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT id, body, created_at AS createdAt
         FROM helper_notes
        WHERE dismissed_at IS NULL
        ORDER BY datetime(created_at) DESC, id DESC
        LIMIT ?`,
    )
    .all(limit) as HelperNote[];
  return rows;
}

/** Tick a note off (soft-dismiss). Returns true if a still-open note was dismissed. */
export function dismissNote(id: number): boolean {
  const db = getDb();
  const info = db
    .prepare(`UPDATE helper_notes SET dismissed_at = ? WHERE id = ? AND dismissed_at IS NULL`)
    .run(new Date().toISOString(), id);
  return info.changes > 0;
}

/** Combined read for the dashboard payload + the MCP get tool. */
export function getHelperNotes(limit = 5): HelperNotes {
  const { summary, summaryAt } = getSummary();
  return { summary, summaryAt, notes: listNotes(limit) };
}

/**
 * Add a capacity nudge when planned hours diverge from real desk time by
 * `thresholdHours` (default 8h = a full Moran-day). Deduped via a settings
 * key — fires at most once per sprint per direction (over/under). If sprint
 * changes or direction flips, fires again. Returns the new note, or null if
 * the gap is below threshold or already nudged.
 */
export function ensureCapacityNudge(opts: {
  sprintName: string;
  difference: number;
  realDeskHours: number;
  plannedHours: number;
  thresholdHours?: number;
}): HelperNote | null {
  const threshold = opts.thresholdHours ?? 8;
  if (Math.abs(opts.difference) < threshold) return null;
  const direction: 'over' | 'under' = opts.difference > 0 ? 'over' : 'under';

  const db = getDb();
  const row = db.prepare(`SELECT value FROM settings WHERE key = ?`).get(CAPACITY_NUDGE_KEY) as
    | { value: string }
    | undefined;
  if (row) {
    try {
      const state = JSON.parse(row.value) as StoredCapacityNudge;
      if (state.sprintName === opts.sprintName && state.direction === direction) return null;
    } catch {
      /* corrupt state — fall through and overwrite */
    }
  }

  const planned = Math.round(opts.plannedHours);
  const real = Math.round(opts.realDeskHours);
  const gap = Math.round(Math.abs(opts.difference));
  const body =
    direction === 'over'
      ? `You're planned about ${gap}h over capacity this sprint (${planned}h planned vs ~${real}h real desk time). Want to trim or push something?`
      : `You've got about ${gap}h of slack this sprint (${planned}h planned vs ~${real}h real desk time). Room to pull something in if you want.`;

  const note = addNote(body);

  const next: StoredCapacityNudge = {
    sprintName: opts.sprintName,
    direction,
    addedAt: new Date().toISOString(),
  };
  db.prepare(
    `INSERT INTO settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(CAPACITY_NUDGE_KEY, JSON.stringify(next));

  return note;
}
