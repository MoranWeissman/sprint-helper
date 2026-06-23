# Carry-forward banner — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Daily banner that one-tap moves open tasks stranded in a previous sprint into the current one, so carried-over work reappears on Daily without using the Plan page.

**Architecture:** A new WIQL query finds the user's open Tasks not in the current sprint; the shared iteration classifier keeps only those in a real *previous sprint* (not backlog/year/quarter). `buildDashboard` attaches a `carryForward` summary to the payload. A `POST /api/carry-forward` endpoint bulk-moves the tasks via the existing `setIterationPath`. A Daily banner shows the count and fires the move.

**Tech Stack:** TypeScript, @modelcontextprotocol/sdk backend, Vite middleware API, React 18 dashboard, Vitest 4.

**Spec:** `docs/superpowers/specs/2026-06-23-carryforward-banner-design.md`

---

### Task 1: Export the iteration classifier for reuse

`classifyIterationLevel` and `isSprintLevel` are module-private in `server/planning-cockpit.ts`. The banner needs the same path rules (to keep only real previous-sprint tasks, excluding backlog/year/quarter). Export them so they're shared, not duplicated.

**Files:**
- Modify: `server/planning-cockpit.ts` (the `function classifyIterationLevel` ~line 240 and `function isSprintLevel` just below it)
- Test: `server/iteration-classify.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `server/iteration-classify.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { classifyIterationLevel, isSprintLevel } from './planning-cockpit';

