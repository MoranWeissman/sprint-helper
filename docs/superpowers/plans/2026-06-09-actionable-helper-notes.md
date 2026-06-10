# Actionable Helper Notes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make each "note from your helper" something Moran can act on (copy a deal-with-this prompt), keep (pin), or clear (done) — and surface the notes about his current work inside Focus mode — while fixing the misleading "11d ago" age.

**Architecture:** Two new nullable columns on the `helper_notes` table (`pinned_at`, `work_item_id`) flow automatically into the dashboard payload because `getHelperNotes()` is returned verbatim. A generalized `/api/helper-note/:id/:action` endpoint handles pin/unpin alongside the existing dismiss. A pure `buildNotePrompt` lives in `src/lib/notePrompt.ts` (unit-tested, React-free). One shared `NoteRow` React component renders a note + its three actions, reused by the Daily rail and the new Focus notes block.

**Tech Stack:** TypeScript, better-sqlite3, Vite dev-server middleware, React 18, Vitest 4. Source spec: `docs/superpowers/specs/2026-06-09-actionable-helper-notes-design.md`.

**Conventions for the implementer:**
- Plain English in every user-facing string and commit message. Banned words: "burndown", "scope" (noun), "blockers" (collective), "velocity", "throughput", "WIP", "slack" (spare-time sense), placeholder labels.
- Work items are named `**Title** (#id)` — title first, id in parens, never a bare id leading a sentence.
- Run `npm run typecheck` and `npm test` from the repo root: `/Users/weissmmo/projects/github-moran/sprint-helper`.
- MCP changes (Task 9) and UI changes (Tasks 6–8) cannot be verified by you — flag them as USER smokes. Do not claim verification.
- Commit after each task.

---

## File Structure

| File | Responsibility | Change |
|------|----------------|--------|
| `server/db.ts` | SQLite schema + idempotent migrations | Add `pinned_at`, `work_item_id` columns |
| `server/helper-notes.ts` | Notes store read/write | New fields on `HelperNote`; `addNote(body, workItemId?)`; kept-first `listNotes`; `pinNote`/`unpinNote`; thread `workItemId` through the stale-task nudge |
| `server/helper-notes.test.ts` | Unit tests for the store | Create |
| `vite.config.ts` | Dashboard API middleware | Generalize the helper-note route to `dismiss`/`pin`/`unpin` |
| `src/lib/api.ts` | Client API types + fetch wrappers | `ApiHelperNote` gains `pinnedAt`,`workItemId`; add `pinHelperNote`/`unpinHelperNote` |
| `src/lib/notePrompt.ts` | Pure prompt builder | Create |
| `src/lib/notePrompt.test.ts` | Unit test for the builder | Create |
| `src/components/Dashboard.tsx` | Daily rail + Focus rendering | Shared `NoteRow`; rework `RailNotes`; add Focus notes block |
| `src/styles/dashboard.css` | Styling | Action row, kept stripe, composer, Focus notes block |
| `mcp/server.ts` | MCP tools | `helper_note_add` gains optional `workItemId` |

---

## Task 1: Database columns

**Files:**
- Modify: `server/db.ts:116-126` (the migration block at the end of `migrate()`)

- [ ] **Step 1: Add the two idempotent migrations**

In `server/db.ts`, immediately after the existing `standup_summary` block (which ends at line 125 with `}`), and before the closing `}` of `migrate()`, add:

```typescript
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
```

- [ ] **Step 2: Verify typecheck passes**

Run: `npm run typecheck`
Expected: no new errors (the three pre-existing warnings in `Dashboard.tsx`/`standup.ts` may remain — they predate this work).

- [ ] **Step 3: Verify the columns land on the real db**

