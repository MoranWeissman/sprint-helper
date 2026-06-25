# Top up the current sprint — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "Top up this sprint" section to the Plan page that lists Moran's open out-of-sprint stories and pulls their open tasks into the current (running) sprint, with one obvious button per story that states the hours it will add.

**Architecture:** A pure `groupTopUp(stories, tasks)` in `server/planning-cockpit.ts` groups open tasks under their parent stories, computes pullable hours, and a location label. `buildCockpitPayload` exposes `topUpStories`. `PlanView` renders a new `TopUpSection` below the numbered steps; each pull calls the EXISTING `postCarryForward(taskIds)` (current sprint resolved server-side), then refetches the cockpit.

**Tech Stack:** TypeScript, React 18, Vite middleware, Vitest 4.

---

### Task 1: Pure `groupTopUp` helper + unit tests

**Files:**
- Modify: `server/planning-cockpit.ts` (add types + exported pure helper)
- Test: `server/topup.test.ts` (new)

- [ ] **Step 1: Read the existing backlog/open-story types** to match field names + the `displayNameFor` / `classifyIterationLevel` / `isSprintLevel` / `DEAD_STATES` helpers already in the file.

Run: `sed -n '1,100p' server/planning-cockpit.ts`
Expected: see `CockpitBacklogStory`, `DEAD_STATES`, `displayNameFor`, imports from `./iteration-paths`.

- [ ] **Step 2: Add the types and the pure helper**

Add near the other cockpit interfaces:

```ts
export interface CockpitTopUpTask {
  id: number;
  title: string;
  displayName: string;
  state: string;
  type: string;
  remainingWork?: number;
  originalEstimate?: number;
}

export interface CockpitTopUpStory {
  id: number;
  title: string;
  displayName: string;
  type: string;
  state: string;
  /** Where the story lives now: a sprint name (e.g. "26_12") or "Backlog". */
  locationLabel: string;
  /** Sum of open-task remaining (or estimate) hours — what a full pull adds. */
  pullableHours: number;
  openTasks: CockpitTopUpTask[];
}
```

Then the exported pure function (takes already-fetched lists so it's testable with no ADO):

```ts
/**
 * Group open out-of-sprint TASKS under their parent open STORIES, for the
 * "top up this sprint" section. Pure — caller supplies both lists.
 * Only tasks ever move (Moran's carryover rule); the story stays put.
 */
export function groupTopUp(stories: WorkItem[], tasks: WorkItem[]): CockpitTopUpStory[] {
  const liveStories = stories.filter(s => !DEAD_STATES.has(s.state.trim().toLowerCase()));
  const byParent = new Map<number, WorkItem[]>();
  for (const t of tasks) {
    if (DEAD_STATES.has(t.state.trim().toLowerCase())) continue;
    if (t.parentId == null) continue;
    const list = byParent.get(t.parentId) ?? [];
    list.push(t);
    byParent.set(t.parentId, list);
  }

  const out: CockpitTopUpStory[] = liveStories.map(s => {
    const childTasks = byParent.get(s.id) ?? [];
    const openTasks: CockpitTopUpTask[] = childTasks.map(t => ({
      id: t.id,
      title: t.title,
      displayName: displayNameFor(t.id, t.title),
      state: t.state,
      type: t.type,
      remainingWork: t.remainingWork,
      originalEstimate: t.originalEstimate,
    }));
    const pullableHours = Math.round(
      openTasks.reduce((sum, t) => sum + (t.remainingWork ?? t.originalEstimate ?? 0), 0),
    );
    return {
      id: s.id,
      title: s.title,
      displayName: displayNameFor(s.id, s.title),
      type: s.type,
      state: s.state,
      locationLabel: topUpLocationLabel(s.iterationPath),
      pullableHours,
      openTasks,
    };
  });

  // Stories with pullable hours first (most hours first); task-less stories last.
  out.sort((a, b) => {
    if ((a.pullableHours > 0) !== (b.pullableHours > 0)) return a.pullableHours > 0 ? -1 : 1;
    if (b.pullableHours !== a.pullableHours) return b.pullableHours - a.pullableHours;
    return b.id - a.id;
  });
  return out;
}

function topUpLocationLabel(iterationPath: string): string {
  if (isSprintLevel(iterationPath)) return iterationPath.split('\\').pop() ?? iterationPath;
  return 'Backlog';
}
```

Make sure `isSprintLevel` is imported from `./iteration-paths` (the file already imports `classifyIterationLevel`/`isSprintLevel` — confirm `isSprintLevel` is in that import; add it if missing).

- [ ] **Step 3: Write the failing tests** — `server/topup.test.ts`

```ts
import { describe, it, expect } from 'vitest';
import { groupTopUp } from './planning-cockpit';
import type { WorkItem } from './ado';

function wi(p: Partial<WorkItem> & { id: number }): WorkItem {
  return {
    id: p.id, rev: 1, type: p.type ?? 'Task', title: p.title ?? `Item ${p.id}`,
    state: p.state ?? 'New', assignedTo: 'me',
    iterationPath: p.iterationPath ?? 'IDP - DevOps\\Backlog', areaPath: 'A',
    changedDate: '2026-06-20T00:00:00Z', url: `https://x/${p.id}`,
    parentId: p.parentId, remainingWork: p.remainingWork, originalEstimate: p.originalEstimate,
  } as WorkItem;
}