describe('classifyIterationLevel', () => {
  it('classifies the tree levels', () => {
    expect(classifyIterationLevel('IDP - DevOps')).toBe('backlog');
    expect(classifyIterationLevel('IDP - DevOps\\Backlog')).toBe('backlog');
    expect(classifyIterationLevel('IDP - DevOps\\2026')).toBe('year');
    expect(classifyIterationLevel('IDP - DevOps\\2026\\Q2')).toBe('quarter');
    expect(classifyIterationLevel('IDP - DevOps\\2026\\Q2\\26_12')).toBe('sprint');
    expect(classifyIterationLevel('')).toBe(null);
  });

  it('isSprintLevel is true only for a concrete named sprint', () => {
    expect(isSprintLevel('IDP - DevOps\\2026\\Q2\\26_12')).toBe(true);
    expect(isSprintLevel('IDP - DevOps\\2026')).toBe(false);
    expect(isSprintLevel('IDP - DevOps\\Backlog')).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run server/iteration-classify.test.ts`
Expected: FAIL — `classifyIterationLevel is not exported` (import error).

- [ ] **Step 3: Add `export` to both functions**

In `server/planning-cockpit.ts`, change `function classifyIterationLevel(` to `export function classifyIterationLevel(` and `function isSprintLevel(` to `export function isSprintLevel(`. No body changes.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run server/iteration-classify.test.ts`
Expected: PASS (2 tests). Then `npx tsc -b` → exit 0.

- [ ] **Step 5: Commit**

```bash
git add server/planning-cockpit.ts server/iteration-classify.test.ts
git commit -m "refactor: export iteration classifier for reuse"
```

---

### Task 2: Query open tasks not in the current sprint

New `listMyOpenTasksNotInSprint` in `server/ado.ts`, mirroring `listMyOpenStoriesNotInSprint` (lines 466-484) but for `Task`.

**Files:**
- Modify: `server/ado.ts` (add after `listMyOpenStoriesNotInSprint`, ~line 484)
- Test: covered indirectly by Task 4's dashboard test (the WIQL builder has no pure seam to unit-test without the fake ado client; the existing repo doesn't unit-test individual WIQL builders either). No standalone test.

- [ ] **Step 1: Add the function**

In `server/ado.ts`, immediately after `listMyOpenStoriesNotInSprint`:

```ts
/**
 * All open Tasks assigned to @Me that are NOT in the given sprint iteration
 * path. Used by the Daily carry-forward banner to find tasks left behind in a
 * previous sprint. Mirrors listMyOpenStoriesNotInSprint but for Task type.
 * Caller classifies the iteration path (a task in backlog/year/quarter is not
 * carry-over) — this just returns every open out-of-sprint task.
 */
export async function listMyOpenTasksNotInSprint(currentSprintPath: string): Promise<WorkItem[]> {
  const cfg = await loadAdoConfig();
  const fieldList = WORK_ITEM_FIELDS.map(f => `[${f}]`).join(', ');
  const wiql = [
    `SELECT ${fieldList} FROM WorkItems`,
    `WHERE [System.AssignedTo] = @Me`,
    `  AND [System.WorkItemType] = 'Task'`,
    `  AND [System.State] NOT IN ('Done', 'Closed', 'Resolved', 'Completed', 'Removed', 'Canceled', 'Cancelled', 'Cut')`,
    `  AND [System.IterationPath] <> '${escapeWiql(currentSprintPath)}'`,
    'ORDER BY [System.IterationPath], [System.ChangedDate] DESC',
  ].join(' ');
  const raw = await getAdoClient().queryWorkItems({
    wiql,
    fields: WORK_ITEM_FIELDS,
    organization: cfg.organization,
    project: cfg.project,
  });
  return raw.map(w => mapWorkItem(w));
}
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc -b`
Expected: exit 0. (Confirms `escapeWiql`, `WORK_ITEM_FIELDS`, `mapWorkItem`, `getAdoClient`, `loadAdoConfig` are all in scope — they're used by the sibling function directly above.)

- [ ] **Step 3: Commit**

```bash
git add server/ado.ts
git commit -m "feat: listMyOpenTasksNotInSprint query"
```

---

### Task 3: Compute the `carryForward` summary (pure helper)

A pure function that turns the raw out-of-sprint tasks into the banner summary, filtering to real previous-sprint tasks. Pure = unit-testable without Azure.

**Files:**
- Modify: `server/dashboard.ts` (add the type to the payload interface + a pure `summarizeCarryForward` helper near `buildTaskMeta`)
- Test: `server/carryforward.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `server/carryforward.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { summarizeCarryForward } from './dashboard';
import type { WorkItem } from './ado';

function task(id: number, iterationPath: string): WorkItem {
  return {
    id, rev: 1, type: 'Task', title: `#${id}`, state: 'New',
    assignedTo: 'me', iterationPath, areaPath: 'A',
    changedDate: '2026-06-23T00:00:00Z',
    url: `https://x/_apis/wit/workItems/${id}`,
  } as WorkItem;
}

describe('summarizeCarryForward', () => {
  it('returns null when no tasks are stranded', () => {
    expect(summarizeCarryForward([])).toBeNull();
  });

  it('keeps only tasks in a real previous sprint, not backlog/year/quarter', () => {
    const tasks = [
      task(1, 'IDP - DevOps\\2026\\Q2\\26_12'), // sprint — counts
      task(2, 'IDP - DevOps\\2026\\Q2\\26_12'), // sprint — counts
      task(3, 'IDP - DevOps\\2026'),            // year — excluded
      task(4, 'IDP - DevOps\\Backlog'),         // backlog — excluded
    ];
    const r = summarizeCarryForward(tasks);
    expect(r).not.toBeNull();
    expect(r!.count).toBe(2);
    expect(r!.taskIds.sort()).toEqual([1, 2]);
    expect(r!.fromSprintLabel).toBe('26_12');
  });

  it('returns null when every stranded task is backlog-level', () => {
    expect(summarizeCarryForward([task(9, 'IDP - DevOps\\2026')])).toBeNull();
  });

  it('labels by the most common sprint when tasks span several', () => {
    const tasks = [
      task(1, 'IDP - DevOps\\2026\\Q2\\26_12'),
      task(2, 'IDP - DevOps\\2026\\Q2\\26_12'),
      task(3, 'IDP - DevOps\\2026\\Q1\\26_11'),
    ];
    const r = summarizeCarryForward(tasks);
    expect(r!.count).toBe(3);
    expect(r!.fromSprintLabel).toBe('26_12'); // most common
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run server/carryforward.test.ts`
Expected: FAIL — `summarizeCarryForward is not exported`.

- [ ] **Step 3: Add the type + helper**

In `server/dashboard.ts`, add the import for the classifier near the other `./planning-cockpit` usages (or add a new import line):

```ts
import { isSprintLevel } from './planning-cockpit';
```

Add this interface beside the other payload types (near `TaskMetaEntry`, ~line 217):

```ts
export interface CarryForwardSummary {
  /** Open tasks stranded in a previous sprint, ready to pull into the current one. */
  taskIds: number[];
  /** taskIds.length — convenience for the banner copy. */
  count: number;
  /** The sprint label most stranded tasks sit in, e.g. "26_12". */
  fromSprintLabel: string;
}
```

Add this pure helper near `buildTaskMeta`:

```ts
/**
 * Turn the raw "my open tasks not in the current sprint" list into the banner
 * summary. Keeps only tasks whose iteration path is a real PREVIOUS sprint —
 * backlog / year / quarter items are scheduling, not carry-over, and stay on
 * the Plan page. Returns null when nothing qualifies (banner renders nothing).
 */
export function summarizeCarryForward(outOfSprintTasks: WorkItem[]): CarryForwardSummary | null {
  const stranded = outOfSprintTasks.filter(t => isSprintLevel(t.iterationPath));
  if (stranded.length === 0) return null;

  // Label by the most common sprint (last path segment), so copy reads
  // "N tasks from 26_12" even when a few straggle in from an older sprint.
  const counts = new Map<string, number>();
  for (const t of stranded) {
    const label = t.iterationPath.split('\\').filter(Boolean).pop() ?? t.iterationPath;
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  let fromSprintLabel = '';
  let best = -1;
  for (const [label, n] of counts) {
    if (n > best) { best = n; fromSprintLabel = label; }
  }

  return { taskIds: stranded.map(t => t.id), count: stranded.length, fromSprintLabel };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run server/carryforward.test.ts`
Expected: PASS (4 tests). Then `npx tsc -b` → exit 0.

- [ ] **Step 5: Commit**

```bash
git add server/dashboard.ts server/carryforward.test.ts
git commit -m "feat: summarizeCarryForward — banner summary from stranded tasks"
```

---

### Task 4: Wire `carryForward` into the dashboard payload

Call the query in `buildDashboard`, run it through `summarizeCarryForward`, attach to the payload. Best-effort: a query failure leaves `carryForward: null`.

**Files:**
- Modify: `server/dashboard.ts` (`DashboardPayload` interface; the empty-sprint early-return; the main build path; the import from `./ado`)
- Test: none new (the wiring is glue; the pure logic is covered by Task 3, and the query by manual smoke). The existing suite must stay green.

- [ ] **Step 1: Add `carryForward` to the payload interface**

In `server/dashboard.ts`, in the `DashboardPayload` interface, add (near `standup`):

```ts
  /** Open tasks left behind in a previous sprint, for the Daily carry-forward banner. Null when none. */
  carryForward: CarryForwardSummary | null;
```

- [ ] **Step 2: Add the import**

Add `listMyOpenTasksNotInSprint` to the existing `from './ado'` import block (alongside `getMyWorkItems`, `getWorkItemsWithParents`, etc.).

- [ ] **Step 3: Set it in the empty-sprint early return**

In `buildDashboard`, the early `return` used when there's no iteration (the block that returns `workItems: { inProgress: [], … }`) must include the new required field:

```ts
      carryForward: null,
```

- [ ] **Step 4: Compute it in the main build path**

In `buildDashboard`, after `const standup = buildStandup({ taskMeta });` (and before the final `return`), add:

```ts
  // Open tasks left behind in a previous sprint — the Daily banner offers to
  // pull them into the current one. Best-effort: a query failure must not break
  // the dashboard, so fall back to null (no banner).
  let carryForward: CarryForwardSummary | null = null;
  try {
    const outOfSprintTasks = await listMyOpenTasksNotInSprint(iteration.path);
    carryForward = summarizeCarryForward(outOfSprintTasks);
  } catch {
    carryForward = null;
  }
```

Then add `carryForward,` to the object in the final `return`.

- [ ] **Step 5: Verify**

Run: `npx tsc -b` (expect 0) and `npm test` (expect all prior tests still pass — no handler is unit-tested, so the suite count rises only by Task 1+3's tests).

- [ ] **Step 6: Commit**

```bash
git add server/dashboard.ts
git commit -m "feat: attach carryForward summary to dashboard payload"
```

---

### Task 5: The bulk-move API endpoint

`POST /api/carry-forward` in the Vite middleware. Moves each task into the current sprint via the existing `setIterationPath`. Per-id failures are collected, never abort the batch.

**Files:**
- Modify: `vite.config.ts` (add a route alongside the other `/api/*` handlers; mirror the existing `/api/workitem/<id>/edit` POST that already calls `setIterationPath`)

- [ ] **Step 1: Read the existing edit route**

Read `vite.config.ts` around the `/api/workitem/` and helper-note POST handlers to copy the exact pattern: how the body is read, how the current iteration path is resolved (there's an existing `getCurrentIteration`/iteration lookup), how JSON is returned, and how `invalidateDashboardCache` is imported/called.

- [ ] **Step 2: Add the route**

Add a `POST /api/carry-forward` handler that:
1. Reads `{ taskIds: number[] }` from the request body (reuse the file's existing JSON-body reader).
2. Resolves the current sprint path server-side via the same iteration lookup the dashboard uses (`getCurrentIteration()` → `.path`). If there's no current sprint, respond `400` with `{ error: 'No active sprint.' }`.
3. For each id, `await setIterationPath(id, currentPath)` inside a try/catch; on throw, push the id to `failed[]`, else increment `moved`.
4. `invalidateDashboardCache()`.
5. Respond `{ moved, failed }`.

Exact code (adapt import paths/body-reader to match the file's existing style found in Step 1):

```ts
if (req.method === 'POST' && req.url === '/api/carry-forward') {
  try {
    const body = await readJsonBody(req); // reuse the file's existing body reader
    const taskIds: number[] = Array.isArray(body?.taskIds) ? body.taskIds : [];
    const { getCurrentIteration } = await import('./server/ado');
    const { setIterationPath } = await import('./server/writes');
    const { invalidateDashboardCache } = await import('./server/dashboard-cache');
    const iteration = await getCurrentIteration();
    if (!iteration) {
      res.statusCode = 400;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: 'No active sprint.' }));
      return;
    }
    let moved = 0;
    const failed: number[] = [];
    for (const id of taskIds) {
      try {
        await setIterationPath(id, iteration.path);
        moved += 1;
      } catch {
        failed.push(id);
      }
    }
    invalidateDashboardCache();
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ moved, failed }));
  } catch (e) {
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }));
  }
  return;
}
```

- [ ] **Step 3: Typecheck**

Run: `npx tsc -b`
Expected: exit 0.

- [ ] **Step 4: Commit**

```bash
git add vite.config.ts
git commit -m "feat: POST /api/carry-forward — bulk-move stranded tasks"
```

---

### Task 6: The Daily banner UI

A banner above "Your stories" that renders when `carryForward != null`, taps to call the endpoint, then refreshes.

**Files:**
- Modify: `src/lib/api.ts` (add `carryForward` to the payload type + a `postCarryForward(taskIds)` helper)
- Modify: `src/components/Dashboard.tsx` (render the banner in the Daily body, above the feature list)
- Modify: `src/styles/dashboard.css` (banner styles)

- [ ] **Step 1: Extend the API client type + helper**

In `src/lib/api.ts`, add to the dashboard payload type (mirror the server `CarryForwardSummary`):

```ts
carryForward: { taskIds: number[]; count: number; fromSprintLabel: string } | null;
```

Add a helper near the other POST helpers (e.g. `postNoteAction`):

```ts
export async function postCarryForward(taskIds: number[]): Promise<{ moved: number; failed: number[] }> {
  const res = await fetch('/api/carry-forward', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ taskIds }),
  });
  if (!res.ok) throw new Error(`carry-forward failed: ${res.status}`);
  return (await res.json()) as { moved: number; failed: number[] };
}
```

- [ ] **Step 2: Render the banner**

In `src/components/Dashboard.tsx`, in the Daily body just above the `<div className="r21-daily-features">` block (the "Your stories" list), add a banner component. It needs the dashboard refresh function already threaded for note actions (`onRefresh`); reuse it. Component:

```tsx
function CarryForwardBanner({
  info,
  onDone,
}: {
  info: { taskIds: number[]; count: number; fromSprintLabel: string };
  onDone: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const pull = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await postCarryForward(info.taskIds);
      if (r.failed.length > 0) {
        setError(`Couldn't move ${r.failed.length} — open them in Azure DevOps.`);
      }
      onDone(); // refresh the dashboard; banner re-renders from fresh data
    } catch {
      setError('Something went wrong — try again, or use the Plan page.');
    } finally {
      setBusy(false);
    }
  };

  const noun = info.count === 1 ? 'task' : 'tasks';
  return (
    <section className="r21-carryforward" aria-label="Unfinished work from last sprint">
      <div className="r21-carryforward-text">
        <strong>{info.count} unfinished {noun} from {info.fromSprintLabel}</strong>
        <span>These didn't get finished last sprint. Pull them in so they're on your board.</span>
        {error && <span className="r21-carryforward-error">{error}</span>}
      </div>
      <button type="button" className="r21-carryforward-btn" onClick={pull} disabled={busy}>
        {busy ? 'Pulling…' : 'Pull them into this sprint'}
      </button>
    </section>
  );
}
```

Render it (only when present) right before the features list:

```tsx
{data.carryForward && (
  <CarryForwardBanner info={data.carryForward} onDone={onRefresh} />
)}
```

Confirm `onRefresh` (or the equivalent refresh callback used by the note Act/Keep/Done actions) is in scope at that point; if the Daily body is a child component, thread the same prop the notes already use. Do NOT invent a new refresh mechanism — reuse the existing one.

- [ ] **Step 3: Add styles**

In `src/styles/dashboard.css`, add calm styles consistent with the dark/warm palette and the "no small-and-gray" rule (the banner is an action cue — it should read clearly, one accent, not a faded afterthought):

```css
.r21-carryforward {
  display: flex; align-items: center; justify-content: space-between; gap: 16px;
  padding: 14px 18px; margin-bottom: 16px;
  background: var(--bg-2);
  border: 1px solid var(--line-soft);
  border-left: 4px solid var(--st-waiting);
  border-radius: 8px;
}
.r21-carryforward-text { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
.r21-carryforward-text strong { color: var(--ink-1); font-size: 15px; }
.r21-carryforward-text span { color: var(--ink-2); font-size: 13px; }
.r21-carryforward-error { color: var(--blocked-line-strong) !important; }
.r21-carryforward-btn {
  flex: none; padding: 9px 16px; border-radius: 6px;
  background: var(--accent); color: var(--accent-ink, #fff);
  border: none; font-weight: 600; font-size: 13px; cursor: pointer;
  transition: opacity 140ms ease;
}
.r21-carryforward-btn:hover { opacity: 0.9; }
.r21-carryforward-btn:disabled { opacity: 0.5; cursor: default; }
.r21-carryforward-btn:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
```

Verify the CSS variables used (`--accent`, `--st-waiting`, `--ink-1/2`, `--line-soft`, `--bg-2`, `--blocked-line-strong`) exist in the stylesheet; if a name differs, match the existing tokens (check `:root` in `dashboard.css`).

- [ ] **Step 4: Verify**

Run: `npx tsc -b` (expect 0) and `npm test` (expect all green). The banner itself is view code — visually smoke-tested by the user.

- [ ] **Step 5: Commit**

```bash
git add src/lib/api.ts src/components/Dashboard.tsx src/styles/dashboard.css
git commit -m "feat: Daily carry-forward banner"
```

---

### Task 7: Full verification + smoke handoff

**Files:** none (verification only)

- [ ] **Step 1: Whole suite**

Run: `npm test` → all pass. `npx tsc -b` → exit 0.

- [ ] **Step 2: Confirm the live API shape**

With the dashboard dev server running, `curl -s http://localhost:7777/api/dashboard` and confirm a `carryForward` field is present (it will be populated now, since the user has open tasks stranded in 26_12). Confirm `taskIds`/`count`/`fromSprintLabel` look right.

- [ ] **Step 3: Hand the smoke test to the user**

Tell the user: after a dashboard refresh, the banner should show on Daily ("N unfinished tasks from 26_12"). Tapping it should move those tasks into 26_13, the banner should vanish, and the parent stories should appear in "Your stories". Confirm on the real board that only tasks moved and the stories stayed in their original sprint. This is the live confirmation; the API + pure logic are unit-covered, the endpoint + banner are glue/view.

---

## Notes for the implementer

- Reuse, don't reinvent: `setIterationPath` already moves tasks and already protects started stories — the endpoint just calls it per id. `classifyIterationLevel`/`isSprintLevel` already encode the path rules — Task 1 exports them; don't write new path parsing.
- The refresh after a successful pull MUST use the dashboard's existing refresh callback (the one the helper-note Act/Keep/Done actions already use). Find it before writing Task 6 Step 2; do not add a second refresh path.
- Plain-English UI: no "carry-over", "WIP", "backlog", "scope" in user-facing copy. The banner says "unfinished tasks from {sprint}".
- The story is never moved or reopened by this flow — tasks only. (Confirmed with the user 2026-06-23.)
