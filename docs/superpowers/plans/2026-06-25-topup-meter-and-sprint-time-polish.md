# Top-up meter, move-rule, Daily Sprint-time + rail — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** (1) hours meter in Top-up that fills on pull, (2) relax the story move-rule to block only out of a PAST sprint + whole-story pull, (3) fix the Daily Sprint-time card to one hours story, (4) gray weekends + count 10 working days in the left rail.

**Architecture:** A pure `classifyPastSprint(iterations, path, now)` is the single source of the "is this a past sprint?" truth, used by both the move guard (`setIterationPath`) and the cockpit's `canPullStory`. The cockpit gains current-sprint capacity + committed hours so the Top-up meter measures the running sprint. Daily card + rail are presentation-only fixes.

**Tech Stack:** TypeScript, React 18, Vitest 4.

---

### Task 1: Pure `classifyPastSprint` + unit tests

**Files:**
- Modify: `server/iteration-paths.ts` (leaf module, no imports — the right home)
- Test: `server/iteration-paths.test.ts` (create if absent; else append)

- [ ] **Step 1: Read iteration-paths.ts** to match style + see `isSprintLevel`.

Run: `cat server/iteration-paths.ts`

- [ ] **Step 2: Add the pure helper**

```ts
export interface IterationLite { path: string; finishDate: string; }

/**
 * True when `iterationPath` matches a sprint-level iteration whose finish date
 * is strictly before the start of `now`'s day. Backlog/year/quarter paths and
 * unknown paths return false (not a past sprint). Pure — caller supplies the
 * iteration list, so it's testable without ADO.
 */
export function classifyPastSprint(
  iterations: IterationLite[],
  iterationPath: string,
  now: Date,
): boolean {
  if (!isSprintLevel(iterationPath)) return false;
  const match = iterations.find(it => it.path === iterationPath);
  if (!match) return false;
  const finish = new Date(match.finishDate);
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  return finish.getTime() < startOfToday.getTime();
}
```

- [ ] **Step 3: Write failing tests** — `server/iteration-paths.test.ts`

```ts
import { describe, it, expect } from 'vitest';
import { classifyPastSprint } from './iteration-paths';

const ITS = [
  { path: 'IDP - DevOps\\2026\\Q2\\26_11', finishDate: '2026-06-10T00:00:00Z' },
  { path: 'IDP - DevOps\\2026\\Q2\\26_13', finishDate: '2026-07-10T00:00:00Z' },
];
const NOW = new Date('2026-06-25T09:00:00Z');

describe('classifyPastSprint', () => {
  it('true for a sprint that already finished', () => {
    expect(classifyPastSprint(ITS, 'IDP - DevOps\\2026\\Q2\\26_11', NOW)).toBe(true);
  });
  it('false for a future/current sprint', () => {
    expect(classifyPastSprint(ITS, 'IDP - DevOps\\2026\\Q2\\26_13', NOW)).toBe(false);
  });
  it('false for backlog / year / quarter paths', () => {
    expect(classifyPastSprint(ITS, 'IDP - DevOps\\2026', NOW)).toBe(false);
    expect(classifyPastSprint(ITS, 'IDP - DevOps\\Backlog', NOW)).toBe(false);
  });
  it('false for an unknown sprint path not in the list', () => {
    expect(classifyPastSprint(ITS, 'IDP - DevOps\\2026\\Q1\\26_09', NOW)).toBe(false);
  });
});
```

- [ ] **Step 4: Run** `npm test -- iteration-paths` → 4 pass. **Step 5:** `npx tsc -b` clean.
- [ ] **Step 6: Commit** `git add server/iteration-paths.ts server/iteration-paths.test.ts && git commit -m "feat: classifyPastSprint — pure past-sprint test"`

---

### Task 2: Relax `setIterationPath` to block only out of a past sprint

**Files:**
- Modify: `server/writes.ts`
- Test: `server/writes.test.ts`

- [ ] **Step 1: Update the guard**

