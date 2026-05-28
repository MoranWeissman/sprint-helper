# R3 — Helper's Notes Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.
>
> **Verification note:** This project has no test framework. Each task verifies with `npx tsc --noEmit` (typecheck) and, where useful, a self-cleaning `tsx` script. Backend ↔ MCP behavior and the final visual are smoke-checked by Moran (browser + a fresh Claude Code session), flagged at the end.

**Goal:** Add a "helper's notes" space to the Overview — one always-current short read of Moran's sprint plus the last few dismissable nudges — that the assistant writes via MCP and Moran can tick off.

**Architecture:** A new self-contained store module (`server/helper-notes.ts`) owns both halves: the living summary (single value in the `settings` table) and the nudges (rows in a new `helper_notes` table, soft-dismissed). The dashboard payload carries `helperNotes`. Three new MCP tools let the assistant read/write it; one new dev endpoint lets the UI dismiss a nudge. The Overview renders a first-pass panel (clean, on-palette) wired to dismiss; whether to refine it in Claude Design is Moran's call after she sees it.

**Tech Stack:** better-sqlite3, MCP (`@modelcontextprotocol/sdk` + zod), Vite dev middleware, React + TS.

**Decisions locked with Moran (2026-05-28):**
- Shape = **short living summary + a few recent notes** (matches the spec's lean).
- Clearing = **Moran ticks a note off** once handled (soft-dismiss, not auto-fade).
- Assistant-authored; the assistant maintains the summary and drops nudges (driven by `SERVER_INSTRUCTIONS`).

---

## File Structure

- **Create** `server/helper-notes.ts` — the store: summary (settings key) + notes (table). Pure data + tiny SQL; no ADO, no network.
- **Modify** `server/db.ts` — add the `helper_notes` table to `migrate()`.
- **Modify** `server/dashboard.ts` — add `helperNotes` to `DashboardPayload` + populate it in both return paths.
- **Modify** `src/lib/api.ts` — add `ApiHelperNote`, `helperNotes` on `ApiPayload`, and a `dismissHelperNote()` fetch helper.
- **Modify** `vite.config.ts` — add `/api/helper-note/` middleware (`POST /:id/dismiss`).
- **Modify** `mcp/server.ts` — add `helper_notes_get`, `helper_note_set_summary`, `helper_note_add`; extend `SERVER_INSTRUCTIONS`.
- **Modify** `src/components/Dashboard.tsx` + `src/styles/dashboard.css` — render the notes panel in `R21Overview`, wire dismiss with optimistic removal + refresh.

---

### Task 1: Store module — `server/helper-notes.ts`

**Files:**
- Create: `server/helper-notes.ts`

- [ ] **Step 1: Write the module**

```ts
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
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: PASS (no errors). It will fail to find the `helper_notes` table only at runtime, not at compile time — the table is added in Task 2.

- [ ] **Step 3: Commit**

```bash
git add server/helper-notes.ts
git commit -m "feat(r3): helper's notes store — living summary + dismissable nudges"
```

---

### Task 2: Migration — add the `helper_notes` table

**Files:**
- Modify: `server/db.ts` (inside `migrate()`)

- [ ] **Step 1: Add the table to the `db.exec(...)` block in `migrate()`** (append after the `session_events` index block, before the closing backtick):

```sql
    CREATE TABLE IF NOT EXISTS helper_notes (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      body         TEXT NOT NULL,
      created_at   TEXT NOT NULL,
      dismissed_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_helper_notes_open
      ON helper_notes(created_at DESC) WHERE dismissed_at IS NULL;
```

- [ ] **Step 2: Also update the file's top doc comment** — add a line to the bullet list:

```
 *  - helper_notes: the assistant's plain-English nudges (R3); soft-dismissed.
```

- [ ] **Step 3: Verify the table + store round-trip with a self-cleaning script**

Create `scripts/_r3_check.ts`:

```ts
import { setSummary, getSummary, addNote, listNotes, dismissNote, getHelperNotes } from '../server/helper-notes';

setSummary('Heads-down on ArgoCD; tomorrow is your clear runway.');
const a = addNote('Bump the ArgoCD estimate?');
const b = addNote('2 tasks quiet since Monday — still on?');
const before = getHelperNotes();
if (before.summary == null) throw new Error('summary not stored');
if (before.notes.length < 2) throw new Error('notes not stored');
if (!dismissNote(a.id)) throw new Error('dismiss did not affect a row');
if (dismissNote(a.id)) throw new Error('second dismiss should be a no-op');
const after = listNotes();
if (after.some(n => n.id === a.id)) throw new Error('dismissed note still listed');
// clean up the seeded rows + summary so the script leaves no trace
const { getDb } = await import('../server/db');
getDb().prepare('DELETE FROM helper_notes WHERE id IN (?, ?)').run(a.id, b.id);
setSummary('');
if (getSummary().summary != null) throw new Error('summary not cleared');
console.log('R3 store OK');
```

Run: `npx tsx scripts/_r3_check.ts`
Expected: prints `R3 store OK`.

- [ ] **Step 2.5: Remove the throwaway script**

```bash
rm scripts/_r3_check.ts
```

- [ ] **Step 3: Typecheck + commit**

Run: `npx tsc --noEmit` → PASS

```bash
git add server/db.ts
git commit -m "feat(r3): helper_notes table + migration"
```

---

### Task 3: Dashboard payload carries `helperNotes`

**Files:**
- Modify: `server/dashboard.ts`

- [ ] **Step 1: Import the store** (add to the imports near the top):

```ts
import { getHelperNotes, type HelperNotes } from './helper-notes';
```

- [ ] **Step 2: Add the field to `DashboardPayload`** (after `activeSessions: number;`):

```ts
  /** The assistant's read on the sprint: a living summary + a few open nudges. */
  helperNotes: HelperNotes;
```

- [ ] **Step 3: Populate it in BOTH return objects.** In the no-iteration early return add:

```ts
      helperNotes: getHelperNotes(),
```

and in the main return (after `activeSessions: activeSessions.size,`) add the same line:

```ts
    helperNotes: getHelperNotes(),
```

- [ ] **Step 4: Typecheck + commit**

Run: `npx tsc --noEmit` → PASS

```bash
git add server/dashboard.ts
git commit -m "feat(r3): expose helperNotes in the dashboard payload"
```

---

### Task 4: API types + dismiss helper

**Files:**
- Modify: `src/lib/api.ts`

- [ ] **Step 1: Add the note type** (after `ApiActiveSession`):

```ts
export interface ApiHelperNote {
  id: number;
  body: string;
  createdAt: string;
}

export interface ApiHelperNotes {
  summary: string | null;
  summaryAt: string | null;
  notes: ApiHelperNote[];
}
```

- [ ] **Step 2: Add `helperNotes` to `ApiPayload`** (after `activeSessions: number;`):

```ts
  /** The assistant's read on the sprint: a living summary + a few open nudges. */
  helperNotes: ApiHelperNotes;
```

- [ ] **Step 3: Add the dismiss fetch helper** (near `updateWorkItem`, end of file):

```ts
/* -------------------------------------------------------------------------- */
/*  Helper's notes                                                            */
/* -------------------------------------------------------------------------- */

export async function dismissHelperNote(id: number): Promise<void> {
  const r = await fetch(`/api/helper-note/${id}/dismiss`, { method: 'POST' });
  const body = await r.json().catch(() => ({}));
  if (!r.ok || (body && 'error' in body)) {
    throw new Error((body && body.error) || 'Could not clear that note');
  }
}
```

- [ ] **Step 4: Typecheck + commit**

Run: `npx tsc --noEmit` → PASS

```bash
git add src/lib/api.ts
git commit -m "feat(r3): api types for helperNotes + dismiss helper"
```

---

### Task 5: Dev endpoint — `POST /api/helper-note/:id/dismiss`

**Files:**
- Modify: `vite.config.ts`

- [ ] **Step 1: Register the middleware** inside `configureServer`, after the `/api/schedule` block:

```ts
      server.middlewares.use('/api/helper-note/', async (req, res) => {
        try {
          const url = new URL(req.url ?? '/', 'http://localhost');
          const m = url.pathname.match(/^\/(\d+)\/dismiss\/?$/);
          if (!m) {
            res.statusCode = 400;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ error: 'Expected /api/helper-note/<id>/dismiss' }));
            return;
          }
          if (req.method !== 'POST') {
            res.statusCode = 405;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ error: 'POST only' }));
            return;
          }
          const { dismissNote } = await import('./server/helper-notes');
          const dismissed = dismissNote(Number(m[1]));
          res.setHeader('Content-Type', 'application/json');
          res.setHeader('Cache-Control', 'no-store');
          res.end(JSON.stringify({ dismissed }));
        } catch (err) {
          const message = err instanceof Error ? err.message : 'unknown error';
          res.statusCode = 500;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ error: message }));
        }
      });