Run:
```bash
npx tsx -e "const {getDb}=require('./server/db'); const c=getDb().prepare(\"SELECT name FROM pragma_table_info('helper_notes')\").all().map(r=>r.name); console.log(c.join(',')); if(!c.includes('pinned_at')||!c.includes('work_item_id')) process.exit(1);"
```
Expected: prints a list including `pinned_at` and `work_item_id`; exit 0. (This opens `~/.sprint-helper/data.db` and runs the migration on it — idempotent and exactly what Moran's db needs anyway.)

- [ ] **Step 4: Commit**

```bash
git add server/db.ts
git commit -m "Helper notes: add pinned_at + work_item_id columns"
```

---

## Task 2: Notes store — keep, work-item, kept-first ordering

**Files:**
- Modify: `server/helper-notes.ts` (interface lines 26-30; `addNote` 73-83; `listNotes` 85-98; add `pinNote`/`unpinNote`; `ensureStaleRemainingNudge` call at 234-240 / definition 271)
- Test: `server/helper-notes.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `server/helper-notes.test.ts`:

```typescript
import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';

// The store reads the live SQLite via getDb(). Swap in a fresh in-memory db
// per test, carrying the final helper_notes shape (with the new columns).
const h = vi.hoisted(() => ({ db: { value: null as null | InstanceType<typeof Database> } }));
vi.mock('./db', () => ({ getDb: () => h.db.value }));

import { addNote, listNotes, pinNote, unpinNote } from './helper-notes';

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
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npm test -- helper-notes`
Expected: FAIL — `addNote` doesn't accept a second argument / `pinNote`,`unpinNote` are not exported / returned notes lack `workItemId` and `pinnedAt`.

- [ ] **Step 3: Update the `HelperNote` interface**

In `server/helper-notes.ts`, replace the interface at lines 26-30:

```typescript
export interface HelperNote {
  id: number;
  body: string;
  createdAt: string;
  pinnedAt: string | null;
  workItemId: number | null;
}
```

- [ ] **Step 4: Update `addNote` to accept an optional work item id**

Replace `addNote` (lines 73-83):

```typescript
/** Add a nudge. `workItemId` ties it to a task so Focus can show it. Returns the created note. */
export function addNote(body: string, workItemId: number | null = null): HelperNote {
  const db = getDb();
  const trimmed = body.trim();
  if (!trimmed) throw new Error('Note body is required.');
  const createdAt = new Date().toISOString();
  const info = db
    .prepare(`INSERT INTO helper_notes (body, created_at, work_item_id) VALUES (?, ?, ?)`)
    .run(trimmed, createdAt, workItemId);
  return { id: Number(info.lastInsertRowid), body: trimmed, createdAt, pinnedAt: null, workItemId };
}
```

- [ ] **Step 5: Update `listNotes` to select the new columns and order kept-first**

Replace `listNotes` (lines 85-98):

```typescript
/** Open (not-yet-dismissed) notes: kept ones first, then newest first. */
export function listNotes(limit = 5): HelperNote[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT id, body, created_at AS createdAt, pinned_at AS pinnedAt, work_item_id AS workItemId
         FROM helper_notes
        WHERE dismissed_at IS NULL
        ORDER BY (pinned_at IS NOT NULL) DESC, datetime(created_at) DESC, id DESC
        LIMIT ?`,
    )
    .all(limit) as HelperNote[];
  return rows;
}
```

- [ ] **Step 6: Add `pinNote` / `unpinNote`**

In `server/helper-notes.ts`, add right after `dismissNote` (after line 107):

```typescript
/** Keep a note (pin it). Returns true if a still-open note was pinned. */
export function pinNote(id: number): boolean {
  const db = getDb();
  const info = db
    .prepare(`UPDATE helper_notes SET pinned_at = ? WHERE id = ? AND dismissed_at IS NULL`)
    .run(new Date().toISOString(), id);
  return info.changes > 0;
}

/** Un-keep a note (unpin it). Returns true if a still-open note was unpinned. */
export function unpinNote(id: number): boolean {
  const db = getDb();
  const info = db
    .prepare(`UPDATE helper_notes SET pinned_at = NULL WHERE id = ? AND dismissed_at IS NULL`)
    .run(id);
  return info.changes > 0;
}
```

- [ ] **Step 7: Thread the work item id through the stale-task nudge**

In `ensureStaleRemainingNudge` (around line 271), change the `addNote(body)` call to pass the id it already has:

```typescript
  const note = addNote(body, opts.workItemId);
```

- [ ] **Step 8: Run the tests**

Run: `npm test -- helper-notes`
Expected: PASS (4 tests).

- [ ] **Step 9: Run the full suite to catch fallout**

Run: `npm test`
Expected: all green (existing 66 + 4 new = 70). If any existing test constructs a `HelperNote` literal, add `pinnedAt: null, workItemId: null` to it.

- [ ] **Step 10: Commit**

```bash
git add server/helper-notes.ts server/helper-notes.test.ts
git commit -m "Helper notes: keep (pin), work-item tag, kept-first ordering"
```

---

## Task 3: API endpoint — pin / unpin

**Files:**
- Modify: `vite.config.ts:223-254` (the `/api/helper-note/` middleware)

- [ ] **Step 1: Generalize the route to handle dismiss / pin / unpin**

Replace the whole middleware body (lines 223-254) with:

```typescript
      server.middlewares.use('/api/helper-note/', async (req, res) => {
        try {
          const url = new URL(req.url ?? '/', 'http://localhost');
          const m = url.pathname.match(/^\/(\d+)\/(dismiss|pin|unpin)\/?$/);
          if (!m) {
            res.statusCode = 400;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ error: 'Expected /api/helper-note/<id>/(dismiss|pin|unpin)' }));
            return;
          }
          if (req.method !== 'POST') {
            res.statusCode = 405;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ error: 'POST only' }));
            return;
          }
          const id = Number(m[1]);
          const action = m[2];
          const { dismissNote, pinNote, unpinNote } = await import('./server/helper-notes');
          const changed =
            action === 'dismiss' ? dismissNote(id) : action === 'pin' ? pinNote(id) : unpinNote(id);
          if (changed) {
            const { invalidateDashboardCache } = await import('./server/dashboard-cache');
            invalidateDashboardCache();
          }
          res.setHeader('Content-Type', 'application/json');
          res.setHeader('Cache-Control', 'no-store');
          res.end(JSON.stringify({ ok: changed }));
        } catch (err) {
          const message = err instanceof Error ? err.message : 'unknown error';
          res.statusCode = 500;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ error: message }));
        }
      });
```

Note: the response key changed from `{ dismissed }` to `{ ok }`; the client wrappers in Task 4 read `ok`.

- [ ] **Step 2: Verify typecheck passes**

Run: `npm run typecheck`
Expected: no new errors.

- [ ] **Step 3: Commit**

```bash
git add vite.config.ts
git commit -m "Helper notes API: one route for dismiss, pin, unpin"
```

---

## Task 4: Client API — types + pin/unpin wrappers

**Files:**
- Modify: `src/lib/api.ts:29-33` (`ApiHelperNote`); `src/lib/api.ts:615` area (`dismissHelperNote` and new wrappers)

- [ ] **Step 1: Add the new fields to `ApiHelperNote`**

Replace lines 29-33:

```typescript
export interface ApiHelperNote {
  id: number;
  body: string;
  createdAt: string;
  pinnedAt: string | null;
  workItemId: number | null;
}
```

- [ ] **Step 2: Update `dismissHelperNote` and add the pin/unpin wrappers**

Replace the existing `dismissHelperNote` function (starts at line 615) with these three:

```typescript
async function postNoteAction(id: number, action: 'dismiss' | 'pin' | 'unpin'): Promise<void> {
  const r = await fetch(`/api/helper-note/${id}/${action}`, { method: 'POST' });
  const body = await r.json().catch(() => ({}));
  if (!r.ok || (body && 'error' in body)) {
    throw new Error((body && body.error) || `Could not ${action} that note`);
  }
}

export async function dismissHelperNote(id: number): Promise<void> {
  await postNoteAction(id, 'dismiss');
}

export async function pinHelperNote(id: number): Promise<void> {
  await postNoteAction(id, 'pin');
}

export async function unpinHelperNote(id: number): Promise<void> {
  await postNoteAction(id, 'unpin');
}
```

- [ ] **Step 3: Verify typecheck passes**

Run: `npm run typecheck`
Expected: no new errors.

- [ ] **Step 4: Commit**

```bash
git add src/lib/api.ts
git commit -m "Helper notes client: pinnedAt/workItemId types + pin/unpin calls"
```

---

## Task 5: Prompt builder (pure, tested)

**Files:**
- Create: `src/lib/notePrompt.ts`
- Test: `src/lib/notePrompt.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/lib/notePrompt.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { buildNotePrompt } from './notePrompt';

describe('buildNotePrompt', () => {
  it('wraps the note body in a deal-with-this prompt', () => {
    const out = buildNotePrompt('**CODEOWNERS model** (#426267) has gone quiet — update Remaining.', '');
    expect(out).toContain('Help me deal with this note from my sprint helper:');
    expect(out).toContain('"**CODEOWNERS model** (#426267) has gone quiet — update Remaining."');
    expect(out).toContain("Let's talk it through and take care of it.");
  });

  it('folds in the extra line when present', () => {
    const out = buildNotePrompt('Task X has gone quiet.', 'I think it should move to next sprint.');
    expect(out).toContain('I think it should move to next sprint.');
  });

  it('omits the extra line entirely when blank or whitespace', () => {
    const out = buildNotePrompt('Task X has gone quiet.', '   ');
    expect(out).not.toMatch(/\n\s*\n\s*\n/); // no empty gap left where the extra line would be
    expect(out.trim().endsWith("Let's talk it through and take care of it.")).toBe(true);
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npm test -- notePrompt`
Expected: FAIL — module `./notePrompt` not found.

- [ ] **Step 3: Implement the builder**

Create `src/lib/notePrompt.ts`:

```typescript
/**
 * Build the paste-into-a-chat prompt for a helper note's "Act on it" button.
 * Pure string assembly — no network, no React. The note body keeps its
 * `**title** (#id)` formatting so the chat can find the work item.
 */
export function buildNotePrompt(body: string, extra: string): string {
  const lines = [
    'Help me deal with this note from my sprint helper:',
    '',
    `"${body}"`,
  ];
  const trimmedExtra = extra.trim();
  if (trimmedExtra) {
    lines.push('', trimmedExtra);
  }
  lines.push('', "Let's talk it through and take care of it.");
  return lines.join('\n');
}
```

- [ ] **Step 4: Run the test**

Run: `npm test -- notePrompt`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/notePrompt.ts src/lib/notePrompt.test.ts
git commit -m "Helper notes: pure prompt builder for Act on it"
```

---

## Task 6: Daily rail — shared NoteRow with three actions + honest age

**Files:**
- Modify: `src/components/Dashboard.tsx` (`RailNotes` 1382-1447; add a `NoteRow` component above it; import the new api + prompt helpers)

This task introduces the shared `NoteRow` (reused by Focus in Task 7) and rebuilds `RailNotes` around it.

- [ ] **Step 1: Add imports**

At the top of `src/components/Dashboard.tsx`, add to the existing `../lib/api` import the new functions, and import the prompt builder. Find the line importing `dismissHelperNote` from `../lib/api` and extend it to also import `pinHelperNote, unpinHelperNote`. Then add near the other `../lib` imports:

```typescript
import { buildNotePrompt } from '../lib/notePrompt';
```

(If `dismissHelperNote` is imported in a multi-name `import { ... } from '../lib/api'` block, add `pinHelperNote, unpinHelperNote` to that same block — do not create a second import from `../lib/api`.)

- [ ] **Step 2: Add the shared `NoteRow` component**

Immediately **above** `function RailNotes(` (line 1382), add:

```typescript
/**
 * One helper note + its three actions, shared by the Daily rail and Focus.
 * - Act on it: opens a one-line box, copies a deal-with-this prompt.
 * - Keep: pins it (covers save + highlight); kept notes get an accent stripe.
 * - Done: clears it for good.
 * onChange refreshes the dashboard after a pin/unpin/dismiss write.
 */
function NoteRow({ note, onChange }: { note: ApiHelperNote; onChange: () => void }) {
  const [busy, setBusy] = useState(false);
  const [composing, setComposing] = useState(false);
  const [extra, setExtra] = useState('');
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const kept = note.pinnedAt != null;

  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
      onChange();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong');
      setBusy(false);
    }
  }

  async function copyPrompt() {
    try {
      await navigator.clipboard.writeText(buildNotePrompt(note.body, extra));
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setError('Could not copy — your browser blocked the clipboard.');
    }
  }

  return (
    <li className={`note${kept ? ' is-kept' : ''}`}>
      <div className="note-main">
        <p className="note-body">{note.body}</p>
        <span className="note-age">{relAgo(note.createdAt)}</span>
      </div>
      <div className="note-actions">
        <button type="button" className="note-act" onClick={() => setComposing(v => !v)} disabled={busy}>
          Act on it
        </button>
        <button
          type="button"
          className={`note-keep${kept ? ' is-on' : ''}`}
          onClick={() => run(() => (kept ? unpinHelperNote(note.id) : pinHelperNote(note.id)))}
          disabled={busy}
        >
          {kept ? 'Kept' : 'Keep'}
        </button>
        <button type="button" className="note-done" onClick={() => run(() => dismissHelperNote(note.id))} disabled={busy}>
          Done
        </button>
      </div>
      {composing && (
        <div className="note-compose">
          <input
            type="text"
            value={extra}
            onChange={e => setExtra(e.target.value)}
            placeholder="Anything to add? (optional)"
            aria-label="Extra instructions for the prompt"
          />
          <button type="button" className="note-copy" onClick={copyPrompt}>
            {copied ? 'Copied ✓' : 'Copy prompt'}
          </button>
        </div>
      )}
      {error && <p className="note-error">{error}</p>}
    </li>
  );
}
```

- [ ] **Step 3: Rebuild `RailNotes` around `NoteRow` and move the summary age**

Replace the whole `RailNotes` function (lines 1382-1447) with:

```typescript
function RailNotes({
  notes,
  onRefresh,
}: {
  notes: ApiHelperNotes;
  onRefresh: () => void;
}) {
  const empty = !notes.summary && notes.notes.length === 0;

  return (
    <section className="r22-rail-card r22-rail-notes" aria-label="Notes from your helper">
      <div className="r22-rail-card-head">
        <span className="r22-rail-card-label">Notes from your helper</span>
      </div>
      {empty ? (
        <p className="empty">All quiet here — I'll jot notes as I notice things.</p>
      ) : (
        <>
          {notes.summary && (
            <div className="r22-rail-summary">
              <p className="summary">{notes.summary}</p>
              {notes.summaryAt && <span className="summary-age">updated {relAgo(notes.summaryAt)}</span>}
            </div>
          )}
          {notes.notes.length > 0 && (
            <ul className="list">
              {notes.notes.map(n => (
                <NoteRow key={n.id} note={n} onChange={onRefresh} />
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}
```

- [ ] **Step 4: Verify typecheck passes**

Run: `npm run typecheck`
Expected: no new errors. (The old `pending`/`clear`/optimistic-hide logic is gone — `NoteRow` now owns per-note state and the refresh re-fetches the list.)

- [ ] **Step 5: Commit**

```bash
git add src/components/Dashboard.tsx
git commit -m "Daily rail: act/keep/done per note, per-note age, summary age moved"
```

- [ ] **Step 6: USER browser smoke (flag, do not verify yourself)**

Tell Moran: hard-refresh `http://localhost:7777/` on the Daily page and check — each note shows Act on it / Keep / Done and its own age; "Act on it" opens a box and "Copy prompt" copies; "Keep" pins to the top with a stripe; the summary's "updated Nd ago" now sits under the summary line.

---

## Task 7: Focus mode — notes about the current work

**Files:**
- Modify: `src/components/Dashboard.tsx` (`R21Focus` 801+; its call site ~278-301)

- [ ] **Step 1: Pass the notes into `R21Focus`**

At the `R21Focus` call site (around line 279), add a `helperNotes` prop. Find:

```typescript
                <R21Focus
                  task={focalTask}
                  story={focalStory}
```

and add the prop right after `story={focalStory}`:

```typescript
                  helperNotes={helperNotes}
```

(`helperNotes` is already in scope in `DashboardLive` — it's the same value passed to `DailyView`/`RailNotes`.)

- [ ] **Step 2: Accept and filter the notes in `R21Focus`**

In the `R21Focus` signature (around line 801-810), add the prop to the destructure and its type:

```typescript
function R21Focus({
  task,
  story,
  helperNotes,
  onOpenItem,
  // ...keep the remaining existing params unchanged...
}: {
  task: ApiWorkItem;
  story: ApiUserStoryGroup | null;
  helperNotes: ApiHelperNotes;
  onOpenItem: (id: number) => void;
  // ...keep the remaining existing prop types unchanged...
}) {
```

(Use the exact existing parameter and type names already present in the function — only `helperNotes` is added.)

Then, just before the `return (` of `R21Focus`'s story view, compute the relevant notes:

```typescript
  const focusNotes = helperNotes.notes.filter(
    n => n.pinnedAt != null || n.workItemId === task.id || (story != null && n.workItemId === story.id),
  );
```

- [ ] **Step 3: Render the notes block in the Focus story view**

Inside `R21Focus`'s returned JSX, after the "Tasks in this story" block (the `{story && story.tasks.length > 0 && ( ... )}` ending around line 960), add:

```tsx
      {focusNotes.length > 0 && (
        <section className="r21-focus-notes" aria-label="Notes about this work">
          <div className="r21-focus-notes-head">Notes about this work</div>
          <ul className="list">
            {focusNotes.map(n => (
              <NoteRow key={n.id} note={n} onChange={onRefresh} />
            ))}
          </ul>
        </section>
      )}
```

If `R21Focus` does not already receive an `onRefresh`-style callback, reuse the same dashboard-refresh function the Focus view already has for its other actions (search the component for the prop it calls after a write, e.g. `onRefresh` or `refresh`); pass that name to `onChange`. If none exists, add an `onRefresh: () => void` prop to `R21Focus` mirroring how `RailNotes` gets `onRefresh`, and wire it at the call site with the same value `DailyView` passes.

- [ ] **Step 4: Verify typecheck passes**

Run: `npm run typecheck`
Expected: no new errors.

- [ ] **Step 5: Commit**

```bash
git add src/components/Dashboard.tsx
git commit -m "Focus mode: show notes about the focal task or its story"
```

- [ ] **Step 6: USER browser smoke (flag, do not verify yourself)**

Tell Moran: open a task in Focus whose story has a helper note (e.g. a stale-task nudge). The note should appear under "Notes about this work" with the same actions, and unrelated notes should not.

---

## Task 8: Styling

**Files:**
- Modify: `src/styles/dashboard.css` (append a new block near the existing `.r22-rail-notes` rules)

- [ ] **Step 1: Add the styles**

Append to `src/styles/dashboard.css`:

```css
/* Helper notes — actionable rows (2026-06-09). Dark/warm palette, one accent,
   no pulsing, per the UI rules. */
.r22-rail-summary { margin-bottom: 12px; }
.r22-rail-summary .summary-age {
  display: block;
  margin-top: 4px;
  font-size: 12px;
  color: var(--ink-3);
}

.r22-rail-notes .list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 10px; }

.note {
  padding: 10px 12px;
  border-radius: 8px;
  background: var(--surface-2);
  border-left: 3px solid transparent;
}
.note.is-kept { border-left-color: var(--accent); background: var(--surface-3); }

.note-main { display: flex; justify-content: space-between; gap: 8px; align-items: baseline; }
.note-body { margin: 0; font-size: 14px; line-height: 1.5; color: var(--ink-1); }
.note-age { flex: none; font-size: 12px; color: var(--ink-3); white-space: nowrap; }

.note-actions { display: flex; gap: 8px; margin-top: 8px; }
.note-actions button {
  font-size: 13px;
  padding: 4px 10px;
  border-radius: 6px;
  border: 1px solid var(--line-2);
  background: transparent;
  color: var(--ink-2);
  cursor: pointer;
}
.note-actions button:hover:not(:disabled) { border-color: var(--accent); color: var(--ink-1); }
.note-actions button:disabled { opacity: 0.5; cursor: default; }
.note-act { color: var(--accent) !important; border-color: var(--accent) !important; }
.note-keep.is-on { background: var(--accent); color: var(--bg-1); border-color: var(--accent); }

.note-compose { display: flex; gap: 8px; margin-top: 8px; }
.note-compose input {
  flex: 1;
  font-size: 13px;
  padding: 5px 9px;
  border-radius: 6px;
  border: 1px solid var(--line-2);
  background: var(--bg-1);
  color: var(--ink-1);
}
.note-copy {
  font-size: 13px;
  padding: 5px 12px;
  border-radius: 6px;
  border: 1px solid var(--accent);
  background: transparent;
  color: var(--accent);
  cursor: pointer;
  white-space: nowrap;
}
.note-error { margin: 6px 0 0; font-size: 12px; color: var(--danger); }

.r21-focus-notes { margin-top: 20px; }
.r21-focus-notes-head {
  font-size: 13px;
  font-weight: 600;
  color: var(--ink-2);
  margin-bottom: 10px;
}
```

Note: if any CSS variable above is not defined in this stylesheet, substitute the nearest existing variable already used by `.r22-rail-notes` / `.note-check` (search the file for the palette tokens in use — e.g. `--ink-1`, `--accent`, `--surface-2` — and match them). Do not introduce new raw hex.

- [ ] **Step 2: Verify typecheck passes**

Run: `npm run typecheck`
Expected: no new errors (CSS isn't typechecked, but confirm nothing else regressed).

- [ ] **Step 3: Commit**

```bash
git add src/styles/dashboard.css
git commit -m "Helper notes: styling for actions, kept stripe, composer, Focus block"
```

- [ ] **Step 4: USER browser smoke (flag, do not verify yourself)**

Tell Moran to hard-refresh and confirm the notes look right in both Daily and Focus — kept notes have the accent stripe, the action buttons read clearly, the compose box and Copy prompt sit inline, nothing pulses.

---

## Task 9: MCP — tie new notes to a work item

**Files:**
- Modify: `mcp/server.ts:2195-2206` (the `helper_note_add` tool)

- [ ] **Step 1: Add the optional `workItemId` param**

Replace the `helper_note_add` registration (lines 2195-2206):

```typescript
server.registerTool(
  'helper_note_add',
  {
    title: "Add a nudge to the helper's notes",
    description:
      "Drop a single short nudge into Moran's notes space — something you noticed worth his attention (an estimate that looks low, tasks gone quiet, a good day for deep work). Plain, casual English, one thought per note. When the nudge is about a specific task or story, pass its id as workItemId so it also shows up in Focus mode while he's on that work. He ticks these off himself once handled, so only add things that are genuinely actionable or worth seeing.",
    inputSchema: {
      body: z.string().min(1).describe('One short, casual, plain-English nudge.'),
      workItemId: z
        .number()
        .int()
        .positive()
        .optional()
        .describe('The Azure DevOps id this nudge is about, if any, so Focus can surface it.'),
    },
  },
  async ({ body, workItemId }) => jsonResult(addNote(body, workItemId ?? null)),
);
```

- [ ] **Step 2: Verify typecheck passes**

Run: `npm run typecheck`
Expected: no new errors.

- [ ] **Step 3: Commit**

```bash
git add mcp/server.ts
git commit -m "MCP helper_note_add: optional workItemId to tie a nudge to a task"
```

- [ ] **Step 4: USER reload smoke (flag, do not verify yourself)**

Tell Moran the MCP change needs `/exit` + `claude --resume` in his work chats before a new nudge can carry a work item id. Don't claim verification.

---

## Task 10: Final check + handoff

- [ ] **Step 1: Full typecheck + tests**

Run: `npm run typecheck && npm test`
Expected: typecheck clean of new errors; all tests green (66 prior + 4 helper-notes + 3 notePrompt = 73).

- [ ] **Step 2: Confirm the tree is committed**

Run: `git status`
Expected: clean working tree; the helper-notes commits present in `git log --oneline -10`.

- [ ] **Step 3: Write the USER smoke summary**

Produce a short plain-English list for Moran of exactly what to check, separating what's already verified (the unit tests) from what needs his eyes/reload:
- Browser hard-refresh (Daily + Focus): the three actions, per-note age, summary age, kept stripe, Copy prompt, Focus-only relevant notes.
- `/exit` + `claude --resume`: new nudges can carry a work item id.
- Note that pushing the stack remains his call.

Do **not** auto-update memory — wait for Moran's "looks right" signal.

---

## Self-Review

**Spec coverage:**
- Three actions (Act/Keep/Done) → Task 6 (`NoteRow`). ✓
- Act-on-it prompt with optional line, clipboard → Task 5 (builder) + Task 6 (compose + copy). ✓
- Keep = pin covering save+highlight, kept-first, accent stripe → Tasks 2, 6, 8. ✓
- Per-note age + summary age relocated → Task 6. ✓
- Notes in Focus filtered to focal task/story + kept → Task 7. ✓
- work_item_id data + populated by stale nudge + MCP param → Tasks 1, 2, 9. ✓
- Summary-refresh behavior explicitly out of scope → not built (correct). ✓

**Placeholder scan:** No TBD/TODO; every code step shows full code. Task 7 step 3 and Task 8 step 1 contain conditional "match the existing name / variable" guidance — these are deliberate, because the surrounding `R21Focus` refresh-prop name and the CSS palette tokens are established by existing code the implementer can read; the fallback instruction is explicit, not a hand-wave.

**Type consistency:** `HelperNote`/`ApiHelperNote` carry `pinnedAt: string | null` and `workItemId: number | null` everywhere (Tasks 2, 4). `addNote(body, workItemId?)` signature matches its callers in Task 2 (stale nudge) and Task 9 (MCP). `buildNotePrompt(body, extra)` signature matches its test (Task 5) and call site (Task 6). Endpoint returns `{ ok }`, read by `postNoteAction` (Task 4). Consistent.