describe('groupTopUp', () => {
  it('groups open tasks under their parent story and sums pullable hours', () => {
    const stories = [wi({ id: 1, type: 'User Story', title: 'Story one', iterationPath: 'IDP - DevOps\\2026\\Q2\\26_12' })];
    const tasks = [
      wi({ id: 11, parentId: 1, remainingWork: 5 }),
      wi({ id: 12, parentId: 1, remainingWork: 3 }),
    ];
    const r = groupTopUp(stories, tasks);
    expect(r).toHaveLength(1);
    expect(r[0].openTasks).toHaveLength(2);
    expect(r[0].pullableHours).toBe(8);
    expect(r[0].locationLabel).toBe('26_12');
  });

  it('falls back to originalEstimate when remaining is blank, and labels backlog', () => {
    const stories = [wi({ id: 2, type: 'User Story', iterationPath: 'IDP - DevOps\\Backlog' })];
    const tasks = [wi({ id: 21, parentId: 2, originalEstimate: 4 })];
    const r = groupTopUp(stories, tasks);
    expect(r[0].pullableHours).toBe(4);
    expect(r[0].locationLabel).toBe('Backlog');
  });

  it('drops dead stories and dead tasks', () => {
    const stories = [
      wi({ id: 3, type: 'User Story', state: 'Closed' }),
      wi({ id: 4, type: 'User Story', state: 'Active' }),
    ];
    const tasks = [
      wi({ id: 41, parentId: 4, state: 'Removed', remainingWork: 9 }),
      wi({ id: 42, parentId: 4, state: 'Active', remainingWork: 2 }),
    ];
    const r = groupTopUp(stories, tasks);
    expect(r.map(s => s.id)).toEqual([4]);
    expect(r[0].pullableHours).toBe(2); // removed task excluded
  });

  it('shows a story with no open tasks (pullableHours 0), sorted last', () => {
    const stories = [
      wi({ id: 5, type: 'User Story', state: 'New' }),                 // no tasks
      wi({ id: 6, type: 'User Story', state: 'Active' }),              // has tasks
    ];
    const tasks = [wi({ id: 61, parentId: 6, remainingWork: 7 })];
    const r = groupTopUp(stories, tasks);
    expect(r.map(s => s.id)).toEqual([6, 5]); // hours-bearing first, task-less last
    expect(r[1].pullableHours).toBe(0);
    expect(r[1].openTasks).toHaveLength(0);
  });
});
```

- [ ] **Step 4: Run the tests**

Run: `npm test -- topup`
Expected: 4 pass. Fix `groupTopUp` if any fail (the test is the spec).

- [ ] **Step 5: Typecheck + full suite**

Run: `npx tsc -b && npm test`
Expected: no new tsc errors; all green (98 total).

- [ ] **Step 6: Commit**

```bash
git add server/planning-cockpit.ts server/topup.test.ts
git commit -m "feat: groupTopUp — group open out-of-sprint tasks under their stories"
```

---

### Task 2: Wire `topUpStories` into the cockpit payload

**Files:**
- Modify: `server/planning-cockpit.ts`

- [ ] **Step 1: Add the fetch + collect function**

Add after `collectBacklogStories`:

```ts
async function collectTopUpStories(
  currentIteration: Iteration | null,
): Promise<CockpitTopUpStory[]> {
  if (!currentIteration) return [];
  try {
    const [stories, tasks] = await Promise.all([
      listMyOpenStoriesNotInSprint(currentIteration.path),
      listMyOpenTasksNotInSprint(currentIteration.path),
    ]);
    return groupTopUp(stories, tasks);
  } catch {
    return []; // best-effort, like collectBacklogStories — don't break the page
  }
}
```

Add `listMyOpenTasksNotInSprint` to the existing import from `./ado` (it already imports
`listMyOpenStoriesNotInSprint`).

- [ ] **Step 2: Add to the payload interface + builder**

In `CockpitPayload` add `topUpStories: CockpitTopUpStory[];`.

In `buildCockpitPayload`, after `backlogStories` is built, add:

```ts
const topUpStories = await collectTopUpStories(currentIteration);
```

and include `topUpStories` in the returned object.

- [ ] **Step 3: Typecheck**

Run: `npx tsc -b`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add server/planning-cockpit.ts
git commit -m "feat: expose topUpStories on the cockpit payload"
```