```

- [ ] **Step 2: Typecheck + commit**

Run: `npx tsc --noEmit` → PASS
(Restart of `npm run dev` is required for vite.config changes — flagged to Moran at the end.)

```bash
git add vite.config.ts
git commit -m "feat(r3): /api/helper-note/:id/dismiss endpoint"
```

---

### Task 6: MCP tools + instructions

**Files:**
- Modify: `mcp/server.ts`

- [ ] **Step 1: Import the store** (add to the existing import block):

```ts
import { addNote, getHelperNotes, setSummary } from '../server/helper-notes.js';
```

- [ ] **Step 2: Register three tools** (add a new section before the Boot section):

```ts
/* ============================================================ */
/*  Helper's notes                                               */
/* ============================================================ */

server.registerTool(
  'helper_notes_get',
  {
    title: "Get the helper's notes",
    description:
      "Read what's currently in Moran's helper-notes space on her dashboard: the living summary plus her open (not-yet-cleared) nudges. Call this before writing so you don't repeat a nudge that's already there.",
    inputSchema: {},
  },
  async () => jsonResult(getHelperNotes()),
);

server.registerTool(
  'helper_note_set_summary',
  {
    title: "Set the helper's living summary",
    description:
      "Rewrite the one short, always-current plain-English read of Moran's sprint shown at the top of her notes space. Keep it to 1-3 casual sentences — how the sprint is really going, what today is good for. This REPLACES the previous summary. Pass an empty string to clear it.",
    inputSchema: {
      summary: z.string().describe('1-3 casual, plain-English sentences. Empty string clears it.'),
    },
  },
  async ({ summary }) => jsonResult(setSummary(summary)),
);

