# Pre-plan Page Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the Pre-plan page — a private prep screen where Moran reviews each carried story before the bi-weekly pre-plan meeting, sets a finish/blocked/carryover call, and links stories to the PM's pasted sprint goals.

**Architecture:** Mirrors the Plan page end-to-end. A new `server/preplan.ts` builds a payload from the cached dashboard + capacity and holds pure suggestion/coverage helpers; per-sprint state (goals, calls, links) lives in one settings JSON row. A `GET`/`POST /api/preplan` middleware pair in `vite.config.ts` serves it. A new `PrePlanView.tsx` renders it, routed when `mode === 'preplan'` (replacing the placeholder for that mode only).

**Tech Stack:** TypeScript, Vite + React 18, Vitest 4 (`vitest run`), better-sqlite3 via existing `getSetting`/`setSetting`. No new dependencies. No ADO writes. No MCP change.

## Global Constraints

- **Nothing writes to Azure DevOps from this page.** Calls/goals/links are local-only (settings table). Including "blocked" — never flip ADO state from here.
- **Plain English everywhere** (UI copy, empty states). No jargon: no "slack", "burndown", "WIP", "scope" (noun), "velocity", "work item". Say "story"/"task".
- **Suggest-then-override, never silent auto-assign** — both the call suggestion and the goal-link suggestion are pre-filled but always one tap to change.
- **No per-story room math** — room left is a single sprint-wide number; the per-story call suggestion uses only blocked + idle-days, never a per-story hours-fit.
- **Never auto-suggest "carries over"** — `suggestCall` returns only `'on-track'` or `'at-risk'`.
- **Pure layer takes `now` as a parameter** — no `Date.now()` inside testable functions (matches repo convention; keeps tests deterministic).
- Repo convention: pure logic in `server/*.ts` is unit-tested; vite middleware + React glue are NOT unit-tested (Moran live-smokes). Commit per task. Run `npm test` + `npx tsc -b` before each commit.
- Backend/API changes need a **dashboard dev-server restart** to take effect (Vite doesn't HMR backend code). No `claude --resume` needed.

## Type definitions (shared vocabulary — defined in Task 1, used throughout)

```ts
// server/preplan.ts
export type PrePlanCall = 'on-track' | 'at-risk' | 'carries-over';

export interface PrePlanCard {
  id: string;
  displayName: string;          // **title** (#id)
  remainingHours: number;
  blocked: boolean;
  lastActivityAt: string | null; // ISO, or null when no activity logged
  call: PrePlanCall;            // saved value, else the suggestion
  callIsSuggested: boolean;     // true when `call` still equals the page's suggestion (unreviewed)
  goalIndex: number | null;     // saved link, else the suggestion, else null
}

export interface PrePlanRoomLine {
  openStoriesRemainingHours: number;
  roomHours: number;            // availableHoursRemaining from capacity
  hasCapacity: boolean;         // false when no calendar — hide the line
}

export interface PrePlanCoverageGoal {
  index: number;                // 0-based; UI shows index+1
  text: string;
  storyCount: number;
}

export interface PrePlanPayload {
  sprintName: string;
  goals: string[];
  cards: PrePlanCard[];
  coverage: PrePlanCoverageGoal[]; // empty when no goals
  room: PrePlanRoomLine;
}

// The stored blob (settings key `preplan_<sprintName>`)
export interface PrePlanState {
  goals: string[];
  stories: Record<string, { call?: PrePlanCall; goalIndex?: number | null }>;
}
```

---

### Task 1: Pure suggestion + coverage helpers (`server/preplan.ts` core)

The testable heart: given facts, decide a call; given a title + goals, suggest a goal; given cards + goals, summarize coverage. No I/O, no dashboard — pure functions.

**Files:**
- Create: `server/preplan.ts` (types above + the three pure functions; payload builder comes in Task 3)
- Create: `server/preplan.test.ts`

**Interfaces:**
- Produces: `suggestCall(opts: { blocked: boolean; lastActivityAt: string | null; remainingHours: number; now: Date; idleWorkingDaysThreshold?: number }): 'on-track' | 'at-risk'`
- Produces: `suggestGoalIndex(storyTitle: string, goals: string[]): number | null`
- Produces: `summarizeCoverage(cards: Array<{ goalIndex: number | null }>, goals: string[]): PrePlanCoverageGoal[]`
- Produces: `workingDaysBetween(from: Date, to: Date): number` (Sun–Thu working days; Fri/Sat skipped — matches [[feedback-capacity-preferences]])
- Produces: the type exports listed above.

- [ ] **Step 1: Write the failing test**

Create `server/preplan.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  suggestCall,
  suggestGoalIndex,
  summarizeCoverage,
  workingDaysBetween,
} from './preplan';

const NOW = new Date('2026-06-25T12:00:00Z'); // a Thursday

describe('workingDaysBetween', () => {
  it('counts Sun-Thu and skips Fri/Sat', () => {
    // Sun 2026-06-21 -> Thu 2026-06-25 = 4 working days elapsed
    expect(workingDaysBetween(new Date('2026-06-21T12:00:00Z'), NOW)).toBe(4);
  });
  it('is 0 for the same day', () => {
    expect(workingDaysBetween(NOW, NOW)).toBe(0);
  });
});

describe('suggestCall', () => {
  it('suggests at-risk when blocked', () => {
    expect(
      suggestCall({ blocked: true, lastActivityAt: NOW.toISOString(), remainingHours: 5, now: NOW }),
    ).toBe('at-risk');
  });
  it('suggests at-risk when idle 3+ working days with hours left', () => {
    expect(
      suggestCall({
        blocked: false,
        lastActivityAt: '2026-06-21T12:00:00Z', // 4 working days ago
        remainingHours: 5,
        now: NOW,
      }),
    ).toBe('at-risk');
  });
  it('suggests on-track when recently active', () => {
    expect(
      suggestCall({
        blocked: false,
        lastActivityAt: '2026-06-24T12:00:00Z', // 1 working day ago
        remainingHours: 5,
        now: NOW,
      }),
    ).toBe('on-track');
  });
  it('suggests on-track when idle but no hours remain', () => {
    expect(
      suggestCall({
        blocked: false,
        lastActivityAt: '2026-06-21T12:00:00Z',
        remainingHours: 0,
        now: NOW,
      }),
    ).toBe('on-track');
  });
  it('suggests at-risk when never active but hours remain and sprint has run', () => {
    // null activity is treated as "no activity yet" -> at-risk only if hours remain
    expect(
      suggestCall({ blocked: false, lastActivityAt: null, remainingHours: 5, now: NOW }),
    ).toBe('at-risk');
  });
  it('never returns carries-over', () => {
    const r = suggestCall({ blocked: true, lastActivityAt: null, remainingHours: 99, now: NOW });
    expect(r).not.toBe('carries-over');
  });
});

describe('suggestGoalIndex', () => {
  const goals = ['Improve ArgoCD rollout confidence', 'Migrate Datadog helm values'];
  it('matches the obvious goal by shared words', () => {
    expect(suggestGoalIndex('Validate addon rollout from prod ArgoCD', goals)).toBe(0);
  });
  it('returns null when overlap is weak', () => {
    expect(suggestGoalIndex('Unrelated database backup chore', goals)).toBeNull();
  });
  it('returns null when there are no goals', () => {
    expect(suggestGoalIndex('anything', [])).toBeNull();
  });
});

describe('summarizeCoverage', () => {
  const goals = ['Goal A', 'Goal B', 'Goal C'];
  it('counts stories per goal and flags uncovered goals', () => {
    const cards = [{ goalIndex: 0 }, { goalIndex: 0 }, { goalIndex: 2 }];
    const cov = summarizeCoverage(cards, goals);
    expect(cov).toEqual([
      { index: 0, text: 'Goal A', storyCount: 2 },
      { index: 1, text: 'Goal B', storyCount: 0 },
      { index: 2, text: 'Goal C', storyCount: 1 },
    ]);
  });
  it('returns empty when there are no goals', () => {
    expect(summarizeCoverage([{ goalIndex: null }], [])).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run server/preplan.test.ts`
Expected: FAIL — cannot find module `./preplan`.

- [ ] **Step 3: Write the pure module**

Create `server/preplan.ts`:

```ts
/**
 * Pre-plan page — pure logic + payload builder + local state I/O.
 *
 * This page is Moran's PRIVATE prep for the bi-weekly pre-plan meeting. Nothing
 * here writes to Azure DevOps. Calls/goals/links live in the settings table.
 * See docs/superpowers/specs/2026-06-25-preplan-page-design.md.
 */

export type PrePlanCall = 'on-track' | 'at-risk' | 'carries-over';

export interface PrePlanCard {
  id: string;
  displayName: string;
  remainingHours: number;
  blocked: boolean;
  lastActivityAt: string | null;
  call: PrePlanCall;
  callIsSuggested: boolean;
  goalIndex: number | null;
}

export interface PrePlanRoomLine {
  openStoriesRemainingHours: number;
  roomHours: number;
  hasCapacity: boolean;
}

export interface PrePlanCoverageGoal {
  index: number;
  text: string;
  storyCount: number;
}

export interface PrePlanPayload {
  sprintName: string;
  goals: string[];
  cards: PrePlanCard[];
  coverage: PrePlanCoverageGoal[];
  room: PrePlanRoomLine;
}

export interface PrePlanState {
  goals: string[];
  stories: Record<string, { call?: PrePlanCall; goalIndex?: number | null }>;
}

const MS_PER_DAY = 1000 * 60 * 60 * 24;
const IDLE_WORKING_DAYS_THRESHOLD = 3;

/** Working days (Sun–Thu) elapsed from `from` to `to`. Fri(5)/Sat(6) skipped. */
export function workingDaysBetween(from: Date, to: Date): number {
  if (to <= from) return 0;
  let count = 0;
  // Walk whole days from the day after `from` through `to`.
  const cursor = new Date(from.getTime());
  while (cursor.getTime() < to.getTime()) {
    cursor.setTime(cursor.getTime() + MS_PER_DAY);
    const dow = cursor.getDay(); // 0=Sun … 6=Sat
    if (dow !== 5 && dow !== 6) count++;
  }
  return count;
}

/**
 * Suggest a call from facts the page can read honestly on ONE story. Never
 * returns 'carries-over' (a deliberate planning act, not a guess) and never
 * uses sprint-wide room (shared across stories — see the spec).
 */
export function suggestCall(opts: {
  blocked: boolean;
  lastActivityAt: string | null;
  remainingHours: number;
  now: Date;
  idleWorkingDaysThreshold?: number;
}): 'on-track' | 'at-risk' {
  const threshold = opts.idleWorkingDaysThreshold ?? IDLE_WORKING_DAYS_THRESHOLD;
  if (opts.blocked) return 'at-risk';
  if (opts.remainingHours <= 0) return 'on-track';
  if (opts.lastActivityAt == null) return 'at-risk'; // hours remain, nothing logged
  const idle = workingDaysBetween(new Date(opts.lastActivityAt), opts.now);
  return idle >= threshold ? 'at-risk' : 'on-track';
}

const STOPWORDS = new Set([
  'the', 'a', 'an', 'to', 'of', 'in', 'on', 'for', 'and', 'or', 'from', 'with',
  'is', 'are', 'be', 'this', 'that', 'it', 'as', 'at', 'by', 'we', 'our',
]);

function tokenize(s: string): Set<string> {
  return new Set(
    s
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter(t => t.length > 1 && !STOPWORDS.has(t)),
  );
}

/**
 * Suggest which pasted goal a story serves, by token overlap. Returns null when
 * the best overlap is weak — a wrong link is worse than none (suggest-then-confirm).
 */
export function suggestGoalIndex(storyTitle: string, goals: string[]): number | null {
  if (goals.length === 0) return null;
  const titleTokens = tokenize(storyTitle);
  if (titleTokens.size === 0) return null;
  let bestIdx = -1;
  let bestOverlap = 0;
  goals.forEach((g, i) => {
    const gTokens = tokenize(g);
    let overlap = 0;
    for (const t of gTokens) if (titleTokens.has(t)) overlap++;
    if (overlap > bestOverlap) {
      bestOverlap = overlap;
      bestIdx = i;
    }
  });
  // Require at least 2 shared meaningful words to call it a match.
  return bestOverlap >= 2 ? bestIdx : null;
}

/** Per-goal story counts, in goal order. Empty when there are no goals. */
export function summarizeCoverage(
  cards: Array<{ goalIndex: number | null }>,
  goals: string[],
): PrePlanCoverageGoal[] {
  return goals.map((text, index) => ({
    index,
    text,
    storyCount: cards.filter(c => c.goalIndex === index).length,
  }));
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run server/preplan.test.ts && npx tsc -b`
Expected: test PASS (all describe blocks green); `tsc -b` exit 0.

> Note: if `suggestGoalIndex('Validate addon rollout from prod ArgoCD', ['Improve ArgoCD rollout confidence', ...])` does not reach 2 shared tokens, recount — shared meaningful tokens are `rollout` and `argocd` = 2, so it returns 0. Keep the threshold at 2.

- [ ] **Step 5: Commit**

```bash
git add server/preplan.ts server/preplan.test.ts
git commit -m "feat(preplan): pure call/goal/coverage suggestion helpers"
```

---

### Task 2: Per-sprint state I/O (`getPrePlanState` / `savePrePlanState`)

Read and write Moran's goals/calls/links as one JSON settings row per sprint. Tested against an in-memory DB the way other server state tests run.

**Files:**
- Modify: `server/preplan.ts` (add the two I/O functions + key helper)
- Modify: `server/preplan.test.ts` (add a state round-trip describe block)

**Interfaces:**
- Consumes: `getSetting(key: string): string | undefined` and `setSetting(key: string, value: string): void` from `./timers`.
- Produces: `getPrePlanState(sprintName: string): PrePlanState` (returns `{ goals: [], stories: {} }` when absent or unparseable).
- Produces: `savePrePlanState(sprintName: string, state: PrePlanState): void`.
- Produces: `prePlanSettingsKey(sprintName: string): string` → `preplan_<sprintName>`.

- [ ] **Step 1: Check how existing server-state tests get a DB**

Run: `grep -n "better-sqlite3\|getDb\|setSetting\|beforeEach\|migrate(" server/helper-notes.test.ts | head`
Expected: shows the in-memory DB setup pattern (the test seeds a DB then calls the store fns). Mirror exactly what `helper-notes.test.ts` does for DB setup — same import, same `beforeEach`.

- [ ] **Step 2: Write the failing test**

Add to `server/preplan.test.ts` (keep imports tidy — extend the existing import line and add the same DB-setup block `helper-notes.test.ts` uses, adapting the path):

```ts
import { getPrePlanState, savePrePlanState, prePlanSettingsKey } from './preplan';

describe('pre-plan state I/O', () => {
  // Uses the same in-memory DB setup helper-notes.test.ts uses (see Step 1).
  it('returns empty state when nothing saved', () => {
    expect(getPrePlanState('26_99')).toEqual({ goals: [], stories: {} });
  });

  it('round-trips goals and per-story calls/links', () => {
    savePrePlanState('26_99', {
      goals: ['Goal A', 'Goal B'],
      stories: { '443697': { call: 'carries-over', goalIndex: 1 } },
    });
    const back = getPrePlanState('26_99');
    expect(back.goals).toEqual(['Goal A', 'Goal B']);
    expect(back.stories['443697']).toEqual({ call: 'carries-over', goalIndex: 1 });
  });

  it('keys per sprint', () => {
    expect(prePlanSettingsKey('26_13')).toBe('preplan_26_13');
  });

  it('returns empty state on corrupt JSON', () => {
    // write junk under the key, then read
    savePrePlanState('26_corrupt', { goals: [], stories: {} });
    // overwrite with junk via setSetting directly
    // (import setSetting in the test for this assertion)
  });
});
```

> Implementer: complete the corrupt-JSON test by importing `setSetting` from `./timers`, writing `setSetting(prePlanSettingsKey('26_corrupt'), '{not json')`, then asserting `getPrePlanState('26_corrupt')` deep-equals `{ goals: [], stories: {} }`.

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run server/preplan.test.ts`
Expected: FAIL — `getPrePlanState` / `savePrePlanState` / `prePlanSettingsKey` not exported.

- [ ] **Step 4: Implement the I/O functions**

Add to `server/preplan.ts` (top import + functions):

```ts
import { getSetting, setSetting } from './timers';

export function prePlanSettingsKey(sprintName: string): string {
  return `preplan_${sprintName}`;
}

export function getPrePlanState(sprintName: string): PrePlanState {
  const raw = getSetting(prePlanSettingsKey(sprintName));
  if (!raw) return { goals: [], stories: {} };
  try {
    const parsed = JSON.parse(raw) as Partial<PrePlanState>;
    return {
      goals: Array.isArray(parsed.goals) ? parsed.goals : [],
      stories: parsed.stories && typeof parsed.stories === 'object' ? parsed.stories : {},
    };
  } catch {
    return { goals: [], stories: {} };
  }
}

export function savePrePlanState(sprintName: string, state: PrePlanState): void {
  setSetting(prePlanSettingsKey(sprintName), JSON.stringify(state));
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run server/preplan.test.ts && npx tsc -b`
Expected: PASS; `tsc -b` exit 0.

- [ ] **Step 6: Commit**

```bash
git add server/preplan.ts server/preplan.test.ts
git commit -m "feat(preplan): per-sprint local state read/write"
```

---

### Task 3: Payload builder (`buildPrePlanPayload`)

Assemble the page payload: select carried stories from the cached dashboard, project facts, merge saved state, fill suggestions, compute coverage + room line.

**Files:**
- Modify: `server/preplan.ts` (add `buildPrePlanPayload` + a pure `selectCarriedStories` + `buildCards` helper so selection is testable)
- Modify: `server/preplan.test.ts` (test selection + card-merge with a fake story list)

**Interfaces:**
- Consumes: `buildDashboardCached()` from `./dashboard-cache` → `{ payload }`; `payload.userStories: UserStoryGroup[]`, `payload.outlookCapacity: Capacity | null`, `payload.sprint`.
- Consumes (types): `UserStoryGroup` from `./dashboard`, `Capacity` from `./capacity`.
- Consumes: `getPrePlanState` (Task 2), `suggestCall` / `suggestGoalIndex` / `summarizeCoverage` (Task 1).
- Produces: `buildPrePlanPayload(now?: Date): Promise<PrePlanPayload>`.
- Produces: `selectCarriedStories(stories: UserStoryGroup[]): UserStoryGroup[]` (pure; exported for test).
- Produces: `buildCards(stories: UserStoryGroup[], state: PrePlanState, now: Date): PrePlanCard[]` (pure; exported for test).

Selection rule (`selectCarriedStories`): keep a story when its `type` lower-cased is `'user story'` or `'bug'` (exclude Feature/Epic), AND `state` is not a done state, AND it is "started" — `hasActiveSession === true`, OR `state` is an active state, OR it has at least one task whose state is neither done nor never-started. Use these literal sets (copied from `server/dashboard.ts:213-214`, kept local to avoid a cross-module export churn):

```ts
const DONE_STATES = new Set(['Done', 'Closed', 'Resolved', 'Completed', 'Removed']);
const ACTIVE_STATES = new Set(['Active', 'In Progress', 'Committed', 'Doing']);
```

Blocked detection: `story.state === 'Blocked'` OR `(story.tags ?? []).some(t => t.toLowerCase() === 'blocked')`.

Last activity: `story.recentActivity` is newest-first (per the dashboard JSDoc) → `recentActivity[0]?.createdAt ?? null`.

- [ ] **Step 1: Write the failing test**

Add to `server/preplan.test.ts`:

```ts
import { selectCarriedStories, buildCards } from './preplan';
import type { UserStoryGroup } from './dashboard';

function story(p: Partial<UserStoryGroup> & { id: string }): UserStoryGroup {
  return {
    id: p.id,
    title: p.title ?? `Story ${p.id}`,
    type: p.type ?? 'User Story',
    state: p.state ?? 'Active',
    url: '',
    tasks: p.tasks ?? [],
    totalEstimateHours: 0,
    completedHours: 0,
    remainingHours: p.remainingHours ?? 0,
    counts: { inProgress: 0, upNext: 0, done: 0 },
    recentActivity: p.recentActivity ?? [],
    hasActiveSession: p.hasActiveSession ?? false,
    tags: p.tags,
  } as UserStoryGroup;
}

describe('selectCarriedStories', () => {
  it('keeps active stories, drops done and features and never-started', () => {
    const stories = [
      story({ id: '1', state: 'Active' }),
      story({ id: '2', state: 'Closed' }),
      story({ id: '3', type: 'Feature', state: 'Active' }),
      story({ id: '4', state: 'New', hasActiveSession: false }),
      story({ id: '5', state: 'New', hasActiveSession: true }), // started via live session
    ];
    expect(selectCarriedStories(stories).map(s => s.id)).toEqual(['1', '5']);
  });
});

describe('buildCards', () => {
  const NOW2 = new Date('2026-06-25T12:00:00Z');
  it('uses saved call/link when present, else suggestion', () => {
    const stories = [
      story({ id: '1', title: 'Rollout ArgoCD addon', state: 'Active', remainingHours: 4,
        recentActivity: [{ id: 1, sessionId: 's', workItemId: 1, type: 'progress', text: '', createdAt: '2026-06-24T12:00:00Z' }] }),
      story({ id: '2', state: 'Blocked', remainingHours: 3 }),
    ];
    const state = { goals: ['Improve ArgoCD rollout'], stories: { '1': { call: 'carries-over' as const, goalIndex: 0 } } };
    const cards = buildCards(stories, state, NOW2);
    // story 1: saved call wins, not suggested
    expect(cards[0].call).toBe('carries-over');
    expect(cards[0].callIsSuggested).toBe(false);
    expect(cards[0].goalIndex).toBe(0);
    // story 2: no saved state -> suggestion (blocked => at-risk), marked suggested
    expect(cards[1].call).toBe('at-risk');
    expect(cards[1].callIsSuggested).toBe(true);
    expect(cards[1].blocked).toBe(true);
    expect(cards[1].displayName).toBe('**Story 2** (#2)');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run server/preplan.test.ts`
Expected: FAIL — `selectCarriedStories` / `buildCards` not exported.

- [ ] **Step 3: Implement selection, card-building, and the async builder**

Add to `server/preplan.ts`:

```ts
import { buildDashboardCached } from './dashboard-cache';
import type { UserStoryGroup } from './dashboard';

const DONE_STATES = new Set(['Done', 'Closed', 'Resolved', 'Completed', 'Removed']);
const ACTIVE_STATES = new Set(['Active', 'In Progress', 'Committed', 'Doing']);
const STORY_TYPES = new Set(['user story', 'bug']);

function isStarted(s: UserStoryGroup): boolean {
  if (s.hasActiveSession) return true;
  if (ACTIVE_STATES.has(s.state)) return true;
  return s.tasks.some(t => !DONE_STATES.has(t.state) && ACTIVE_STATES.has(t.state));
}

export function selectCarriedStories(stories: UserStoryGroup[]): UserStoryGroup[] {
  return stories.filter(
    s => STORY_TYPES.has(s.type.toLowerCase()) && !DONE_STATES.has(s.state) && isStarted(s),
  );
}

function isBlocked(s: UserStoryGroup): boolean {
  if (s.state === 'Blocked') return true;
  return (s.tags ?? []).some(t => t.toLowerCase() === 'blocked');
}

export function buildCards(
  stories: UserStoryGroup[],
  state: PrePlanState,
  now: Date,
): PrePlanCard[] {
  return stories.map(s => {
    const saved = state.stories[s.id] ?? {};
    const blocked = isBlocked(s);
    const lastActivityAt = s.recentActivity[0]?.createdAt ?? null;
    const remainingHours = s.remainingHours ?? 0;
    const suggestedCall = suggestCall({ blocked, lastActivityAt, remainingHours, now });
    const call: PrePlanCall = saved.call ?? suggestedCall;
    const suggestedGoal = suggestGoalIndex(s.title, state.goals);
    const goalIndex = saved.goalIndex !== undefined ? saved.goalIndex : suggestedGoal;
    return {
      id: s.id,
      displayName: `**${s.title}** (#${s.id})`,
      remainingHours,
      blocked,
      lastActivityAt,
      call,
      callIsSuggested: saved.call === undefined,
      goalIndex,
    };
  });
}

export async function buildPrePlanPayload(now: Date = new Date()): Promise<PrePlanPayload> {
  const { payload } = await buildDashboardCached();
  const sprintName = payload.sprint?.name ?? '';
  const state = getPrePlanState(sprintName);
  const carried = selectCarriedStories(payload.userStories);
  const cards = buildCards(carried, state, now);
  const coverage = summarizeCoverage(cards.map(c => ({ goalIndex: c.goalIndex })), state.goals);
  const openStoriesRemainingHours = Math.round(
    cards.reduce((acc, c) => acc + (c.remainingHours ?? 0), 0),
  );
  const cap = payload.outlookCapacity;
  const room: PrePlanRoomLine = {
    openStoriesRemainingHours,
    roomHours: cap ? Math.round(cap.availableHoursRemaining) : 0,
    hasCapacity: !!cap && cap.hasUrl,
  };
  return { sprintName, goals: state.goals, cards, coverage, room };
}
```

> `callIsSuggested` is `saved.call === undefined` — true means he hasn't reviewed it (still showing the suggestion). The Task-1 test for `buildCards` asserts exactly this.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run server/preplan.test.ts && npx tsc -b`
Expected: PASS (selection + buildCards green); `tsc -b` exit 0.

- [ ] **Step 5: Run full suite**

Run: `npm test`
Expected: all green (existing + new preplan tests).

- [ ] **Step 6: Commit**

```bash
git add server/preplan.ts server/preplan.test.ts
git commit -m "feat(preplan): payload builder + carried-story selection"
```

---

### Task 4: API endpoint (`GET`/`POST /api/preplan`)

Serve the payload and accept granular saves. Mirrors the `/api/planning/cockpit` middleware in `vite.config.ts`.

**Files:**
- Modify: `vite.config.ts` (add one middleware block near `/api/planning/cockpit`, ~line 364)

**Interfaces:**
- Consumes: `buildPrePlanPayload`, `getPrePlanState`, `savePrePlanState` from `./server/preplan` (dynamic `import()` like the cockpit block does).
- GET `/api/preplan` → `PrePlanPayload`.
- POST `/api/preplan` body: `{ goals?: string[]; story?: { id: string; call?: PrePlanCall; goalIndex?: number | null } }` → merges into the per-sprint blob, returns the fresh `PrePlanPayload`.

- [ ] **Step 1: Read the existing cockpit middleware to copy its shape**

Run: `sed -n '364,395p' vite.config.ts`
Expected: shows the `/api/planning/cockpit` handler — how it imports, calls the builder, sets JSON headers, and error-handles. Match this exactly.

- [ ] **Step 2: Add the middleware**

In `vite.config.ts`, immediately after the `/api/planning/cockpit` block, add:

```ts
      server.middlewares.use('/api/preplan', async (req, res) => {
        res.setHeader('Content-Type', 'application/json');
        try {
          const {
            buildPrePlanPayload,
            getPrePlanState,
            savePrePlanState,
          } = await import('./server/preplan');

          if (req.method === 'POST') {
            const chunks: Buffer[] = [];
            for await (const c of req) chunks.push(c as Buffer);
            const body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
            // Resolve the current sprint name server-side (don't trust the client).
            const current = await buildPrePlanPayload();
            const sprintName = current.sprintName;
            const state = getPrePlanState(sprintName);
            if (Array.isArray(body.goals)) {
              state.goals = body.goals.filter((g: unknown) => typeof g === 'string');
            }
            if (body.story && typeof body.story.id === 'string') {
              const prev = state.stories[body.story.id] ?? {};
              state.stories[body.story.id] = {
                call: body.story.call ?? prev.call,
                goalIndex:
                  body.story.goalIndex !== undefined ? body.story.goalIndex : prev.goalIndex,
              };
            }
            savePrePlanState(sprintName, state);
            res.end(JSON.stringify(await buildPrePlanPayload()));
            return;
          }

          res.end(JSON.stringify(await buildPrePlanPayload()));
        } catch (e) {
          res.statusCode = 500;
          res.end(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }));
        }
      });
```

> Note: `buildPrePlanPayload` is called twice on POST (once to learn the sprint name, once to return the merged result). That's two cheap reads off the already-cached dashboard — acceptable for KISS. If a reviewer objects, extract a `currentSprintName()` helper later; don't pre-optimize now.

- [ ] **Step 3: Typecheck**

Run: `npx tsc -b`
Expected: exit 0. (No unit test — vite middleware is glue, smoked live per repo convention.)

- [ ] **Step 4: Commit**

```bash
git add vite.config.ts
git commit -m "feat(preplan): GET/POST /api/preplan endpoint"
```

---

### Task 5: API types + fetch helpers (`src/lib/api.ts`)

Client-side mirror of the payload + the two calls.

**Files:**
- Modify: `src/lib/api.ts` (add types + `fetchPrePlan` / `savePrePlan` near `fetchCockpit`, ~line 640)

**Interfaces:**
- Produces: `ApiPrePlanCall`, `ApiPrePlanCard`, `ApiPrePlanRoomLine`, `ApiPrePlanCoverageGoal`, `ApiPrePlanPayload` (shape-identical to the server types).
- Produces: `fetchPrePlan(): Promise<ApiPrePlanPayload>`.
- Produces: `savePrePlan(body: { goals?: string[]; story?: { id: string; call?: ApiPrePlanCall; goalIndex?: number | null } }): Promise<ApiPrePlanPayload>`.

- [ ] **Step 1: Read the cockpit fetch helper to match style**

Run: `sed -n '640,646p' src/lib/api.ts`
Expected: shows `fetchCockpit` — the `fetch` + `cache: 'no-store'` + error-shape pattern. Match it.

- [ ] **Step 2: Add types + helpers**

In `src/lib/api.ts`, after the `fetchCockpit` function, add:

```ts
/* ----------------------------- Pre-plan page ----------------------------- */

export type ApiPrePlanCall = 'on-track' | 'at-risk' | 'carries-over';

export interface ApiPrePlanCard {
  id: string;
  displayName: string;
  remainingHours: number;
  blocked: boolean;
  lastActivityAt: string | null;
  call: ApiPrePlanCall;
  callIsSuggested: boolean;
  goalIndex: number | null;
}

export interface ApiPrePlanRoomLine {
  openStoriesRemainingHours: number;
  roomHours: number;
  hasCapacity: boolean;
}

export interface ApiPrePlanCoverageGoal {
  index: number;
  text: string;
  storyCount: number;
}

export interface ApiPrePlanPayload {
  sprintName: string;
  goals: string[];
  cards: ApiPrePlanCard[];
  coverage: ApiPrePlanCoverageGoal[];
  room: ApiPrePlanRoomLine;
}

export async function fetchPrePlan(): Promise<ApiPrePlanPayload> {
  const r = await fetch('/api/preplan', { cache: 'no-store' });
  const body = await r.json();
  if (!r.ok || 'error' in body) throw new Error(body.error ?? 'Could not load the pre-plan page');
  return body as ApiPrePlanPayload;
}

export async function savePrePlan(body: {
  goals?: string[];
  story?: { id: string; call?: ApiPrePlanCall; goalIndex?: number | null };
}): Promise<ApiPrePlanPayload> {
  const r = await fetch('/api/preplan', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const resBody = await r.json();
  if (!r.ok || 'error' in resBody) throw new Error(resBody.error ?? 'Could not save the pre-plan changes');
  return resBody as ApiPrePlanPayload;
}
```

- [ ] **Step 3: Typecheck**

Run: `npx tsc -b`
Expected: exit 0.

- [ ] **Step 4: Commit**

```bash
git add src/lib/api.ts
git commit -m "feat(preplan): client types + fetch/save helpers"
```

---

### Task 6: `PrePlanView` component + routing + styles

The page itself: goals strip, story cards (facts + call picker + goal dropdown), coverage line + room line. Routed when `mode === 'preplan'`.

**Files:**
- Create: `src/components/PrePlanView.tsx`
- Modify: `src/components/Dashboard.tsx` (import + route `mode === 'preplan'`)
- Modify: `src/styles/dashboard.css` (append a `preplan-*` block)

**Interfaces:**
- Consumes: `fetchPrePlan`, `savePrePlan`, `ApiPrePlanPayload`, `ApiPrePlanCall`, `ApiPrePlanCard` from `../lib/api`.
- Consumes: `onOpenItem?: (id: string) => void` prop (same as `PlanView`).
- Produced UI behavior: optimistic save on call change + goal-link change; goals textarea saves on blur.

- [ ] **Step 1: Create the component**

Create `src/components/PrePlanView.tsx`:

```tsx
import { useCallback, useEffect, useState } from 'react';
import {
  fetchPrePlan,
  savePrePlan,
  type ApiPrePlanCall,
  type ApiPrePlanCard,
  type ApiPrePlanPayload,
} from '../lib/api';

interface PrePlanViewProps {
  onOpenItem?: (id: string) => void;
}

const CALL_OPTIONS: { value: ApiPrePlanCall; label: string }[] = [
  { value: 'on-track', label: 'On track' },
  { value: 'at-risk', label: 'At risk' },
  { value: 'carries-over', label: 'Carries over' },
];

function relAgo(iso: string | null): string {
  if (!iso) return 'no activity logged';
  const then = new Date(iso).getTime();
  const days = Math.floor((Date.now() - then) / (1000 * 60 * 60 * 24));
  if (days <= 0) return 'active today';
  if (days === 1) return 'active yesterday';
  return `last active ${days} days ago`;
}

export function PrePlanView({ onOpenItem }: PrePlanViewProps) {
  const [data, setData] = useState<ApiPrePlanPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [goalsDraft, setGoalsDraft] = useState('');

  const load = useCallback(() => {
    fetchPrePlan()
      .then(d => {
        setData(d);
        setGoalsDraft(d.goals.join('\n'));
        setError(null);
      })
      .catch(e => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  useEffect(() => { load(); }, [load]);

  const saveStory = (id: string, patch: { call?: ApiPrePlanCall; goalIndex?: number | null }) => {
    // optimistic
    setData(prev =>
      prev
        ? {
            ...prev,
            cards: prev.cards.map(c =>
              c.id === id
                ? { ...c, ...patch, callIsSuggested: patch.call !== undefined ? false : c.callIsSuggested }
                : c,
            ),
          }
        : prev,
    );
    savePrePlan({ story: { id, ...patch } })
      .then(setData)
      .catch(e => { setError(e instanceof Error ? e.message : String(e)); load(); });
  };

  const saveGoals = () => {
    const goals = goalsDraft.split('\n').map(g => g.trim()).filter(Boolean);
    savePrePlan({ goals })
      .then(d => { setData(d); setGoalsDraft(d.goals.join('\n')); })
      .catch(e => { setError(e instanceof Error ? e.message : String(e)); load(); });
  };

  if (error) {
    return <div className="preplan-state preplan-error">Couldn’t load the pre-plan page. {error}</div>;
  }
  if (!data) {
    return <div className="preplan-state">Loading your stories…</div>;
  }

  return (
    <div className="preplan">
      <header className="preplan-head">
        <h1>Pre-plan</h1>
        <p className="preplan-sub">Get ready for the pre-plan meeting. Set where each story stands.</p>
      </header>

      <section className="preplan-goals">
        <label htmlFor="preplan-goals-box">Sprint goals (paste from the email — one per line)</label>
        <textarea
          id="preplan-goals-box"
          className="preplan-goals-box"
          value={goalsDraft}
          onChange={e => setGoalsDraft(e.target.value)}
          onBlur={saveGoals}
          rows={Math.max(3, goalsDraft.split('\n').length)}
          placeholder="e.g. Improve rollout confidence"
        />
      </section>

      {data.cards.length === 0 ? (
        <div className="preplan-state">No stories in flight to review — nothing to prep.</div>
      ) : (
        <section className="preplan-cards">
          {data.cards.map(card => (
            <PrePlanCardRow
              key={card.id}
              card={card}
              goals={data.goals}
              onOpenItem={onOpenItem}
              onCall={call => saveStory(card.id, { call })}
              onGoal={goalIndex => saveStory(card.id, { goalIndex })}
            />
          ))}
        </section>
      )}

      {data.goals.length > 0 && (
        <section className="preplan-coverage">
          <h2>Goal coverage</h2>
          <ul>
            {data.coverage.map(g => (
              <li key={g.index} className={g.storyCount === 0 ? 'preplan-gap' : ''}>
                Goal {g.index + 1} — {g.text}: {g.storyCount === 0 ? 'nobody’s carrying this' : `${g.storyCount} ${g.storyCount === 1 ? 'story' : 'stories'} on it`}
              </li>
            ))}
          </ul>
        </section>
      )}

      {data.room.hasCapacity && (
        <p className="preplan-room">
          Your open stories need about {data.room.openStoriesRemainingHours}h; you’ve got about {data.room.roomHours}h of room left
          {data.room.openStoriesRemainingHours > data.room.roomHours
            ? ` — roughly ${data.room.openStoriesRemainingHours - data.room.roomHours}h won’t fit.`
            : '.'}
        </p>
      )}
    </div>
  );
}

function PrePlanCardRow(props: {
  card: ApiPrePlanCard;
  goals: string[];
  onOpenItem?: (id: string) => void;
  onCall: (call: ApiPrePlanCall) => void;
  onGoal: (goalIndex: number | null) => void;
}) {
  const { card, goals, onOpenItem, onCall, onGoal } = props;
  // displayName is **title** (#id) — render the title plain; strip the markdown stars.
  const title = card.displayName.replace(/\*\*/g, '').replace(/\s*\(#\d+\)\s*$/, '');
  return (
    <article className={`preplan-card${card.blocked ? ' is-blocked' : ''}`}>
      <div className="preplan-card-main">
        <button type="button" className="preplan-card-title" onClick={() => onOpenItem?.(card.id)}>
          {title} <span className="preplan-id">#{card.id}</span>
        </button>
        <div className="preplan-facts">
          <span>{card.remainingHours}h left</span>
          {card.blocked && <span className="preplan-blocked">blocked</span>}
          <span>{relAgo(card.lastActivityAt)}</span>
        </div>
      </div>
      <div className="preplan-card-actions">
        <div className="preplan-call" role="group" aria-label="Where does this story stand?">
          {CALL_OPTIONS.map(opt => (
            <button
              key={opt.value}
              type="button"
              className={`preplan-call-btn${card.call === opt.value ? ' is-on' : ''}${card.call === opt.value && card.callIsSuggested ? ' is-suggested' : ''}`}
              onClick={() => onCall(opt.value)}
            >
              {opt.label}
            </button>
          ))}
        </div>
        {goals.length > 0 && (
          <select
            className="preplan-goal-select"
            value={card.goalIndex ?? ''}
            onChange={e => onGoal(e.target.value === '' ? null : Number(e.target.value))}
          >
            <option value="">no goal</option>
            {goals.map((g, i) => (
              <option key={i} value={i}>Goal {i + 1}: {g.length > 40 ? g.slice(0, 39) + '…' : g}</option>
            ))}
          </select>
        )}
      </div>
    </article>
  );
}
```

- [ ] **Step 2: Route it in Dashboard.tsx**

In `src/components/Dashboard.tsx`, add the import near the `PlanView` import (~line 35):

```tsx
import { PrePlanView } from './PrePlanView';
```

Then change the routing block (currently ~line 281-284):

```tsx
          {mode === 'plan' ? (
            <PlanView onOpenItem={openItem} />
          ) : mode !== 'day' ? (
            <ModePlaceholder mode={mode} />
```

to:

```tsx
          {mode === 'plan' ? (
            <PlanView onOpenItem={openItem} />
          ) : mode === 'preplan' ? (
            <PrePlanView onOpenItem={openItem} />
          ) : mode !== 'day' ? (
            <ModePlaceholder mode={mode} />
```

- [ ] **Step 3: Append styles**

In `src/styles/dashboard.css`, append at the end (reusing existing palette tokens; match the calm dark theme + the no-small-and-gray rule from [[feedback-no-small-and-gray]]):

```css
/* ============================ Pre-plan page ============================ */
.preplan { max-width: 880px; margin: 0 auto; padding: 24px clamp(16px, 4vw, 40px); display: flex; flex-direction: column; gap: 24px; }
.preplan-head h1 { margin: 0 0 4px; font-size: 22px; }
.preplan-sub { margin: 0; color: var(--ink-3); font-size: 14px; }
.preplan-state { padding: 40px 0; color: var(--ink-3); text-align: center; font-size: 15px; }
.preplan-error { color: var(--st-blocked, #d98); }
.preplan-goals { display: flex; flex-direction: column; gap: 8px; }
.preplan-goals label { font-size: 13px; color: var(--ink-3); }
.preplan-goals-box { width: 100%; resize: vertical; background: var(--surface-2, #1c1c22); color: var(--ink-1); border: 1px solid var(--line, #333); border-radius: 8px; padding: 10px 12px; font: inherit; line-height: 1.5; }
.preplan-cards { display: flex; flex-direction: column; gap: 12px; }
.preplan-card { display: flex; justify-content: space-between; align-items: center; gap: 16px; flex-wrap: wrap; background: var(--surface-2, #1c1c22); border: 1px solid var(--line, #333); border-left: 3px solid var(--st-going, #5b8def); border-radius: 10px; padding: 14px 16px; }
.preplan-card.is-blocked { border-left-color: var(--st-blocked, #d98); }
.preplan-card-main { display: flex; flex-direction: column; gap: 6px; min-width: 240px; }
.preplan-card-title { background: none; border: none; padding: 0; color: var(--ink-1); font-size: 15px; font-weight: 600; text-align: left; cursor: pointer; }
.preplan-card-title:hover { text-decoration: underline; }
.preplan-id { color: var(--ink-3); font-weight: 400; font-size: 13px; }
.preplan-facts { display: flex; gap: 12px; flex-wrap: wrap; font-size: 13px; color: var(--ink-3); }
.preplan-blocked { color: var(--st-blocked, #d98); font-weight: 600; }
.preplan-card-actions { display: flex; flex-direction: column; gap: 8px; align-items: flex-end; }
.preplan-call { display: inline-flex; border: 1px solid var(--line, #333); border-radius: 8px; overflow: hidden; }
.preplan-call-btn { background: var(--surface-1, #16161a); color: var(--ink-2); border: none; padding: 7px 12px; font-size: 13px; cursor: pointer; }
.preplan-call-btn + .preplan-call-btn { border-left: 1px solid var(--line, #333); }
.preplan-call-btn.is-on { background: var(--accent, #5b8def); color: #fff; }
.preplan-call-btn.is-suggested.is-on { background: color-mix(in oklch, var(--accent, #5b8def) 55%, transparent); }
.preplan-goal-select { background: var(--surface-1, #16161a); color: var(--ink-2); border: 1px solid var(--line, #333); border-radius: 8px; padding: 6px 8px; font-size: 13px; max-width: 240px; }
.preplan-coverage h2 { font-size: 15px; margin: 0 0 8px; }
.preplan-coverage ul { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 4px; }
.preplan-coverage li { font-size: 14px; color: var(--ink-2); }
.preplan-coverage li.preplan-gap { color: var(--st-blocked, #d98); font-weight: 600; }
.preplan-room { font-size: 14px; color: var(--ink-2); background: var(--surface-2, #1c1c22); border-radius: 8px; padding: 12px 14px; margin: 0; }
```

> If a referenced CSS var doesn't exist, the fallback after the comma renders — so the page is never unstyled. Prefer matching an existing token if you spot the real name while editing (grep `--ink-1`, `--accent`, `--st-going` in the file).

- [ ] **Step 4: Typecheck + build**

Run: `npx tsc -b && npm test`
Expected: `tsc -b` exit 0; full suite green.

- [ ] **Step 5: Commit**

```bash
git add src/components/PrePlanView.tsx src/components/Dashboard.tsx src/styles/dashboard.css
git commit -m "feat(preplan): PrePlanView page + routing + styles"
```

---

## Manual Smoke (flag for Moran — requires dashboard restart)

Backend + API changes need `npm run dev` restarted (Vite doesn't HMR backend code), then a browser refresh. After restart:

1. **Cards appear** — open the Pre-plan tab → your started, not-done stories show, each with hours left / blocked / last activity. Done and never-started stories don't appear.
2. **Suggestions** — a blocked or long-idle story is pre-set to "At risk"; a freshly-worked one to "On track". The suggested button looks lighter than a confirmed one.
3. **Calls persist** — set a call on each story → reload → choices stick, and the confirmed ones no longer look "suggested".
4. **Goals + links** — paste 3 goals (one per line), click out → goal dropdowns appear on cards with a suggested goal pre-picked; change one → reload → it sticks.
5. **Coverage + room** — a goal nobody linked shows "nobody's carrying this" in the warm color; the room line reads honestly against Daily's available-hours number.
6. **No ADO writes** — confirm nothing changed on the board (states, tags) after all of the above.

## Self-Review Notes

- **Spec coverage:** goals strip → Task 6; story selection (started+not-done) → Task 3 `selectCarriedStories`; facts on cards → Task 3 `buildCards`; three-way call + suggestion → Tasks 1+3+6; goal link suggest-then-confirm → Tasks 1+6; coverage line → Tasks 1+6; sprint-wide room line → Task 3 + Task 6; local-only storage → Task 2; API → Tasks 4+5; routing → Task 6. Out-of-scope items (ADO writes, capture-during, auto-match, per-story room, auto carries-over, MCP tool, goals carry-forward) are in Global Constraints / not built.
- **Type consistency:** `PrePlanCall` / `PrePlanCard` / `PrePlanPayload` (server) mirror `ApiPrePlanCall` / `ApiPrePlanCard` / `ApiPrePlanPayload` (client) field-for-field. `callIsSuggested = saved.call === undefined` is consistent between the Task-3 implementation and its Task-1/Task-3 tests. `goalIndex` merge uses `!== undefined` (so an explicit `null` "no goal" is preserved) in both the builder and the POST handler.
- **Placeholder scan:** no TBD/TODO; every code step has complete code; the corrupt-JSON test is the one spot that says "implementer completes" — that's a 2-line finish with the exact instruction given, not a vague gap.
- **Reuse vs duplicate:** `suggestGoalIndex` uses a small local tokenizer rather than refactoring `guardrail.ts`'s private `tokenize` (not exported; extracting it would churn a stable, tested module for no real DRY win on ~6 lines — YAGNI). Flagged deliberately.