---

### Task 3: Mirror the types on the client API

**Files:**
- Modify: `src/lib/api.ts`

- [ ] **Step 1: Find the cockpit payload type** to add the field

Run: `grep -n "ApiCockpitBacklogStory\|ApiCockpitPayload\|ApiCockpitOpenTask" src/lib/api.ts`

- [ ] **Step 2: Add the mirrored types + payload field**

```ts
export interface ApiCockpitTopUpTask {
  id: number;
  title: string;
  displayName: string;
  state: string;
  type: string;
  remainingWork?: number;
  originalEstimate?: number;
}

export interface ApiCockpitTopUpStory {
  id: number;
  title: string;
  displayName: string;
  type: string;
  state: string;
  locationLabel: string;
  pullableHours: number;
  openTasks: ApiCockpitTopUpTask[];
}
```

Add `topUpStories: ApiCockpitTopUpStory[];` to `ApiCockpitPayload`.

- [ ] **Step 3: Typecheck**

Run: `npx tsc -b`
Expected: clean (PlanView doesn't consume it yet — fine).

- [ ] **Step 4: Commit**

```bash
git add src/lib/api.ts
git commit -m "feat: ApiCockpitTopUpStory types on the cockpit payload"
```

---

### Task 4: TopUpSection in PlanView

**Files:**
- Modify: `src/components/PlanView.tsx`

- [ ] **Step 1: Import the new types + the existing carry-forward helper**

Add `ApiCockpitTopUpStory`, `ApiCockpitTopUpTask` to the `../lib/api` type imports, and
`postCarryForward` to the value imports (confirm it's exported there).

- [ ] **Step 2: Add the parent handler** (near `onPullBacklog`)

```ts
const onTopUp = async (storyOrTaskKey: number, taskIds: number[]) => {
  if (taskIds.length === 0) return;
  setActingOn(storyOrTaskKey);
  setActionError(null);
  try {
    await postCarryForward(taskIds); // resolves current sprint server-side; moves tasks only
    await refreshCockpit();
  } catch (err) {
    setActionError(err instanceof Error ? err.message : 'Pull failed');
  } finally {
    setActingOn(null);
  }
};
```

- [ ] **Step 3: Render the section** after `<SanityCheckSection ... />`:

```tsx
<TopUpSection cockpit={cockpit} actingOn={actingOn} onTopUp={onTopUp} onOpenItem={onOpenItem} />
```

- [ ] **Step 4: Add the components** (bottom of the file, with the other sections)

```tsx
/* -------------------------------------------------------------------------- */
/*  Top up the current sprint (any-time, below the numbered steps)            */
/* -------------------------------------------------------------------------- */

function TopUpSection({
  cockpit,
  actingOn,
  onTopUp,
  onOpenItem,
}: {
  cockpit: CockpitState;
  actingOn: number | null;
  onTopUp: (key: number, taskIds: number[]) => Promise<void>;
  onOpenItem?: (id: string) => void;
}) {
  if (cockpit.status !== 'ok') return null;
  const { currentSprint, topUpStories } = cockpit.data;
  const here = currentSprint?.name ?? 'this sprint';

  return (
    <section className="plan2-section plan2-topup">
      <SectionHead
        title="Top up this sprint"
        note={`pull tasks from your other stories into ${here}`}
      />
      {topUpStories.length === 0 ? (
        <div className="plan2-empty">No other open stories — nothing to pull in.</div>
      ) : (
        <ul className="plan2-rows">
          {topUpStories.map(story => (
            <TopUpRow
              key={story.id}
              story={story}
              busy={actingOn === story.id || story.openTasks.some(t => t.id === actingOn)}
              onTopUp={onTopUp}
              onOpenItem={onOpenItem}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

function TopUpRow({
  story,
  busy,
  onTopUp,
  onOpenItem,
}: {
  story: ApiCockpitTopUpStory;
  busy: boolean;
  onTopUp: (key: number, taskIds: number[]) => Promise<void>;
  onOpenItem?: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const stateClass = classifyState(story.state);
  const kind = story.type.toLowerCase() === 'bug' ? 'bug' : 'story';
  const hasTasks = story.openTasks.length > 0;
  const allTaskIds = story.openTasks.map(t => t.id);

  return (
    <li className={`plan2-row is-${stateClass} ${hasTasks ? '' : 'plan2-topup-empty'}`}>
      <div className="plan2-row-main">
        <button
          type="button"
          className={`plan2-chevron-btn ${hasTasks ? '' : 'is-hidden'}`}
          onClick={() => hasTasks && setOpen(o => !o)}
          aria-expanded={open}
          aria-label={open ? 'Hide tasks' : 'Show tasks'}
          disabled={!hasTasks}
        >
          <span className={`plan2-chevron ${open ? 'is-open' : ''}`} aria-hidden="true">▸</span>
        </button>
        <KindBadge kind={kind} />
        <StateChip state={story.state} />
        <button
          type="button"
          className="plan2-title plan2-title-btn"
          onClick={() => onOpenItem?.(String(story.id))}
          disabled={!onOpenItem}
          title="Open story details"
        >
          <span className="t">{story.title}</span>
          <span className="id">#{story.id}</span>
        </button>
        <span className="plan2-topup-loc" title="Where this story lives now">{story.locationLabel}</span>
        <span className="plan2-actions">
          {hasTasks ? (
            <button
              type="button"
              className="plan2-act plan2-act-pull plan2-topup-pull"
              disabled={busy}
              onClick={() => void onTopUp(story.id, allTaskIds)}
              title={`Move this story's ${story.openTasks.length} open task${story.openTasks.length === 1 ? '' : 's'} into the current sprint`}
            >
              {busy ? '…' : <>Pull <b>{story.pullableHours}h</b> in →</>}
            </button>
          ) : (
            <span className="plan2-topup-notasks" title="No open tasks to pull — hours live on tasks.">
              no tasks yet
            </span>
          )}
        </span>
      </div>
      {open && hasTasks && (
        <ul className="plan2-rows plan2-subrows">
          {story.openTasks.map(task => (
            <TopUpTaskRow
              key={task.id}
              task={task}
              busy={actingOnTask(busy)}
              onPull={() => void onTopUp(task.id, [task.id])}
              onOpenItem={onOpenItem}
            />
          ))}
        </ul>
      )}
    </li>
  );
}