server.registerTool(
  'helper_note_add',
  {
    title: "Add a nudge to the helper's notes",
    description:
      "Drop a single short nudge into Moran's notes space — something you noticed worth her attention (an estimate that looks low, tasks gone quiet, a good day for deep work). Plain, casual English, one thought per note. She ticks these off herself once handled, so only add things that are genuinely actionable or worth seeing.",
    inputSchema: {
      body: z.string().min(1).describe('One short, casual, plain-English nudge.'),
    },
  },
  async ({ body }) => jsonResult(addNote(body)),
);
```

- [ ] **Step 3: Extend `SERVER_INSTRUCTIONS`** — insert this section before the final `Call \`sprint_snapshot\`...` paragraph:

```
KEEPING MORAN'S NOTES (her dashboard's "helper's notes" space):
  This is where you talk TO Moran about her sprint, in plain casual English.
  - Keep a living summary current with \`helper_note_set_summary\`: 1-3 sentences
    on how the sprint is really going and what today is good for. Rewrite it when
    the picture changes (e.g. at the start of work, after closing a task).
  - Drop a nudge with \`helper_note_add\` when you notice something worth her
    attention: an estimate that looks too small for the real work, tasks with no
    movement for days, a light calendar day that's good for deep work. One thought
    per nudge. She ticks them off herself, so don't spam — only genuinely useful
    things. Call \`helper_notes_get\` first to avoid repeating a nudge.
  - Never write effort or status to Azure DevOps from a note — notes are just your
    read for her; ADO writes still only happen via the confirm-first close-the-loop.
```

- [ ] **Step 4: Update the bucket comment at the top of the file** — add to the tool-bucket list in the header doc comment:

```
 *  - notes:     helper_notes_get, helper_note_set_summary, helper_note_add
```

- [ ] **Step 5: Update `mcp/README.md`** — add the three tools to the tool table and a line in the recommended flow noting the assistant maintains the summary + nudges.

- [ ] **Step 6: Typecheck + commit**

Run: `npx tsc --noEmit` → PASS
(MCP changes need a fresh Claude Code session to load — flagged to Moran at the end.)