`setIterationPath` currently refuses any started story. Change the story-level branch to refuse
only when the story's CURRENT iteration is a past sprint:

```ts
export async function setIterationPath(workItemId: number, iterationPath: string): Promise<void> {
  const f = await readFields(workItemId, ['System.WorkItemType', 'System.State', 'System.Title', 'System.IterationPath']);
  const type = String(f['System.WorkItemType'] ?? '').toLowerCase();
  const state = String(f['System.State'] ?? '');
  if (STORY_LEVEL_TYPES.has(type) && !NEVER_STARTED_STATES_LOWER.has(state.toLowerCase())) {
    const currentPath = String(f['System.IterationPath'] ?? '');
    const iterations = await listAllIterations().catch(() => []);
    if (classifyPastSprint(iterations, currentPath, new Date())) {
      const title = String(f['System.Title'] ?? `#${workItemId}`);
      throw new Error(
        `Won't move "${title}" out of a finished sprint — that would drop it from that sprint's record. A started story stays in the sprint it ran in; only its open tasks carry forward. Move the tasks instead, or close the story.`,
      );
    }
  }
  await patchWorkItem(workItemId, [
    { op: 'add', path: '/fields/System.IterationPath', value: iterationPath },
  ]);
}
```

Add imports: `classifyPastSprint` from `./iteration-paths`, `listAllIterations` from `./ado`
(confirm writes.ts can import ado — check for a cycle; if ado imports writes, pass the
iteration list in differently. Likely fine: ado is lower-level.) `readFields` must include
`System.IterationPath` — added above.

- [ ] **Step 2: Check for an import cycle**

Run: `npx tsc -b` — if it complains or a cycle appears, fall back: keep the date logic pure in
iteration-paths (already done) and fetch `listAllIterations` — ado.ts is a leaf-ish data module
that does not import writes.ts (verify: `grep -n "from './writes'" server/ado.ts` → expect none).

- [ ] **Step 3: Update the existing tests** — the writes.test.ts board mock has no real
iteration list. Add a mock for `listAllIterations` in the existing `vi.mock('./ado', …)` (or
add one) returning a small set: a PAST sprint and a FUTURE sprint. Then:

```ts
describe('setIterationPath — blocks only out of a past sprint', () => {
  // assumes listAllIterations mocked to include:
  //   PAST  = 'Proj\\2026\\Q2\\26_11' (finished)
  //   FUT   = 'Proj\\2026\\Q2\\26_13' (current/future)
  it('refuses a started story leaving a PAST sprint', async () => {
    seed(20, { [F.type]: 'User Story', [F.state]: 'Active', [F.title]: 'Past underway', [F.iteration]: 'Proj\\2026\\Q2\\26_11' });
    await expect(setIterationPath(20, 'Proj\\2026\\Q2\\26_13')).rejects.toThrow(/finished sprint/i);
  });
  it('moves a started story out of a FUTURE/current sprint', async () => {
    seed(21, { [F.type]: 'User Story', [F.state]: 'Active', [F.title]: 'Future underway', [F.iteration]: 'Proj\\2026\\Q2\\26_13' });
    await setIterationPath(21, 'Proj\\2026\\Q2\\26_14');
    expect(fieldsOf(21)[F.iteration]).toBe('Proj\\2026\\Q2\\26_14');
  });
  it('moves a started story out of the backlog', async () => {
    seed(22, { [F.type]: 'User Story', [F.state]: 'Active', [F.title]: 'Backlog underway', [F.iteration]: 'Proj\\Backlog' });
    await setIterationPath(22, 'Proj\\2026\\Q2\\26_13');
    expect(fieldsOf(22)[F.iteration]).toBe('Proj\\2026\\Q2\\26_13');
  });
  it('moves a New story even out of a past sprint', async () => {
    seed(23, { [F.type]: 'User Story', [F.state]: 'New', [F.title]: 'Past new', [F.iteration]: 'Proj\\2026\\Q2\\26_11' });
    await setIterationPath(23, 'Proj\\2026\\Q2\\26_13');
    expect(fieldsOf(23)[F.iteration]).toBe('Proj\\2026\\Q2\\26_13');
  });
});
```

Update the OLD "a started story stays put" / "also refuses a blocked story" tests: their seeds
must now sit in a PAST sprint to still assert refusal (a started story with no iteration / a
non-past one now MOVES). Use the date the mock implies — fix the dates so the test is
deterministic (the suite must not call `new Date()` ambiguously; if `setIterationPath` uses
`new Date()`, the mocked iterations' finishDate must be safely in the past/future relative to
real now — use far dates like 2020 for past and 2099 for future to stay deterministic).

- [ ] **Step 4: Run** `npm test -- writes` → green. **Step 5:** `npx tsc -b` clean.
- [ ] **Step 6: Commit** `git add server/writes.ts server/writes.test.ts && git commit -m "feat: relax setIterationPath — block only out of a finished sprint"`

---

### Task 3: Cockpit — current-sprint capacity, committed hours, canPullStory

**Files:**
- Modify: `server/planning-cockpit.ts`

- [ ] **Step 1: Add `canPullStory` to the top-up type + groupTopUp**

`groupTopUp` needs to know each story's past-sprint status. Pass the iteration list + now in:

```ts
export function groupTopUp(
  stories: WorkItem[],
  tasks: WorkItem[],
  pastSprintOf: (iterationPath: string) => boolean,
): CockpitTopUpStory[] { … }
```

In the map, add:
```ts
const neverStarted = NEVER_STARTED.has(s.state.trim().toLowerCase());
const canPullStory = neverStarted || !pastSprintOf(s.iterationPath);
```
and put `canPullStory` on the returned object. Add a `NEVER_STARTED` set to the file
(`new Set(['new','to do','proposed','approved','ready for dev','accepted'])`) and
`canPullStory: boolean` to `CockpitTopUpStory`.

Update `server/topup.test.ts`: pass a stub `pastSprintOf` (e.g. `() => false`) to existing
calls; add one case where `pastSprintOf` returns true for a started story → `canPullStory`
false, and a New story in that same past sprint → `canPullStory` true.

- [ ] **Step 2: Wire collectTopUpStories + capacity + committed hours**

In `collectTopUpStories`, build a `pastSprintOf` closure from `listAllIterations()` +
`classifyPastSprint` and pass it to `groupTopUp`.

In `buildCockpitPayload`:
```ts
// current-sprint capacity (mirror the nextSprint block)
let currentSprintCapacity: CockpitCapacity | null = null;
if (currentIteration) {
  const cap = await computeCapacity({
    sprintStart: new Date(currentIteration.startDate),
    sprintEnd: new Date(currentIteration.finishDate),
    plannedHours: 0,
  });
  currentSprintCapacity = {
    workingHoursTotal: cap.workingHoursTotal,
    availableHours: cap.availableHours,
    meetingHours: cap.meetingHours.weighted,
    hasUrl: cap.hasUrl,
  };
}
// hours already committed to the running sprint (open tasks under open stories)
const currentSprintCommittedHours = Math.round(
  openStories.reduce((sum, s) =>
    sum + s.openTasks.reduce((a, t) => a + (t.remainingWork ?? t.originalEstimate ?? 0), 0), 0),
);
```
Add both to `CockpitPayload` + the returned object.

- [ ] **Step 3:** `npx tsc -b` clean; `npm test -- topup` green.
- [ ] **Step 4: Commit** `git add server/planning-cockpit.ts server/topup.test.ts && git commit -m "feat: cockpit current-sprint capacity + committed hours + canPullStory"`

---

### Task 4: Client types

**Files:** `src/lib/api.ts`

- [ ] **Step 1:** add `canPullStory: boolean` to `ApiCockpitTopUpStory`; add
  `currentSprintCapacity: ApiCockpitCapacity | null` and `currentSprintCommittedHours: number`
  to `ApiCockpitPayload`.
- [ ] **Step 2:** `npx tsc -b` clean.
- [ ] **Step 3: Commit** `git add src/lib/api.ts && git commit -m "feat: cockpit payload mirrors for top-up meter + canPullStory"`

---

### Task 5: Top-up meter + whole-story pull in PlanView

**Files:** `src/components/PlanView.tsx`

- [ ] **Step 1: Credit pulled hours in `onTopUp`**

It currently only refetches. Before the await, compute the moved tasks' hours and add to
`pulledHoursThisSession`:
```ts
const onTopUp = async (key: number, taskIds: number[], creditHours: number) => {
  if (taskIds.length === 0) return;
  setActingOn(key);
  setActionError(null);
  try {
    await postCarryForward(taskIds);
    if (creditHours > 0) setPulledHoursThisSession(h => h + creditHours);
    await refreshCockpit();
  } catch (err) { setActionError(err instanceof Error ? err.message : 'Pull failed'); }
  finally { setActingOn(null); }
};
```
Callers pass the hours (story.pullableHours for pull-all; the single task's hours for one).

- [ ] **Step 2: Add a whole-story pull handler**

```ts
const onPullStoryWhole = async (story: ApiCockpitTopUpStory) => {
  setActingOn(story.id);
  setActionError(null);
  try {
    const cur = cockpit.status === 'ok' ? cockpit.data.currentSprint : null;
    if (!cur) throw new Error('No current sprint.');
    await moveWorkItemToIteration(story.id, cur.path); // server enforces the relaxed rule
    setPulledHoursThisSession(h => h + story.pullableHours);
    await refreshCockpit();
  } catch (err) { setActionError(err instanceof Error ? err.message : 'Pull failed'); }
  finally { setActingOn(null); }
};
```
(`moveWorkItemToIteration` already exists + imported.)

- [ ] **Step 3: TopUpMeter component** (reuse plan2-meter classes)

```tsx
function TopUpMeter({ committed, pulled, capacity, sprintName }: {
  committed: number; pulled: number; capacity: ApiCockpitCapacity | null; sprintName: string;
}) {
  const cap = Math.max(0, Math.round(capacity?.availableHours ?? 0));
  const filled = Math.max(0, Math.round(committed + pulled));
  const left = cap - filled;
  let verdict = '— no capacity yet', vClass: 'is-room'|'is-near'|'is-over' = 'is-room', over = false;
  if (cap > 0) {
    if (filled > cap) { verdict = `${filled - cap}h over`; vClass = 'is-over'; over = true; }
    else if (left <= 8) { verdict = `${left}h left`; vClass = 'is-near'; }
    else { verdict = `${left}h to spare`; vClass = 'is-room'; }
  }
  const pct = cap > 0 ? Math.min(100, Math.round((filled / cap) * 100)) : 0;
  return (
    <div className="plan2-meter plan2-topup-meter">
      <div className="plan2-meter-top">
        <span className="plan2-meter-label">{sprintName} load</span>
        <span className={`plan2-meter-verdict ${vClass}`}>{verdict}</span>
      </div>
      <div className="plan2-meter-bar"><span className={`plan2-meter-fill ${over ? 'is-over' : ''}`} style={{ width: `${pct}%` }} /></div>
      <div className="plan2-meter-foot">
        <span>filled <span className="n big">{filled}h</span></span>
        <span>of <span className="n">{cap}h</span> {capacity?.hasUrl ? 'after meetings' : 'available'}</span>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Render meter + whole-story button**

In `TopUpSection`, render `<TopUpMeter committed={cockpit.data.currentSprintCommittedHours}
pulled={pulledHoursThisSession} capacity={cockpit.data.currentSprintCapacity}
sprintName={here} />` under the `SectionHead`, before the rows. Thread `pulledHours` +
`currentSprintCommittedHours` into the section's props.

In `TopUpRow` actions, when `story.canPullStory`, add a secondary button before the
tasks button:
```tsx
{story.canPullStory && (
  <button type="button" className="plan2-act plan2-topup-storypull" disabled={rowBusy}
    onClick={() => void onPullStoryWhole(story)} title="Move the whole story (and its tasks) into the current sprint">
    Pull story in
  </button>
)}
```
Pass `onPullStoryWhole` down. Update `onTopUp` call sites to pass the third `creditHours` arg
(`story.pullableHours` for pull-all-tasks; `task.remainingWork ?? task.originalEstimate ?? 0`
for the single task).

- [ ] **Step 5:** `npx tsc -b` clean.
- [ ] **Step 6: Commit** `git add src/components/PlanView.tsx && git commit -m "feat: top-up hours meter + whole-story pull"`

---

### Task 6: Daily Sprint-time card — one hours story

**Files:** `src/components/Dashboard.tsx` (SprintTimeCard ~1439)

- [ ] **Step 1: Bar tracks hours, not days**

```ts
const pctLeft = available > 0
  ? Math.max(0, Math.min(100, Math.round((availableLeft / available) * 100)))
  : 0;
```
(`available` = whole-sprint after-meetings hours; `availableLeft` = remaining.)

- [ ] **Step 2: Remove the orphan `of-line`** and rewrite the caption to one sentence:

```tsx
{/* removed: <p className="of-line">of {available}h …</p> */}
<div className="bar" aria-hidden="true"><i style={{ width: `${pctLeft}%` }} /></div>
<p className="caption">
  {workingDaysLeft <= 0
    ? `Last working day — ${availableLeft}h of ${available}h still open`
    : `${workingDaysLeft} working day${workingDaysLeft === 1 ? '' : 's'} left — ${availableLeft}h of ${available}h still open`}
</p>
```

- [ ] **Step 3:** `npx tsc -b` clean; `npm run build` ok.
- [ ] **Step 4: Commit** `git add src/components/Dashboard.tsx && git commit -m "fix: Daily Sprint-time card reads as one hours story"`

---

### Task 7: Left rail — gray weekends + count working days

**Files:** `src/lib/time.ts`, `src/components/Dashboard.tsx`, `src/styles/dashboard.css`

- [ ] **Step 1: `isOff` on SprintDay**

In `sprintDays`, add `isOff: (d.getDay() === 5 || d.getDay() === 6)` to each returned day, and
add `isOff: boolean` to the `SprintDay` type.

- [ ] **Step 2: Rail cell + header**

In the rail (~line 600): add `is-off` to the cell class when `d.isOff`. Change the header count
from calendar `today/totalDays` to working days. The card already gets `today`/`totalDays`
(calendar). Pass the capacity working-day numbers into the rail instead: thread
`workingDayOfSprint` (compute = workingDaysTotal − workingDaysRemaining + 1, clamped) and
`workingDaysTotal` from `data.capacity`, show `day {workingDayOfSprint} / {workingDaysTotal}`.
If wiring capacity into the rail is awkward, compute working-day-of-N from `railDays`
(count non-off days up to & including today) — pure client, no new prop. Prefer the railDays
count (keeps the rail self-contained, DRY with what it already renders).

- [ ] **Step 3: CSS** — `src/styles/dashboard.css`:
```css
.r21-side-week-cell.is-off { opacity: 0.4; color: var(--ink-4); }
```
(match existing is-past/is-future treatment; weekends should read clearly as off, not just
slightly dim — check against the live look and deepen if needed.)

- [ ] **Step 4:** `npx tsc -b` clean; `npm run build` ok.
- [ ] **Step 5: Commit** `git add src/lib/time.ts src/components/Dashboard.tsx src/styles/dashboard.css && git commit -m "fix: left rail grays weekends + counts working days"`

---

## After all tasks

- `npm test` → all green.  `npm run build` → clean.
- Flag for Moran: dashboard restart + hard-refresh, AND an MCP reload is NOT needed (no MCP
  tool changed) — but the relaxed move-rule IS in `setIterationPath`, which the MCP
  `workitem_edit` tool also calls, so a chat that's open will pick up the relaxed rule only
  after its own `/exit` + `claude --resume`. Live smoke per the spec.
```