// busy flows from the parent row; a per-task pull disables the whole story's controls
// while in flight, which is fine — one action at a time on the page.
function actingOnTask(rowBusy: boolean): boolean { return rowBusy; }

function TopUpTaskRow({
  task,
  busy,
  onPull,
  onOpenItem,
}: {
  task: ApiCockpitTopUpTask;
  busy: boolean;
  onPull: () => void;
  onOpenItem?: (id: string) => void;
}) {
  const rem = task.remainingWork ?? task.originalEstimate;
  const remText = rem != null ? `${Math.round(rem)}h` : '—';
  return (
    <li className="plan2-subrow plan2-row">
      <span className="plan2-chevron is-spacer" aria-hidden="true">▸</span>
      <KindBadge kind={kindFromType(task.type)} />
      <StateChip state={task.state} />
      <button
        type="button"
        className="plan2-title plan2-title-btn"
        onClick={() => onOpenItem?.(String(task.id))}
        disabled={!onOpenItem}
        title="Open task details"
      >
        <span className="t">{task.title}</span>
        <span className="id">#{task.id}</span>
      </button>
      <span className="plan2-meta">
        <span className="plan2-stat"><span className="l">remaining</span><span className="v">{remText}</span></span>
      </span>
      <span className="plan2-actions">
        <button type="button" className="plan2-act plan2-act-pull" disabled={busy} onClick={onPull}>
          + pull
        </button>
      </span>
    </li>
  );
}
```

(If `useState` isn't already imported in PlanView, it is — the file uses it heavily. Confirm.)

- [ ] **Step 5: Typecheck**

Run: `npx tsc -b`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/components/PlanView.tsx
git commit -m "feat: Top up this sprint section on the Plan page"
```

