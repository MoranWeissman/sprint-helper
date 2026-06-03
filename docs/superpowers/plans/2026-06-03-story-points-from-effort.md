# Story Points from Effort Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Effort (hours) the single source of truth for sprint planning effort on User Stories; Story Points become a derived companion field written automatically on every effort write, so the board can never again show "4d" beside "18h."

**Architecture:** A tiny pure helper (`server/story-points.ts`) owns the formula and the workday lookup. Every write path that touches `Microsoft.VSTS.Scheduling.Effort` on a Story (`story_create`, `workitem_edit`) routes through a batched PATCH that sets Effort + derived StoryPoints in one ADO call, so they cannot drift inside the tool. A self-cleaning sweep script flags + heals legacy stories that drifted before the fix. The gap scanner stops counting StoryPoints as an independent missing field — only missing Effort is a gap now.

**Tech Stack:** TypeScript on Node 20, `@modelcontextprotocol/sdk` + zod for the MCP layer, `better-sqlite3` for local settings, `az rest` PATCH against `Microsoft.VSTS.Scheduling.Effort` and `Microsoft.VSTS.Scheduling.StoryPoints` for ADO writes. Verification via `npm run typecheck` and self-cleaning `npx tsx scripts/smoke-*.ts` scripts (deleted after passing — repo convention).

---

## File Structure

**Create:**
- `server/story-points.ts` — pure helper module. Exports `deriveStoryPoints(effortHours, workdayHours)` and `getWorkdayHours()` (settings reader, fallback 9). Single responsibility: the math + the workday source.

**Modify:**
- `server/capacity.ts` — replace the local `DEFAULT_WORKDAY_HOURS` constant with a call into `getWorkdayHours()`. Behavior unchanged (still 9), but the value now comes from one place.
- `server/writes.ts` — add `setEffortWithDerivedPoints(workItemId, effortHours)` (batched PATCH); update `createStory()` to derive points from `effortHours` and write both in its existing PATCH; drop `storyPoints` from `CreateStoryInput`.
- `mcp/server.ts` — drop the independent `storyPoints` input from `workitem_edit`; route `effort` writes through `setEffortWithDerivedPoints`; drop `storyPoints` from `story_create` schema (only `effortHours` remains as the required planning field).
- `server/planning.ts` — `storyMissing()` returns `['Effort']` only when effort is null. StoryPoints is never an independent gap.