```bash
git add mcp/server.ts mcp/README.md
git commit -m "feat(r3): MCP tools for the helper's notes + proactive instructions"
```

---

### Task 7: First-pass notes panel in the Overview

**Files:**
- Modify: `src/components/Dashboard.tsx` (the `R21Overview` component + its props/data wiring)
- Modify: `src/styles/dashboard.css` (append an `R3 — helper's notes` block in the SLICE R2 section)

> The exact JSX wiring depends on the current `R21Overview` signature — read it first and follow its existing prop-passing pattern (it already receives the payload `data`). Keep the panel calm and on-palette (existing `--bg-*` / `--ink-*` / `--line-*` tokens, one accent). One focal point: the panel is quiet, not loud.

- [ ] **Step 1: Read `R21Overview` + how `data`/`refresh` reach it** in `Dashboard.tsx` so the panel is wired the same way as the rest of the Overview.

- [ ] **Step 2: Render the panel** — a titled "Notes from your helper" block placed in the Overview's natural reading column (near the headline/subline). Show:
  - the summary paragraph (if present),
  - the open notes as a short list, each with a tick-off control (44×44 touch target, clear focus ring),
  - a calm empty state when both are absent: _"All quiet here — I'll jot notes as I notice things."_

- [ ] **Step 3: Wire dismiss** — on tick-off, call `dismissHelperNote(id)`, optimistically remove the note from local state, then `refresh()` the dashboard; on error, restore it and surface a quiet inline message.

- [ ] **Step 4: Typecheck + prod build**

Run: `npx tsc --noEmit` → PASS
Run: `npm run build` → PASS

- [ ] **Step 5: Seed sample notes so the panel isn't empty when Moran looks**

Create `scripts/_r3_seed.ts`:

```ts
import { setSummary, addNote } from '../server/helper-notes';
setSummary("You're heads-down on the live work — looking steady. Tomorrow's lighter, a good day for the deeper task.");
addNote('A couple of tasks have been quiet for a bit — still on your radar, or drop them?');
addNote('This sprint is planned a little tight against your real desk time — worth a look at pre-planning.');
console.log('seeded sample helper notes');
```

Run: `npx tsx scripts/_r3_seed.ts` then `rm scripts/_r3_seed.ts`
(These are real, dismissable sample notes — Moran can tick them off. They demonstrate the feature live.)

- [ ] **Step 6: Commit**

```bash
git add src/components/Dashboard.tsx src/styles/dashboard.css
git commit -m "feat(r3): helper's notes panel in the Overview + dismiss wiring"
```

---

## Smoke checks for Moran (flagged — require a browser / fresh session)

1. **Browser:** restart `npm run dev` (picks up the vite.config endpoint), open the Day Overview — the "notes from your helper" panel shows the seeded summary + two nudges; ticking one off makes it disappear and it stays gone on reload.
2. **Fresh Claude Code session:** the new MCP tools load only on reconnect. In a new session, working normally, the assistant should keep the summary current and drop the occasional nudge — and they appear live on the dashboard.

## Claude Design (optional, Moran's call)

The panel above is a clean first pass, not a Claude Design product. After Moran sees it live, offer to refine it in Claude Design. If she wants to: write a brief that **(a)** includes the standard "since your last handoff — DO NOT bring back" section (R1 removals + R2's removed metric-bar/standup/inline-editors) and **(b)** asks which Tweaks she selected (they don't travel in the bundle) — see `reference-claude-design`. Then implement from the handoff.

## Self-Review

- **Spec coverage:** spec §"The helper's notes" → summary + nudges, plain casual English, lives in Overview ✓ (Tasks 1,3,6,7). Spec "to settle: notes shape" → resolved with Moran (summary + few notes) ✓. "Tick off" interaction → soft-dismiss (Tasks 1,5,7) ✓.
- **Type consistency:** `HelperNotes`/`HelperNote` (server) mirrored by `ApiHelperNotes`/`ApiHelperNote` (client); `getHelperNotes()` used identically in payload + MCP ✓.
- **No placeholders:** every code step is concrete; Task 7's JSX is intentionally read-then-wire because it depends on the live `R21Overview` shape — its requirements are fully specified.
- **Confirm-first invariant preserved:** notes never write to ADO (called out in instructions Step 3 + Task 6) ✓.