---

### Task 5: Styling — make it look easy

**Files:**
- Modify: `src/styles/dashboard.css`

- [ ] **Step 1: Find the plan2 section + pull-button styles to extend**

Run: `grep -n "plan2-section\|plan2-act-pull\|plan2-chevron\|plan2-empty\|plan2-row-main" src/styles/dashboard.css | head`

- [ ] **Step 2: Add `plan2-topup-*` rules** near the other `plan2-` blocks

```css
/* Top up this sprint — set apart from the numbered steps above it. */
.plan2-topup { border-top: 1px solid var(--line-soft); margin-top: 28px; padding-top: 20px; }

/* The hours-on-button: the primary, obvious action. Bigger, accent-filled. */
.plan2-topup-pull { font-size: 13px; padding: 6px 14px; }
.plan2-topup-pull b { font-weight: 700; }

.plan2-topup-loc {
  font-size: 11px; color: var(--ink-3);
  padding: 2px 8px; border-radius: 999px;
  border: 1px solid var(--line-soft);
  white-space: nowrap;
}

/* Task-less story: present but clearly nothing to do. */
.plan2-topup-empty { opacity: 0.6; }
.plan2-topup-notasks { font-size: 12px; color: var(--ink-3); font-style: italic; }

.plan2-chevron-btn { appearance: none; background: transparent; border: 0; cursor: pointer; padding: 0 2px; color: var(--ink-3); }
.plan2-chevron-btn.is-hidden { visibility: hidden; cursor: default; }
.plan2-chevron.is-open { transform: rotate(90deg); }
.plan2-chevron { display: inline-block; transition: transform 0.15s ease; }
```

Use the real token names from Step 1 (`--line-soft`, `--ink-3`). Match the existing
`.plan2-act-pull` accent treatment — if it already has a strong fill, the `-topup-pull` rule
just sizes it up; don't recolor away from the page's accent.

- [ ] **Step 3: Build**

Run: `npm run build`
Expected: succeeds.

- [ ] **Step 4: Commit**

```bash
git add src/styles/dashboard.css
git commit -m "style: Top up this sprint section"
```

---

## After all tasks

- `npm test` → all green (98).
- `npm run build` → clean.
- Flag for Moran: dashboard dev-server restart (`npm run dev`) + hard-refresh, then the live
  smoke from the spec. The section sits at the bottom of the Plan page, under "Sanity check".
```