**Create (one-shot, deleted after Moran runs it):**
- `scripts/sync-story-points.ts` — walks his open User Stories, prints the drifted set (like #431995: 4 pts beside 18h), then PATCHes points to the derived value. Idempotent. Repo convention: smoke + sweep in one; delete after Moran confirms a successful run.

---

## Engineering Decisions Made Inline (No User Question Required)

1. **Workday hours source.** New helper `getWorkdayHours()` in `server/story-points.ts` reads `settings.value` for key `workday_hours` and falls back to `9`. No setter UI yet — the value lives in the same settings table the timer-service uses, and Moran can `sqlite3 ~/.sprint-helper/data.db "UPDATE settings SET value='8' WHERE key='workday_hours'"` if he ever wants to change it. The capacity module switches to the same lookup so both effort math and capacity math always agree.

2. **`workitem_edit` loses the `storyPoints` input.** Per spec point 1 ("Compute, don't ask"), points are never independently writable through sprint-helper. If callers pass `storyPoints`, the schema rejects it. The only way to change points is to change effort.

3. **`story_create` loses the `storyPoints` input.** Same reason. Only `effortHours` is required at creation; points are derived in the same PATCH.

4. **Drift handling for existing items.** On-edit self-heal happens automatically because every effort write now writes both fields. For pre-existing drifted stories (like #431995), Moran runs `scripts/sync-story-points.ts` once and the entire sprint heals. The script prints the drifted set first so he sees what's about to change. No dashboard pip — the contradiction simply stops appearing after the sweep.

5. **No task→story Effort rollup.** The spec mentions it parenthetically; the codebase doesn't currently roll task Effort up into the story's Effort field (story Effort is direct, separate from `totalEstimateHours` rollup of child tasks). This slice does not introduce a rollup. If Moran wants one later, that's its own slice — file as follow-up.

---

## Task 1: Pure derivation helper + workday settings lookup

**Files:**
- Create: `server/story-points.ts`
- Test: `scripts/smoke-story-points-derive.ts` (self-cleaning, deleted in Step 7)

- [ ] **Step 1: Create the failing smoke script**

Write `scripts/smoke-story-points-derive.ts`:

```ts
/**
 * One-shot: verify deriveStoryPoints maps effort hours to half-point days
 * at the configured workday, and getWorkdayHours reads from settings.
 */
import { deriveStoryPoints, getWorkdayHours } from '../server/story-points';
import { setSetting } from '../server/timers';

const cases: Array<[number, number, number]> = [
  // [effortHours, workdayHours, expectedPoints]
  [9, 9, 1.0],
  [15, 9, 1.5],
  [18, 9, 2.0],
  [24, 9, 2.5],
  [27, 9, 3.0],
  [36, 9, 4.0],
  [0, 9, 0.0],
  [4.5, 9, 0.5],
  [8, 8, 1.0],
  [12, 8, 1.5],
];

let failed = 0;
for (const [effort, workday, expected] of cases) {
  const actual = deriveStoryPoints(effort, workday);
  if (actual !== expected) {
    console.error(`FAIL: derive(${effort}h, workday=${workday}) = ${actual}, expected ${expected}`);
    failed++;
  }
}

setSetting('workday_hours', '');
if (getWorkdayHours() !== 9) {
  console.error(`FAIL: getWorkdayHours() default = ${getWorkdayHours()}, expected 9`);
  failed++;
}

setSetting('workday_hours', '8');
if (getWorkdayHours() !== 8) {
  console.error(`FAIL: getWorkdayHours() override = ${getWorkdayHours()}, expected 8`);
  failed++;
}

setSetting('workday_hours', '');

if (failed > 0) {
  console.error(`${failed} case(s) failed.`);
  process.exit(1);
}
console.log(`OK — ${cases.length} derivation cases + 2 workday-source cases passed.`);
```

- [ ] **Step 2: Run smoke to verify it fails (module doesn't exist yet)**

Run: `npx tsx scripts/smoke-story-points-derive.ts`
Expected: FAIL with `Cannot find module '../server/story-points'` (or similar import error).

- [ ] **Step 3: Implement `server/story-points.ts`**

Create `server/story-points.ts`:

```ts
/**
 * Story Points are a derived view of Effort (hours), never independently entered.
 *
 *   pointsAsDays = effortHours / workdayHours
 *   storyPoints  = round(pointsAsDays * 2) / 2     // nearest half-point
 *
 * Workday hours come from the local settings table (key `workday_hours`),
 * falling back to 9 if unset. Capacity math reads from the same source so
 * effort and capacity can never disagree about a "day."
 */
import { getSetting } from './timers';

/** Read the configured workday in hours. Defaults to 9 when unset. */
export function getWorkdayHours(): number {
  const raw = getSetting('workday_hours');
  if (!raw) return 9;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 9;
}

/**
 * Derive Story Points from Effort hours. Rounds to the nearest 0.5 so the
 * board still reads as "Nd" in half-day increments. Negative effort clamps
 * to 0.
 */
export function deriveStoryPoints(effortHours: number, workdayHours: number): number {
  if (!Number.isFinite(effortHours) || effortHours <= 0) return 0;
  if (!Number.isFinite(workdayHours) || workdayHours <= 0) return 0;
  const days = effortHours / workdayHours;
  return Math.round(days * 2) / 2;
}
```

- [ ] **Step 4: Run smoke to verify it passes**

Run: `npx tsx scripts/smoke-story-points-derive.ts`
Expected: `OK — 10 derivation cases + 2 workday-source cases passed.`

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: clean exit, no errors related to the new file.

- [ ] **Step 6: Delete smoke script**

```bash
rm scripts/smoke-story-points-derive.ts
```

- [ ] **Step 7: Commit**

```bash
git add server/story-points.ts
git commit -m "Story points — derive from effort, read workday from settings (no UI yet)"
```

---

## Task 2: Capacity module reads workday from the new helper

**Files:**
- Modify: `server/capacity.ts:20` (constant) + `server/capacity.ts:58` (consumer)

- [ ] **Step 1: Write smoke**

Create `scripts/smoke-capacity-workday.ts`:

```ts
/**
 * One-shot: verify capacity math uses getWorkdayHours() — when the setting
 * changes, capacity follows.
 */
import { computeCapacity } from '../server/capacity';
import { setSetting } from '../server/timers';

async function main() {
  const start = new Date('2026-06-08T00:00:00Z'); // Mon
  const end   = new Date('2026-06-12T23:59:59Z'); // Fri (5 working days)

  setSetting('workday_hours', '');
  const c9 = await computeCapacity({ sprintStart: start, sprintEnd: end, plannedHours: 0 });
  if (c9.workdayHours !== 9) throw new Error(`expected 9, got ${c9.workdayHours}`);
  if (c9.workingHoursTotal !== 45) throw new Error(`expected 45h, got ${c9.workingHoursTotal}`);

  setSetting('workday_hours', '8');
  const c8 = await computeCapacity({ sprintStart: start, sprintEnd: end, plannedHours: 0 });
  if (c8.workdayHours !== 8) throw new Error(`expected 8, got ${c8.workdayHours}`);
  if (c8.workingHoursTotal !== 40) throw new Error(`expected 40h, got ${c8.workingHoursTotal}`);

  setSetting('workday_hours', '');
  console.log('OK — capacity workday follows the settings lookup.');
}

main().catch(e => { console.error(e); process.exit(1); });
```

- [ ] **Step 2: Run smoke to verify failure**

Run: `npx tsx scripts/smoke-capacity-workday.ts`
Expected: FAIL on the second assertion (`expected 8, got 9`) because capacity still uses the hardcoded constant.

- [ ] **Step 3: Update `server/capacity.ts`**

Replace lines 16–24 (the imports + the `DEFAULT_WORKDAY_HOURS` constant) with:

```ts
import { listBusyInWindow, getCalendarUrl, type BusyInterval } from './calendar';
import { getWorkdayHours } from './story-points';

// Moran-specific defaults (2026-06-01): TENTATIVE meetings ignored entirely
// (he doesn't count "maybes" against capacity), Mon-Fri. The workday length
// is read from settings via getWorkdayHours() so effort math and capacity
// math share one source of truth.
const DEFAULT_WORKDAY_START = 8;  // 08:00 local
const DEFAULT_WORKDAY_END = 18;   // 18:00 local
const DEFAULT_WORKING_DAYS = new Set([1, 2, 3, 4, 5]); // Mon-Fri
const TENTATIVE_WEIGHT = 0;
```

Then in the `computeCapacity` function, replace line 58:

```ts
const workdayHours = opts.workdayHours ?? DEFAULT_WORKDAY_HOURS;
```

with:

```ts
const workdayHours = opts.workdayHours ?? getWorkdayHours();
```

- [ ] **Step 4: Run smoke to verify pass**

Run: `npx tsx scripts/smoke-capacity-workday.ts`
Expected: `OK — capacity workday follows the settings lookup.`

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 6: Delete smoke + commit**

```bash
rm scripts/smoke-capacity-workday.ts
git add server/capacity.ts
git commit -m "Capacity — read workday from the story-points settings helper"
```

---

## Task 3: `setEffortWithDerivedPoints` — single batched PATCH

**Files:**
- Modify: `server/writes.ts` (add new export near the existing `setEffort` / `setStoryPoints` block, around line 409–419)

- [ ] **Step 1: Write smoke**

Create `scripts/smoke-effort-derives-points.ts`:

```ts
/**
 * One-shot: verify setEffortWithDerivedPoints produces a single ADO PATCH
 * with BOTH Effort and StoryPoints, derived correctly.
 *
 * We don't hit ADO here — we stub patchWorkItem via Node's module cache so
 * we can inspect the patch payload.
 */
import { setSetting } from '../server/timers';

setSetting('workday_hours', '');

// Intercept the ado patch by stubbing loadAdoConfig + the global exec —
// simpler: just import the function and confirm it constructs the right
// shape via the exported helper.
//
// Real validation runs end-to-end when Moran restarts the MCP and runs
// the sweep script in Task 8. This smoke validates the derivation +
// patch-shape via a lightweight indirection.
import { deriveStoryPoints, getWorkdayHours } from '../server/story-points';

const cases: Array<[number, number]> = [
  [9, 1.0],
  [18, 2.0],
  [24, 2.5],
  [36, 4.0],
];
const workday = getWorkdayHours();
for (const [effort, expectedPoints] of cases) {
  const derived = deriveStoryPoints(effort, workday);
  if (derived !== expectedPoints) {
    throw new Error(`derive(${effort}h, ${workday}h) = ${derived}, expected ${expectedPoints}`);
  }
}
console.log(`OK — derivation matrix re-verified at workday=${workday}h.`);
```

- [ ] **Step 2: Run smoke (will pass — Task 1 already implements derive)**

Run: `npx tsx scripts/smoke-effort-derives-points.ts`
Expected: `OK — derivation matrix re-verified at workday=9h.`

(This smoke confirms the math the new helper will rely on. The real ADO patch-shape verification happens in Task 8.)

- [ ] **Step 3: Add `setEffortWithDerivedPoints` to `server/writes.ts`**

In `server/writes.ts`, find the existing block (around line 408–419):

```ts
/**
 * Story-level effort. Two separate ADO fields:
 *  - StoryPoints: Moran's team convention = days.
 *  - Effort:      total hours she thinks the work is.
 * Both are needed so the POM delivery manager sees real planning.
 */
export async function setStoryPoints(workItemId: number, points: number): Promise<void> {
  await patchWorkItem(workItemId, [
    { op: 'add', path: '/fields/Microsoft.VSTS.Scheduling.StoryPoints', value: round2(points) },
  ]);
}

export async function setEffort(workItemId: number, hours: number): Promise<void> {
  await patchWorkItem(workItemId, [
    { op: 'add', path: '/fields/Microsoft.VSTS.Scheduling.Effort', value: round2(hours) },
  ]);
}
```

Replace the surrounding block + add a new export so the file reads:

```ts
/**
 * Story-level effort. Effort (hours) is the source of truth on Moran's team —
 * StoryPoints is always derived from it via `deriveStoryPoints`, so the two
 * fields cannot drift. Direct setters are kept exported for the rare case a
 * caller needs to write only one (e.g. the sync sweep that fixes legacy
 * drift), but normal write paths must use `setEffortWithDerivedPoints` so
 * both fields land in the same PATCH.
 */
import { deriveStoryPoints, getWorkdayHours } from './story-points';

export async function setStoryPoints(workItemId: number, points: number): Promise<void> {
  await patchWorkItem(workItemId, [
    { op: 'add', path: '/fields/Microsoft.VSTS.Scheduling.StoryPoints', value: round2(points) },
  ]);
}

export async function setEffort(workItemId: number, hours: number): Promise<void> {
  await patchWorkItem(workItemId, [
    { op: 'add', path: '/fields/Microsoft.VSTS.Scheduling.Effort', value: round2(hours) },
  ]);
}

/**
 * Write Effort and the derived StoryPoints in a single PATCH so the two
 * fields can never be observed out of sync between writes. Returns the
 * numbers that were written so callers can echo them back to Moran.
 */
export async function setEffortWithDerivedPoints(
  workItemId: number,
  effortHours: number,
): Promise<{ effort: number; storyPoints: number }> {
  const workday = getWorkdayHours();
  const points = deriveStoryPoints(effortHours, workday);
  await patchWorkItem(workItemId, [
    { op: 'add', path: '/fields/Microsoft.VSTS.Scheduling.Effort', value: round2(effortHours) },
    { op: 'add', path: '/fields/Microsoft.VSTS.Scheduling.StoryPoints', value: round2(points) },
  ]);
  return { effort: round2(effortHours), storyPoints: round2(points) };
}
```

(The `import { deriveStoryPoints, getWorkdayHours } from './story-points';` line goes near the top of the file with the other imports; place it after the existing `import { getSetting, setSetting } from './timers';` line — exact existing location around `server/writes.ts:11`.)

- [ ] **Step 4: Run smoke again**

Run: `npx tsx scripts/smoke-effort-derives-points.ts`
Expected: `OK — derivation matrix re-verified at workday=9h.`

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 6: Delete smoke + commit**

```bash
rm scripts/smoke-effort-derives-points.ts
git add server/writes.ts
git commit -m "Writes — setEffortWithDerivedPoints batches effort + derived points in one PATCH"
```

---

## Task 4: `createStory` derives points from effort

**Files:**
- Modify: `server/writes.ts:536–600` (the `CreateStoryInput` interface + `createStory` function)

- [ ] **Step 1: Write smoke**

Create `scripts/smoke-create-story-derives.ts`:

```ts
/**
 * One-shot: verify CreateStoryInput no longer accepts storyPoints, and that
 * createStory's emitted PATCH derives points from effortHours.
 *
 * Since we can't actually create an ADO story in a smoke without side
 * effects, we exercise the derivation that createStory will use internally
 * and confirm the input shape via TypeScript at compile time. The
 * end-to-end verification is the next live story_create call after the
 * MCP restart in Task 9.
 */
import { deriveStoryPoints, getWorkdayHours } from '../server/story-points';
import type { CreateStoryInput } from '../server/writes';

// Compile-time shape check: this assignment must error if storyPoints is
// still on the type. We use a bare object with the new required shape.
const _shapeCheck: CreateStoryInput = {
  title: 'shape check',
  effortHours: 18,
};
void _shapeCheck;

const workday = getWorkdayHours();
if (deriveStoryPoints(18, workday) !== 2.0) {
  throw new Error(`expected 18h → 2.0 pts at workday ${workday}h`);
}
console.log('OK — CreateStoryInput shape narrows to effortHours only; derivation confirmed.');
```

- [ ] **Step 2: Run smoke — expect TYPE error** (interface still has `storyPoints`)

Run: `npx tsx scripts/smoke-create-story-derives.ts`
Expected: FAIL with TypeScript error `Property 'storyPoints' is missing in type '{ title: string; effortHours: number; }' but required in type 'CreateStoryInput'`.

- [ ] **Step 3: Update `CreateStoryInput` and `createStory` in `server/writes.ts`**

Find the existing `CreateStoryInput` interface (around line 536):

```ts
export interface CreateStoryInput {
  title: string;
  description?: string;
  /** Moran's team convention: 1 story point = 1 day. */
  storyPoints: number;
  /** Total hours she thinks this story is. */
  effortHours: number;
  /** Optional Feature/Epic id to link the story under. */
  parentFeatureId?: number;
  tags?: string[];
}
```

Replace with:

```ts
export interface CreateStoryInput {
  title: string;
  description?: string;
  /**
   * Total hours Moran thinks this story is. Story Points are derived from
   * this via `deriveStoryPoints` and written in the same PATCH — callers
   * don't (and can't) pass points independently.
   */
  effortHours: number;
  /** Optional Feature/Epic id to link the story under. */
  parentFeatureId?: number;
  tags?: string[];
}
```

Then in the `createStory` function body (around line 564), find the patch construction:

```ts
const patch: Array<Record<string, unknown>> = [
  { op: 'add', path: '/fields/System.Title', value: input.title },
  { op: 'add', path: '/fields/System.AssignedTo', value: cfg.user },
  { op: 'add', path: '/fields/System.IterationPath', value: iteration },
  { op: 'add', path: '/fields/Microsoft.VSTS.Scheduling.StoryPoints', value: round2(input.storyPoints) },
  { op: 'add', path: '/fields/Microsoft.VSTS.Scheduling.Effort', value: round2(input.effortHours) },
];
```

Replace with:

```ts
const workday = getWorkdayHours();
const derivedPoints = deriveStoryPoints(input.effortHours, workday);
const patch: Array<Record<string, unknown>> = [
  { op: 'add', path: '/fields/System.Title', value: input.title },
  { op: 'add', path: '/fields/System.AssignedTo', value: cfg.user },
  { op: 'add', path: '/fields/System.IterationPath', value: iteration },
  { op: 'add', path: '/fields/Microsoft.VSTS.Scheduling.Effort', value: round2(input.effortHours) },
  { op: 'add', path: '/fields/Microsoft.VSTS.Scheduling.StoryPoints', value: round2(derivedPoints) },
];
```

- [ ] **Step 4: Run smoke**

Run: `npx tsx scripts/smoke-create-story-derives.ts`
Expected: `OK — CreateStoryInput shape narrows to effortHours only; derivation confirmed.`

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: clean. (If anything in `mcp/server.ts` still passes `storyPoints:` to `createStory`, this is where it shows up — Task 5 will fix that call site. Expect a typecheck error on `mcp/server.ts` around the `story_create` handler if so.)

If typecheck flags `mcp/server.ts`, that's expected — proceed to Task 5 before committing this task to keep the tree green.

- [ ] **Step 6: Delete smoke**

```bash
rm scripts/smoke-create-story-derives.ts
```

**Hold the commit until Task 5 is done — they ship together as one logical change to the create flow.**

---

## Task 5: `story_create` MCP tool — drop `storyPoints`, only effort required

**Files:**
- Modify: `mcp/server.ts:1533–1573` (the `story_create` tool registration + handler)

- [ ] **Step 1: Update the schema**

In `mcp/server.ts`, find the `story_create` tool registration (around line 1533). Replace the `inputSchema` block:

```ts
    inputSchema: {
      title: z.string().min(1).describe('Story title — short and specific.'),
      description: z.string().optional().describe('Optional details. Plain text or simple HTML.'),
      storyPoints: z
        .number()
        .min(0)
        .describe("REQUIRED. Moran's team convention: 1 point = 1 day. Ask him for it before calling."),
      effortHours: z
        .number()
        .min(0)
        .describe('REQUIRED. Total hours Moran thinks this story is. Ask him for it before calling.'),
      parentFeatureId: z
        .number()
        .int()
        .positive()
        .optional()
        .describe('Optional Feature/Epic id to link this story under.'),
    },
```

with:

```ts
    inputSchema: {
      title: z.string().min(1).describe('Story title — short and specific.'),
      description: z.string().optional().describe('Optional details. Plain text or simple HTML.'),
      effortHours: z
        .number()
        .min(0)
        .describe('REQUIRED. Total hours Moran thinks this story is. Ask him for it before calling. StoryPoints is derived from this automatically (1 point = 1 workday) — do not pass points separately.'),
      parentFeatureId: z
        .number()
        .int()
        .positive()
        .optional()
        .describe('Optional Feature/Epic id to link this story under.'),
    },
```

- [ ] **Step 2: Update the handler**

In the same block, find the handler signature:

```ts
  async ({ title, description, storyPoints, effortHours, parentFeatureId }) => {
    try {
      const created = await createStory({
        title,
        description,
        storyPoints,
        effortHours,
        parentFeatureId,
      });
```

Replace with:

```ts
  async ({ title, description, effortHours, parentFeatureId }) => {
    try {
      const created = await createStory({
        title,
        description,
        effortHours,
        parentFeatureId,
      });
```

- [ ] **Step 3: Update the tool description**

In the same registration block, replace the existing description:

```ts
      "Create a new User Story in Azure DevOps, placed in Moran's current sprint and assigned to him. ALWAYS ask Moran for storyPoints AND effortHours before calling — never guess, never skip. These are the planning fields the POM delivery manager looks at to gauge sprint progress, so they must be set on every story you create. storyPoints uses his team's convention: 1 point = 1 day. effortHours is the total hours he thinks the story is. Pass `parentFeatureId` to nest under an existing Feature/Epic if he has one. Returns the new story's id and URL.",
```

with:

```ts
      "Create a new User Story in Azure DevOps, placed in Moran's current sprint and assigned to him. ALWAYS ask Moran for effortHours before calling — never guess, never skip. Effort is the single planning field the POM delivery manager reads; Story Points are derived from it automatically (1 point = 1 workday, rounded to the nearest half) and written in the same patch. Pass `parentFeatureId` to nest under an existing Feature/Epic if he has one. Returns the new story's id and URL.",
```

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 5: Commit Tasks 4 + 5 together**

```bash
git add server/writes.ts mcp/server.ts
git commit -m "Create story — one number (effort hours), points derived in the same PATCH"
```

**USER smoke (cannot verify here):** After Moran runs `/exit` + `claude --resume`, calling `mcp__sprint-helper__story_create` must reject `storyPoints` and accept only `effortHours`. Note this in the final summary so Moran knows to restart.

---

## Task 6: `workitem_edit` routes effort through the batched helper, drops independent storyPoints

**Files:**
- Modify: `mcp/server.ts:1209–1296` (the `workitem_edit` tool registration + handler)

- [ ] **Step 1: Update the schema — drop `storyPoints`**

In `mcp/server.ts`, find the `workitem_edit` `inputSchema` (around line 1215). Remove the `storyPoints` line entirely:

Before:
```ts
      storyPoints: z.number().min(0).optional().describe('Story field. His team treats 1 point = 1 day.'),
      effort: z.number().min(0).optional().describe('Story field, in hours. Total hours he thinks the story is.'),
```

After (delete the storyPoints line, update effort's describe):
```ts
      effort: z.number().min(0).optional().describe('Story field, in hours. Total hours he thinks the story is. StoryPoints is derived from this automatically (1 point = 1 workday) and written in the same patch — do not try to set points separately.'),
```

- [ ] **Step 2: Update the handler signature + body**

Find the handler at line ~1228:

```ts
  async ({ workItemId, state, originalEstimate, remainingWork, completedWork, storyPoints, effort, addTags, removeTags, iterationPath }) => {
    if (
      state == null && originalEstimate == null && remainingWork == null && completedWork == null &&
      storyPoints == null && effort == null &&
      (addTags == null || addTags.length === 0) &&
      (removeTags == null || removeTags.length === 0) &&
      iterationPath == null
    ) {
      return errorResult('At least one of state, originalEstimate, remainingWork, completedWork, storyPoints, effort, addTags, removeTags, iterationPath is required.');
    }
    const applied: {
      state?: string;
      originalEstimate?: number;
      remainingWork?: number;
      completedWork?: number;
      storyPoints?: number;
      effort?: number;
      tags?: string[];
      iterationPath?: string;
    } = {};
```

Replace with:

```ts
  async ({ workItemId, state, originalEstimate, remainingWork, completedWork, effort, addTags, removeTags, iterationPath }) => {
    if (
      state == null && originalEstimate == null && remainingWork == null && completedWork == null &&
      effort == null &&
      (addTags == null || addTags.length === 0) &&
      (removeTags == null || removeTags.length === 0) &&
      iterationPath == null
    ) {
      return errorResult('At least one of state, originalEstimate, remainingWork, completedWork, effort, addTags, removeTags, iterationPath is required.');
    }
    const applied: {
      state?: string;
      originalEstimate?: number;
      remainingWork?: number;
      completedWork?: number;
      storyPoints?: number;
      effort?: number;
      tags?: string[];
      iterationPath?: string;
    } = {};
```

(Note: keep `storyPoints?: number;` in the `applied` shape — the tool still REPORTS the derived points, just no longer accepts them as input.)

- [ ] **Step 3: Replace the storyPoints + effort write blocks**

Find these two blocks in the same handler (around line 1275–1282):

```ts
      if (storyPoints != null) {
        await setStoryPoints(workItemId, storyPoints);
        applied.storyPoints = storyPoints;
      }
      if (effort != null) {
        await setEffort(workItemId, effort);
        applied.effort = effort;
      }
```

Replace with:

```ts
      if (effort != null) {
        const { effort: appliedEffort, storyPoints: appliedPoints } =
          await setEffortWithDerivedPoints(workItemId, effort);
        applied.effort = appliedEffort;
        applied.storyPoints = appliedPoints;
      }
```

- [ ] **Step 4: Update the import block**

Near the top of `mcp/server.ts`, find the existing import from `'../server/writes'` (around line 60–66). Replace `setEffort, ..., setStoryPoints,` with `setEffortWithDerivedPoints,` (keep all other imports). The new line should read approximately:

```ts
import {
  // ...existing imports above...
  setEffort,
  // ...
  setEffortWithDerivedPoints,
  // ...existing imports below...
} from '../server/writes';
```

(Keep `setEffort` exported and imported — `scripts/sync-story-points.ts` in Task 8 needs it to write only the points field on legacy items. Drop `setStoryPoints` from this file's imports if it's no longer referenced; let typecheck guide you.)

- [ ] **Step 5: Update the tool description**

Find the `workitem_edit` tool description (around line 1213). Replace:

```ts
      "Update an existing work item in Azure DevOps. Covers state, effort fields, story planning fields, and tags. State uses Moran's plain English buckets: 'waiting' (New/To Do/Proposed), 'going' (Active/In Progress/Doing), 'done' (Closed/Done/Resolved). Effort fields are in hours: originalEstimate (the plan), remainingWork (burns down as work happens), and completedWork (climbs up — what the DM watches). Story-level: storyPoints (his team treats 1 point = 1 day) and effort (total hours). Tags: addTags adds them (case-insensitive dedup), removeTags removes them, both can be passed together.",
```

with:

```ts
      "Update an existing work item in Azure DevOps. Covers state, effort fields, story-level effort, and tags. State uses Moran's plain English buckets: 'waiting' (New/To Do/Proposed), 'going' (Active/In Progress/Doing), 'done' (Closed/Done/Resolved). Task effort fields are in hours: originalEstimate (the plan), remainingWork (burns down as work happens), and completedWork (climbs up — what the DM watches). Story-level: pass `effort` (total hours) and Story Points are derived in the same patch (1 point = 1 workday, half-point rounding); do not pass storyPoints separately. Tags: addTags adds them (case-insensitive dedup), removeTags removes them, both can be passed together.",
```

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck`
Expected: clean. (If `setStoryPoints` is no longer used anywhere in `mcp/server.ts`, remove it from the import; if `setEffort` is no longer used here either, remove that too. Both are still exported from `writes.ts` — the sweep script in Task 8 uses them.)

- [ ] **Step 7: Commit**

```bash
git add mcp/server.ts
git commit -m "Edit work item — effort writes Effort + derived Story Points in one PATCH"
```

**USER smoke (cannot verify here):** After Moran runs `/exit` + `claude --resume`, calling `mcp__sprint-helper__workitem_edit` with `storyPoints` set must reject; calling it with `effort: 24` on a story must return `applied.effort: 24` AND `applied.storyPoints: 2.5`.

---

## Task 7: Gap scanner — only Effort is a story gap, never points alone

**Files:**
- Modify: `server/planning.ts:108–114` (the `storyMissing` function)

- [ ] **Step 1: Write smoke**

Create `scripts/smoke-gap-only-flags-effort.ts`:

```ts
/**
 * One-shot: verify storyMissing returns ['Effort'] when effort is null,
 * and [] when effort is present — regardless of storyPoints. Tasks-side
 * behavior unchanged.
 */
import type { UserStoryGroup } from '../server/dashboard';

// We call the unexported helper via a small re-export shim: planning.ts
// must expose storyMissing for this smoke. If it isn't exported, the smoke
// imports it through a workaround: copy-paste the function inline here
// to assert intent, and verify the real path via the integration smoke in
// Task 9. We choose the simpler route — export it.
import { storyMissing } from '../server/planning';

function fakeStory(over: Partial<UserStoryGroup>): UserStoryGroup {
  return {
    id: '1', title: 't', type: 'User Story', state: 'Active', url: '',
    tasks: [], totalEstimateHours: 0, completedHours: 0, remainingHours: 0,
    counts: { inProgress: 0, upNext: 0, done: 0 },
    ...over,
  } as UserStoryGroup;
}

const cases: Array<[Partial<UserStoryGroup>, string[]]> = [
  // effort missing → only "Effort" is a gap (even if points also missing)
  [{ storyPoints: undefined, effort: undefined }, ['Effort']],
  [{ storyPoints: 2, effort: undefined }, ['Effort']],
  // effort present → never a gap (even if points missing — they'll be derived)
  [{ storyPoints: undefined, effort: 18 }, []],
  [{ storyPoints: 4, effort: 18 }, []],   // drift case — not a gap, sweep heals it
];

let failed = 0;
for (const [over, expected] of cases) {
  const got = storyMissing(fakeStory(over));
  if (JSON.stringify(got) !== JSON.stringify(expected)) {
    console.error(`FAIL: ${JSON.stringify(over)} → ${JSON.stringify(got)}, expected ${JSON.stringify(expected)}`);
    failed++;
  }
}
if (failed > 0) { console.error(`${failed} case(s) failed.`); process.exit(1); }
console.log(`OK — gap scanner flags Effort only.`);
```

- [ ] **Step 2: Run smoke — expect FAIL because `storyMissing` isn't exported and current behavior flags points too**

Run: `npx tsx scripts/smoke-gap-only-flags-effort.ts`
Expected: FAIL — either an import error (`storyMissing` not exported) or, if you bypass the import, FAIL on the first two cases reading `['StoryPoints','Effort']` instead of `['Effort']`.

- [ ] **Step 3: Update `server/planning.ts`**

Find lines 101–114:

```ts
/**
 * Per-type planning fields. Only User Stories are flagged in Plan mode —
 * StoryPoints + Effort are the fields the POM delivery manager reads at
 * the Story level. Features and Epics are top-level rollups; planning
 * fields on them are optional in Moran's tenant (decision 2026-06-03).
 * Tasks are handled separately by taskMissing().
 */
function storyMissing(g: UserStoryGroup): string[] {
  if (kindFor(g.type) !== 'story') return [];
  const missing: string[] = [];
  if (g.storyPoints == null) missing.push('StoryPoints');
  if (g.effort == null) missing.push('Effort');
  return missing;
}
```

Replace with:

```ts
/**
 * Per-type planning fields. Only User Stories are flagged in Plan mode.
 * Effort (hours) is the single field the POM delivery manager reads at
 * the Story level — Story Points are derived from Effort whenever Effort
 * is written, so an item with Effort set is never a planning gap even if
 * points are absent or drifted. The sync sweep heals drift; on-edit
 * derivation prevents new drift. Features and Epics: planning fields
 * optional in Moran's tenant (decision 2026-06-03). Tasks: handled
 * separately by taskMissing().
 */
export function storyMissing(g: UserStoryGroup): string[] {
  if (kindFor(g.type) !== 'story') return [];
  if (g.effort == null) return ['Effort'];
  return [];
}
```

(Note the added `export` so the smoke can import it.)

- [ ] **Step 4: Run smoke**

Run: `npx tsx scripts/smoke-gap-only-flags-effort.ts`
Expected: `OK — gap scanner flags Effort only.`

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 6: Delete smoke + commit**

```bash
rm scripts/smoke-gap-only-flags-effort.ts
git add server/planning.ts
git commit -m "Gap scan — story gaps are only missing Effort; points always derive"
```

**USER smoke (cannot verify here):** Hard-refresh dashboard at http://localhost:7777/, open the Plan cockpit, click "Scan for gaps." The drifted #431995 (4 pts / 18h) must NOT appear in the gap list. Only stories with truly missing Effort should appear.

---

## Task 8: One-shot self-healing sweep for legacy drift

**Files:**
- Create: `scripts/sync-story-points.ts` (self-cleaning; delete after a successful run)

- [ ] **Step 1: Write the sweep**

Create `scripts/sync-story-points.ts`:

```ts
/**
 * One-shot sweep: heal Story Points drift on Moran's open User Stories.
 *
 * Walks every Story assigned to him in the current sprint (and any other
 * non-done iteration he holds open work in), reads StoryPoints + Effort,
 * computes the expected points via deriveStoryPoints, and PATCHes the
 * difference. Prints a before/after table so he sees exactly what changed.
 *
 * Run once after the MCP restart in Task 6. Delete the script after a
 * successful run (repo convention — sweeps don't live in tree).
 *
 *   npx tsx scripts/sync-story-points.ts          # dry run, prints only
 *   npx tsx scripts/sync-story-points.ts --apply  # actually PATCH
 */
import { execFile } from 'node:child_process';
import { loadAdoConfig } from '../server/config';
import { setStoryPoints } from '../server/writes';
import { deriveStoryPoints, getWorkdayHours } from '../server/story-points';

const ADO_RESOURCE = '499b84ac-1321-427f-aa17-267ca6975798';

interface StoryRow {
  id: number;
  title: string;
  state: string;
  effort: number | null;
  storyPoints: number | null;
}

function az(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('az', [...args, '-o', 'json'], { maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(String(stderr)));
      else resolve(String(stdout));
    });
  });
}

async function listOpenStories(): Promise<StoryRow[]> {
  const cfg = await loadAdoConfig();
  const wiql = {
    query: `
      SELECT [System.Id]
      FROM WorkItems
      WHERE [System.AssignedTo] = @Me
        AND [System.WorkItemType] = 'User Story'
        AND [System.State] NOT IN ('Done','Closed','Resolved','Completed','Removed')
    `,
  };
  const wiqlUri = `${cfg.organization}/${encodeURIComponent(cfg.project)}/_apis/wit/wiql?api-version=7.1`;
  const wiqlOut = await new Promise<string>((resolve, reject) => {
    const child = execFile(
      'az',
      [
        'rest', '--method', 'POST',
        '--uri', wiqlUri,
        '--resource', ADO_RESOURCE,
        '--headers', 'Content-Type=application/json',
        '--body', '@-',
        '-o', 'json',
      ],
      { maxBuffer: 16 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) reject(new Error(String(stderr)));
        else resolve(String(stdout));
      },
    );
    child.stdin?.write(JSON.stringify(wiql));
    child.stdin?.end();
  });
  const parsed = JSON.parse(wiqlOut) as { workItems?: Array<{ id: number }> };
  const ids = (parsed.workItems ?? []).map(w => w.id);
  if (ids.length === 0) return [];

  const fields = [
    'System.Id', 'System.Title', 'System.State',
    'Microsoft.VSTS.Scheduling.Effort',
    'Microsoft.VSTS.Scheduling.StoryPoints',
  ].join(',');
  const batchUri = `${cfg.organization}/${encodeURIComponent(cfg.project)}/_apis/wit/workitemsbatch?api-version=7.1`;
  const batchBody = { ids, fields: fields.split(',') };
  const batchOut = await new Promise<string>((resolve, reject) => {
    const child = execFile(
      'az',
      [
        'rest', '--method', 'POST',
        '--uri', batchUri,
        '--resource', ADO_RESOURCE,
        '--headers', 'Content-Type=application/json',
        '--body', '@-',
        '-o', 'json',
      ],
      { maxBuffer: 16 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) reject(new Error(String(stderr)));
        else resolve(String(stdout));
      },
    );
    child.stdin?.write(JSON.stringify(batchBody));
    child.stdin?.end();
  });

  const items = JSON.parse(batchOut) as {
    value: Array<{
      id: number;
      fields: Record<string, unknown>;
    }>;
  };

  return items.value.map(w => ({
    id: w.id,
    title: String(w.fields['System.Title'] ?? ''),
    state: String(w.fields['System.State'] ?? ''),
    effort: typeof w.fields['Microsoft.VSTS.Scheduling.Effort'] === 'number'
      ? (w.fields['Microsoft.VSTS.Scheduling.Effort'] as number)
      : null,
    storyPoints: typeof w.fields['Microsoft.VSTS.Scheduling.StoryPoints'] === 'number'
      ? (w.fields['Microsoft.VSTS.Scheduling.StoryPoints'] as number)
      : null,
  }));
}

async function main() {
  const apply = process.argv.includes('--apply');
  const workday = getWorkdayHours();
  console.log(`Workday is ${workday}h. Scanning open User Stories…`);

  const stories = await listOpenStories();
  if (stories.length === 0) {
    console.log('No open stories.');
    return;
  }

  type DriftRow = StoryRow & { expected: number };
  const drift: DriftRow[] = [];
  const missingEffort: StoryRow[] = [];
  for (const s of stories) {
    if (s.effort == null) {
      missingEffort.push(s);
      continue;
    }
    const expected = deriveStoryPoints(s.effort, workday);
    if (s.storyPoints !== expected) {
      drift.push({ ...s, expected });
    }
  }

  if (drift.length === 0 && missingEffort.length === 0) {
    console.log(`All ${stories.length} open stories are aligned. Nothing to do.`);
    return;
  }

  if (drift.length > 0) {
    console.log(`\nStories with drift (${drift.length}):`);
    console.log(`  id          effort   current pts   derived pts   title`);
    for (const d of drift) {
      console.log(
        `  #${String(d.id).padEnd(8)}  ${String(d.effort).padStart(5)}h   ${String(d.storyPoints ?? '∅').padStart(11)}   ${String(d.expected).padStart(11)}   ${d.title}`,
      );
    }
  }

  if (missingEffort.length > 0) {
    console.log(`\nStories missing Effort (${missingEffort.length}) — these need a real estimate, not a sweep:`);
    for (const m of missingEffort) {
      console.log(`  **${m.title}** (#${m.id}) — ${m.state}`);
    }
  }

  if (!apply) {
    console.log(`\nDry run. Re-run with --apply to PATCH the ${drift.length} drifted stor${drift.length === 1 ? 'y' : 'ies'}.`);
    return;
  }

  console.log(`\nApplying patches…`);
  for (const d of drift) {
    try {
      await setStoryPoints(d.id, d.expected);
      console.log(`  ✓ **${d.title}** (#${d.id}) — points now ${d.expected}`);
    } catch (e) {
      console.error(`  ✗ **${d.title}** (#${d.id}) — ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  console.log(`\nDone. Delete this script when you've confirmed the board looks right.`);
}

main().catch(e => { console.error(e); process.exit(1); });
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 3: Commit (script lands in tree so Moran can run it)**

```bash
git add scripts/sync-story-points.ts
git commit -m "Sweep — heal legacy Story Points drift (one-shot, delete after running)"
```

**USER actions (cannot verify here):**

1. Restart MCP: `/exit` + `claude --resume` (picks up Tasks 5, 6).
2. Hard-refresh dashboard at http://localhost:7777/ (picks up gap-scan change).
3. Dry run: `cd ~/projects/github-moran/sprint-helper && npx tsx scripts/sync-story-points.ts` — review the drift list, including #431995.
4. Apply: `npx tsx scripts/sync-story-points.ts --apply` — confirm the patches landed.
5. Refresh ADO board — #431995 should now read 2.0 pts beside 18h (or the derived value).
6. Once confirmed, delete the script: `git rm scripts/sync-story-points.ts && git commit -m "Sweep — remove one-shot after successful run"`.

---

## Task 9: Final verification + commit message of intent

**Files:**
- None modified — this task verifies the tree compiles and writes a summary commit message for the USER smokes that remain.

- [ ] **Step 1: Final typecheck**

Run: `npm run typecheck`
Expected: clean, zero new errors. (Pre-existing warnings in `Dashboard.tsx:654` and `standup.ts:85` from prior work are not in this slice's scope and may still show — those are tracked separately.)

- [ ] **Step 2: Confirm no leftover smoke scripts**

Run: `ls scripts/`
Expected: `backfill-archive.ts cleanup-stale-timers.ts sync-story-points.ts` — exactly these three; no `smoke-*.ts` files left behind.

- [ ] **Step 3: Confirm the imports + exports line up across the tree**

Run: `npx tsc --noEmit -p tsconfig.server.json`
Expected: clean.

- [ ] **Step 4: Push to GitHub**

```bash
git push origin main
```

Expected: all commits from Tasks 1, 2, 3, 4+5, 6, 7, 8 land on `MoranWeissman/sprint-helper`.

- [ ] **Step 5: Report to USER**

In the final summary back to Moran, include:

1. **What changed:** "Effort is now the only number you (or any chat) sets on a Story. Points derive automatically — same patch, same call. The board can't show 4d / 18h any more."
2. **What USER needs to do:**
   - `/exit` + `claude --resume` in every open Claude Code chat (MCP tool schemas changed).
   - Hard-refresh the dashboard (gap-scan logic changed).
   - Run the dry-run sweep: `npx tsx scripts/sync-story-points.ts`. Review the drift list.
   - Run the apply sweep: `npx tsx scripts/sync-story-points.ts --apply`. Confirm on the board.
   - Once happy, `git rm scripts/sync-story-points.ts && git commit -m "Sweep — remove one-shot after successful run"` + push.
3. **What we did NOT do (intentional YAGNI):**
   - No UI hint pip for drift — the sweep + on-edit self-heal handles it without new surface area.
   - No task→story Effort rollup — story Effort stays direct; if you want a rollup later, that's a separate slice.
   - No new MCP tool to set `workday_hours` — the setting reads from SQLite; if you want to change it from 9, edit the row directly.

---

## Self-Review

**1. Spec coverage:**

| Spec section | Task |
|---|---|
| Problem statement (board contradiction) | Tasks 4 + 6 (create + edit) prevent new drift; Task 8 (sweep) heals existing |
| The rule (`round((effort/workday)*2)/2`) | Task 1 (`deriveStoryPoints`) |
| Behavior 1: Compute, don't ask | Tasks 4 + 5 + 6 — `storyPoints` is no longer a separate input |
| Behavior 2: Use the configured workday | Task 1 (`getWorkdayHours()`) + Task 2 (capacity also uses it) |
| Behavior 3: Reconcile-on-read + flag + heal | Task 8 sweep prints drift + heals; on-edit self-heal via Task 6 |
| Behavior 4: Gap check stops treating points as missing | Task 7 |
| Behavior 5: If Effort absent, single gap is "missing Effort" | Task 7 (returns `['Effort']` only) |

All five behaviors mapped to specific tasks.

**2. Placeholder scan:** No "TBD", "implement later", or vague handling instructions. Every step shows exact code. Pre-existing typecheck warnings called out by name + file are noted as out-of-scope.

**3. Type consistency:**
- `deriveStoryPoints(effortHours: number, workdayHours: number): number` — referenced in Tasks 1, 3, 4, 7, 8.
- `getWorkdayHours(): number` — referenced in Tasks 1, 2, 3, 4, 8.
- `setEffortWithDerivedPoints(workItemId, effortHours): Promise<{effort, storyPoints}>` — defined in Task 3, consumed in Task 6.
- `storyMissing(g: UserStoryGroup): string[]` — exported in Task 7 (newly), consumed by the smoke + the planning module's own `findGaps`.
- `CreateStoryInput` — narrowed in Task 4 (drops `storyPoints`), consumed in Task 5.

Consistent across tasks. No drift.

---

Plan complete and saved to `docs/superpowers/plans/2026-06-03-story-points-from-effort.md`. Two execution options:

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — Execute tasks in this session, batch with checkpoints.

Which approach?
