# Focus panels + parallel-session cap — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cap how many tasks run at once (default 4, enforced with a plain refusal), and let Focus split into 1–4 self-chosen panels, each showing a working / waiting / stale (🌙) mark.

**Architecture:** Two independent halves. (A) A server cap: a config knob + a pure predicate + a refusal in the `session_start` MCP handler. (B) A stale signal added to the dashboard payload's `activeSession` (reusing the idle logic that already lives in orient), consumed by a new multi-panel Focus in `Dashboard.tsx`. The cap limits the DB; the panels read whatever's live — they never talk to each other.

**Tech Stack:** TypeScript, better-sqlite3, @modelcontextprotocol/sdk, Vite/React, Vitest 4 (in-memory SQLite harness via `vi.hoisted` + `vi.mock('./db')`).

**Spec:** `docs/superpowers/specs/2026-07-13-focus-panels-and-session-cap-design.md`

## Global Constraints

- **Cap value** resolves env `SH_MAX_PARALLEL_SESSIONS` → setting `max_parallel_sessions` → default `4`. A non-positive or non-numeric value falls back to 4 (never 0).
- **The cap only bites a genuinely NEW item.** Re-touching an item that already has an open session is never blocked (`startSession` is idempotent — returns the existing session).
- **Cap applies ONLY to the `session_start` handler.** `workitem_block` / `workitem_unblock` (which also call `startSession`) are never capped — a block can come from any window and must always succeed.
- **Refusal message** follows plain-English + names-before-numbers: name each running task as `**title** (#id)`, never a bare id, no banned words.
- **Stale threshold** is the existing `STALE_IDLE_MINUTES` (120) from orient — do NOT introduce a second number. Extract and share it.
- **State precedence** in a session's mark: `waiting` beats `stale` beats `working`. A paused-for-you chat is never shown as merely stale.
- **New payload fields are OPTIONAL on the client** (`idleMinutes?`, `state?`) — an older payload renders exactly as today (version-skew guard).
- **Focus default = ONE panel.** The grid is opt-in and Moran-picks each panel; nothing auto-fills or auto-swaps.
- **Accessibility / functional colour:** the stale mark is a moon glyph **plus a text label**, never colour or icon alone; never font-size ≤ 11px paired with the faintest ink token.
- Commit after each green step. `npm test` + `npx tsc -b` must be green before each commit.

---

### Task 1: Session-cap config knob + pure predicate

**Files:**
- Create: `server/session-cap.ts`
- Test: `server/session-cap.test.ts`

**Interfaces:**
- Consumes: `getSetting` from `./timers` (verified — that's where `server/config.ts`'s `pick()` imports it from), `Session` type from `./sessions`.
- Produces (Task 3 imports these exact names): `maxParallelSessions(): number`, `parallelCapExceeded(opts: { activeSessions: Session[]; workItemId: number; max: number }): boolean`.

- [ ] **Step 1: Write the failing test**

Create `server/session-cap.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest';

// maxParallelSessions reads a setting + env; mock the settings store and control env.
const h = vi.hoisted(() => ({ settings: new Map<string, string>() }));
vi.mock('./timers', () => ({
  getSetting: (k: string) => h.settings.get(k) ?? null,
}));

import { maxParallelSessions, parallelCapExceeded } from './session-cap';
import type { Session } from './sessions';

function sess(workItemId: number): Session {
  return {
    id: `s-${workItemId}`, workItemId, startedAt: '2026-07-13T08:00:00.000Z',
    endedAt: null, client: 'claude-code', summary: null,
    cwd: null, waitingNote: null, waitingSince: null,
  };
}

beforeEach(() => {
  h.settings.clear();
  delete process.env.SH_MAX_PARALLEL_SESSIONS;
});

describe('maxParallelSessions', () => {
  it('defaults to 4 with no env and no setting', () => {
    expect(maxParallelSessions()).toBe(4);
  });
  it('setting wins over default; env wins over setting', () => {
    h.settings.set('max_parallel_sessions', '3');
    expect(maxParallelSessions()).toBe(3);
    process.env.SH_MAX_PARALLEL_SESSIONS = '2';
    expect(maxParallelSessions()).toBe(2);
  });
  it('junk / zero / negative falls back to 4', () => {
    process.env.SH_MAX_PARALLEL_SESSIONS = 'abc';
    expect(maxParallelSessions()).toBe(4);
    process.env.SH_MAX_PARALLEL_SESSIONS = '0';
    expect(maxParallelSessions()).toBe(4);
    process.env.SH_MAX_PARALLEL_SESSIONS = '-1';
    expect(maxParallelSessions()).toBe(4);
  });
});

describe('parallelCapExceeded', () => {
  it('false when under the cap', () => {
    const active = [sess(1), sess(2)];
    expect(parallelCapExceeded({ activeSessions: active, workItemId: 9, max: 4 })).toBe(false);
  });
  it('true when at the cap and the item is NEW', () => {
    const active = [sess(1), sess(2), sess(3), sess(4)];
    expect(parallelCapExceeded({ activeSessions: active, workItemId: 9, max: 4 })).toBe(true);
  });
  it('false when at the cap but the item ALREADY has an open session', () => {
    const active = [sess(1), sess(2), sess(3), sess(4)];
    expect(parallelCapExceeded({ activeSessions: active, workItemId: 3, max: 4 })).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run server/session-cap.test.ts`
Expected: FAIL — cannot resolve `./session-cap`.

- [ ] **Step 3: Write the implementation**

Create `server/session-cap.ts`:

```ts
/**
 * How many work sessions may run in parallel, and whether a new one would
 * exceed that. Pure + config-only — no DB access here; the caller passes the
 * live session list in. The cap exists to stop parallel sessions piling up
 * unnoticed (the ADHD "where am I even working?" problem).
 */
import { getSetting } from './timers'; // same source server/config.ts's pick() uses
import type { Session } from './sessions';

/** env SH_MAX_PARALLEL_SESSIONS → setting max_parallel_sessions → default 4. */
export const DEFAULT_MAX_PARALLEL_SESSIONS = 4;

export function maxParallelSessions(): number {
  const raw = process.env.SH_MAX_PARALLEL_SESSIONS ?? getSetting('max_parallel_sessions') ?? '';
  const n = Number.parseInt(String(raw).trim(), 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_MAX_PARALLEL_SESSIONS;
}

/**
 * True only when STARTING a session on `workItemId` would push the number of
 * distinct running items past `max`. Re-touching an item that already has an
 * open session is never over the cap (startSession is idempotent).
 */
export function parallelCapExceeded(opts: {
  activeSessions: Session[];
  workItemId: number;
  max: number;
}): boolean {
  const alreadyOpen = opts.activeSessions.some(s => s.workItemId === opts.workItemId);
  if (alreadyOpen) return false;
  const distinctItems = new Set(opts.activeSessions.map(s => s.workItemId));
  return distinctItems.size >= opts.max;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run server/session-cap.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Full suite + typecheck + commit**

Run: `npm test` then `npx tsc -b` — both green.

```bash
git add server/session-cap.ts server/session-cap.test.ts
git commit -m "feat(focus): parallel-session cap config knob + predicate"
```

---

### Task 2: Shared session-activity-state helper (extract from orient)

**Files:**
- Create: `server/session-activity.ts`
- Modify: `server/orient.ts`
- Test: `server/session-activity.test.ts`

**Interfaces:**
- Produces (Task 4 imports these): `STALE_IDLE_MINUTES: number`, `type SessionActivityState = 'working' | 'waiting' | 'stale'`, `sessionActivityState(opts: { idleMinutes: number; waiting: boolean }): SessionActivityState`.
- `server/orient.ts` keeps identical behaviour — it now imports `STALE_IDLE_MINUTES` from the new module instead of declaring its own const.

- [ ] **Step 1: Write the failing test**

Create `server/session-activity.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { sessionActivityState, STALE_IDLE_MINUTES } from './session-activity';

describe('sessionActivityState', () => {
  it('waiting beats everything, even when idle past the threshold', () => {
    expect(sessionActivityState({ idleMinutes: STALE_IDLE_MINUTES + 10, waiting: true })).toBe('waiting');
    expect(sessionActivityState({ idleMinutes: 0, waiting: true })).toBe('waiting');
  });
  it('stale when idle at or past the threshold and not waiting', () => {
    expect(sessionActivityState({ idleMinutes: STALE_IDLE_MINUTES, waiting: false })).toBe('stale');
    expect(sessionActivityState({ idleMinutes: STALE_IDLE_MINUTES + 1, waiting: false })).toBe('stale');
  });
  it('working when recently active and not waiting', () => {
    expect(sessionActivityState({ idleMinutes: STALE_IDLE_MINUTES - 1, waiting: false })).toBe('working');
    expect(sessionActivityState({ idleMinutes: 0, waiting: false })).toBe('working');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run server/session-activity.test.ts`
Expected: FAIL — cannot resolve `./session-activity`.

- [ ] **Step 3: Write the implementation**

Create `server/session-activity.ts`:

```ts
/**
 * One place that decides how a live work session reads at a glance:
 *   - waiting: the chat paused to ask Moran something (waitingSince set).
 *   - stale:   no activity for STALE_IDLE_MINUTES+ (the chat went quiet).
 *   - working: recently active.
 * Shared by orient (the morning greeting) and the dashboard (Focus panels)
 * so both agree on one threshold instead of inventing two.
 */
export const STALE_IDLE_MINUTES = 120;

export type SessionActivityState = 'working' | 'waiting' | 'stale';

export function sessionActivityState(opts: { idleMinutes: number; waiting: boolean }): SessionActivityState {
  if (opts.waiting) return 'waiting';
  if (opts.idleMinutes >= STALE_IDLE_MINUTES) return 'stale';
  return 'working';
}
```

- [ ] **Step 4: Point orient at the shared const**

In `server/orient.ts`:
- Remove the local declaration `const STALE_IDLE_MINUTES = 120;` (line ~30).
- Add to the imports: `import { STALE_IDLE_MINUTES } from './session-activity';`
- Leave every use of `STALE_IDLE_MINUTES` and the `mayBeStale` calc unchanged — behaviour is identical.

- [ ] **Step 5: Run tests to verify nothing regressed**

Run: `npx vitest run server/session-activity.test.ts server/orient.test.ts`
Expected: PASS — new file's 3 tests + orient's existing tests unchanged.

- [ ] **Step 6: Full suite + typecheck + commit**

Run: `npm test` then `npx tsc -b` — both green.

```bash
git add server/session-activity.ts server/session-activity.test.ts server/orient.ts
git commit -m "feat(focus): shared session-activity-state helper (extract from orient)"
```

---

### Task 3: Enforce the cap in `session_start`

**Files:**
- Modify: `mcp/server.ts`

**Interfaces:**
- Consumes from Task 1: `maxParallelSessions`, `parallelCapExceeded`. `listActiveSessions` is already imported in `mcp/server.ts`.
- Produces: nothing consumed by later tasks (handler behaviour + instructions only).

- [ ] **Step 1: Add the imports**

In `mcp/server.ts`, add to the existing `./server/session-cap`-adjacent imports (near where `startSession`, `listActiveSessions` are imported from `../server/sessions`):

```ts
import { maxParallelSessions, parallelCapExceeded } from '../server/session-cap';
```

(Match the relative path other `../server/...` imports in this file use.)

- [ ] **Step 2: Insert the cap check in the `session_start` handler**

In the `session_start` handler, immediately BEFORE the line `const session = startSession({ workItemId, client });` (around `mcp/server.ts:2051`), insert:

```ts
    // Cap parallel work. Refuse a genuinely NEW session past the limit and
    // name what's already running so Moran picks one to pause/finish. Re-opening
    // an item that already has a session is never blocked (handled in the predicate).
    const runningSessions = listActiveSessions();
    const max = maxParallelSessions();
    if (parallelCapExceeded({ activeSessions: runningSessions, workItemId, max })) {
      const names = runningSessions
        .map(s => {
          const title = titleForWorkItem(s.workItemId); // see Step 3
          return title ? `  • **${title}** (#${s.workItemId})` : `  • #${s.workItemId}`;
        })
        .join('\n');
      return errorResult(
        `You already have ${max} tasks running — that's your limit. Pause or finish one before starting another. Running now:\n${names}`,
      );
    }
```

- [ ] **Step 3: Resolve task titles for the refusal**

The refusal must name each running task. Find how this handler (or a neighbour) already resolves a work-item title — search `mcp/server.ts` for an existing helper that maps an id → title (e.g. something using `getWorkItem`/`workitem_get` internals or a `taskMeta`-style lookup). Two acceptable options, pick the one that matches existing patterns:

- (a) If a synchronous title lookup already exists, wrap it as `titleForWorkItem(id)`.
- (b) Otherwise, resolve titles with the same call the handler already makes for the requested item, mapped over `runningSessions` (await a small batch). If that means the block must move above an `async` boundary, keep it — correctness over tidiness.

If neither is clean, the honest fallback is bare `#id` lines (the predicate + limit message still work); leave a `// TODO: names when a cheap title lookup exists` and flag it in the task report so the reviewer/Moran can decide. Do NOT invent a new ADO fetch path just for this.

- [ ] **Step 4: Add the SERVER_INSTRUCTIONS block**

Find the `PARALLEL CHATS` block in `SERVER_INSTRUCTIONS` (search `PARALLEL CHATS`). Directly after it, add:

```text
SESSION LIMIT — Moran caps how many tasks run at once (default 4):
  - If `session_start` is refused because the limit is reached, DO NOT
    work around it. Read the running tasks it listed back to Moran by
    name and ask which one to pause or finish first, then retry.
  - The limit is a real guard against losing track of parallel work,
    not a suggestion. Never open a session outside `session_start` to
    dodge it.
```

Match the surrounding escaping (it's a template literal; keep backticks escaped as the neighbours do).

- [ ] **Step 5: Verify + commit**

Run: `npx tsc -b` (proves the handler + template literal compile) then `npm test` (all green — no existing test drives this handler).

```bash
git add mcp/server.ts
git commit -m "feat(focus): enforce parallel-session cap in session_start"
```

---

### Task 4: Stale/working/waiting state in the dashboard payload

**Files:**
- Modify: `server/dashboard.ts`
- Modify: `src/lib/api.ts`

**Interfaces:**
- Consumes from Task 2: `sessionActivityState`, `SessionActivityState` from `./session-activity`; existing `getLastEventTimestampMap` from `./sessions`.
- Produces: `ApiActiveSession` gains `idleMinutes?: number` and `state?: SessionActivityState` (mirrored as a string union). Task 6 (client) reads `activeSession.state`.

- [ ] **Step 1: Compute a last-activity map in `buildDashboard`**

In `server/dashboard.ts`, near the existing session lookups (around line 400 where `recentEvents`/`activeSessions` are built), add a map from open sessionId → last activity ISO. Reuse the existing import surface:

```ts
  const activeSessionList = [...activeSessions.values()];
  const lastEventBySession = getLastEventTimestampMap(activeSessionList.map(s => s.id));
```

Add `getLastEventTimestampMap` to the existing `from './sessions'` import if not already present, and `sessionActivityState` + the type from `./session-activity`. Pass `lastEventBySession` and a `now` (`new Date()`) into `projectWorkItem` (extend its signature).

- [ ] **Step 2: Extend the `activeSession` projection**

In `projectWorkItem` (line ~838), replace the `activeSession` block with:

```ts
    activeSession: session
      ? (() => {
          const waiting = session.waitingSince != null;
          const lastActivity = lastEventBySession.get(session.id) ?? session.startedAt;
          const idleMinutes = Math.max(0, Math.round((now.getTime() - Date.parse(lastActivity)) / 60000));
          return {
            id: session.id,
            startedAt: session.startedAt,
            waiting,
            idleMinutes,
            state: sessionActivityState({ idleMinutes, waiting }),
          };
        })()
      : undefined,
```

Update `projectWorkItem`'s parameter list and its type in `DashboardWorkItem` (the `activeSession?: { … }` shape at `server/dashboard.ts:90`) to include `idleMinutes: number` and `state: SessionActivityState`.

- [ ] **Step 3: Mirror into the API type**

In `src/lib/api.ts`, extend `ApiActiveSession` (line 24):

```ts
export interface ApiActiveSession {
  id: string;
  startedAt: string;
  /** True when this session's chat is stopped, waiting on Moran's answer. */
  waiting?: boolean;
  /** Minutes since the session's last logged activity. */
  idleMinutes?: number;
  /** At-a-glance mark for a Focus panel. Absent on older payloads. */
  state?: 'working' | 'waiting' | 'stale';
}
```

- [ ] **Step 4: Verify + commit**

Run: `npm test` (existing dashboard tests must stay green — the projection is additive), then `npx tsc -b`.

If a dashboard test snapshots `activeSession`, update it to include the new fields. Add no new server test here (buildDashboard is integration-level; the pure logic is already tested in Task 2).

```bash
git add server/dashboard.ts src/lib/api.ts
git commit -m "feat(focus): carry session working/waiting/stale state in the payload"
```

---

### Task 5: Focus panel picks — sticky list + migration (client state)

**Files:**
- Modify: `src/components/Dashboard.tsx`
- Test: `src/components/focusPicks.test.ts`
- Create: `src/lib/focusPicks.ts`

**Interfaces:**
- Produces: `src/lib/focusPicks.ts` exporting pure helpers `readFocusPicks(raw: string | null, legacy: string | null): string[]`, `writeFocusPicks(ids: string[]): void`, `reconcilePicks(picks: string[], liveIds: string[]): string[]`, `MAX_FOCUS_PANELS = 4`. Task 6 renders from the reconciled list.

- [ ] **Step 1: Write the failing test**

Create `src/components/focusPicks.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { readFocusPicks, reconcilePicks, MAX_FOCUS_PANELS } from '../lib/focusPicks';

describe('readFocusPicks', () => {
  it('parses a JSON id list', () => {
    expect(readFocusPicks('["10","20"]', null)).toEqual(['10', '20']);
  });
  it('migrates a legacy single pick when no list exists', () => {
    expect(readFocusPicks(null, '42')).toEqual(['42']);
  });
  it('empty / unreadable → empty list (caller falls back to auto-pick)', () => {
    expect(readFocusPicks(null, null)).toEqual([]);
    expect(readFocusPicks('not json', null)).toEqual([]);
  });
  it('never returns more than MAX_FOCUS_PANELS', () => {
    expect(readFocusPicks('["1","2","3","4","5","6"]', null)).toHaveLength(MAX_FOCUS_PANELS);
  });
});

describe('reconcilePicks', () => {
  it('drops picks whose session is no longer live, keeping order', () => {
    expect(reconcilePicks(['10', '20', '30'], ['30', '10'])).toEqual(['10', '30']);
  });
  it('returns empty when nothing picked is still live', () => {
    expect(reconcilePicks(['10'], ['99'])).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/components/focusPicks.test.ts`
Expected: FAIL — cannot resolve `../lib/focusPicks`.

- [ ] **Step 3: Write the helper**

Create `src/lib/focusPicks.ts`:

```ts
/** Focus can show 1–4 self-chosen panels. This owns the sticky pick list. */
export const MAX_FOCUS_PANELS = 4;

const KEY = 'sh.focus.picks';
const LEGACY_KEY = 'sh.focus.pick';

/** Parse the stored list; migrate a single legacy pick; clamp to the max. */
export function readFocusPicks(raw: string | null, legacy: string | null): string[] {
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return parsed.filter((x): x is string => typeof x === 'string').slice(0, MAX_FOCUS_PANELS);
      }
    } catch {
      /* fall through to empty */
    }
    return [];
  }
  if (legacy) return [legacy];
  return [];
}

export function loadFocusPicks(): string[] {
  try {
    return readFocusPicks(localStorage.getItem(KEY), localStorage.getItem(LEGACY_KEY));
  } catch {
    return [];
  }
}

export function writeFocusPicks(ids: string[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(ids.slice(0, MAX_FOCUS_PANELS)));
    localStorage.removeItem(LEGACY_KEY);
  } catch {
    /* private-mode storage — in-memory state still drives this render */
  }
}

/** Keep only still-live picks, preserving the user's chosen order. */
export function reconcilePicks(picks: string[], liveIds: string[]): string[] {
  const live = new Set(liveIds);
  return picks.filter(id => live.has(id));
}
```

- [ ] **Step 4: Wire the state in `Dashboard.tsx`**

Replace the single `focalId` state (`Dashboard.tsx:161-190`) with a picks list:

- Seed: `const [picks, setPicksState] = useState<string[]>(() => loadFocusPicks());`
- Setter that persists: `const setPicks = (ids: string[]) => { setPicksState(ids); writeFocusPicks(ids); };`
- Reconcile against live tasks (replaces the old reset effect):
  ```ts
  useEffect(() => {
    const liveIds = liveItems.map(w => w.id);
    const next = reconcilePicks(picks, liveIds);
    if (next.length !== picks.length) setPicks(next);
  }, [liveItems]); // eslint-disable-line react-hooks/exhaustive-deps
  ```
- Derive what the panels show: the reconciled picks, or — when empty — an auto-pick of the first live task (preserves today's "opens on one" behaviour):
  ```ts
  const panelIds = picks.length > 0 ? picks : liveItems.slice(0, 1).map(w => w.id);
  const panelTasks = panelIds.map(id => liveItems.find(w => w.id === id)).filter(Boolean) as ApiWorkItem[];
  const offPanel = liveItems.filter(w => !panelIds.includes(w.id)); // the "also running" strip
  ```

Import from `../lib/focusPicks`. Keep `import { MAX_FOCUS_PANELS }` for Task 6.

- [ ] **Step 5: Run tests + typecheck + commit**

Run: `npx vitest run src/components/focusPicks.test.ts` (6 pass), then `npm test`, then `npx tsc -b`.

(The app won't render the multi-panel UI yet — Task 6 does that. `panelTasks`/`offPanel` may be flagged unused by tsc; if so, temporarily `void panelTasks;` or land Task 6 in the same session before the type build. Prefer landing Task 6 next.)

```bash
git add src/lib/focusPicks.ts src/components/focusPicks.test.ts src/components/Dashboard.tsx
git commit -m "feat(focus): sticky 1-4 panel pick list with legacy migration"
```

---

### Task 6: Focus panel grid — layout, state marks, picker, also-running

**Files:**
- Modify: `src/components/Dashboard.tsx`
- Modify: `src/styles/dashboard.css`

**Interfaces:**
- Consumes: `panelTasks`, `offPanel`, `picks`, `setPicks`, `MAX_FOCUS_PANELS` from Task 5; `activeSession.state` from Task 4.
- Produces: the rendered multi-panel Focus. No exports consumed elsewhere.

- [ ] **Step 1: Render panels instead of the single focal card**

There is no reusable `storyFor` today — only a `focalStory` useMemo (`Dashboard.tsx:198`) hardcoded to the single focal task's parent (`stories.find(s => String(s.id) === pid)`). Generalize it into a plain function first:

```ts
const storyFor = (task: ApiWorkItem): ApiUserStoryGroup | null => {
  const pid = task.parent?.id ?? task.id;
  return stories.find(s => String(s.id) === String(pid)) ?? null;
};
```

Replace the old single-purpose `focalStory` memo with this (or keep the memo for the 1-panel case and add `storyFor` alongside — builder's call, but `storyFor` must exist as a per-task function the grid can call). Then, in the Focus branch of `Dashboard.tsx` (where `<R21Focus … />` is rendered, line ~309), pass the panel list:

```tsx
<R21FocusGrid
  tasks={panelTasks}
  offPanel={offPanel}
  storyFor={storyFor}          // see note below — generalize the existing focalStory memo
  picks={picks}
  onSetPicks={setPicks}
  maxPanels={MAX_FOCUS_PANELS}
  onOpenItem={openItem}
  helperNotes={data.helperNotes}
  onRefresh={onRefresh}
  now={now}
/>
```

- [ ] **Step 2: Build `R21FocusGrid`**

Add a new component in `Dashboard.tsx` (or a new `src/components/R21FocusGrid.tsx` if it reads cleaner — follow the Dashboard-split rule: a new component may live in its own file). It wraps 1–4 instances of the EXISTING single-panel focal card:

```tsx
function R21FocusGrid({
  tasks, offPanel, storyFor, picks, onSetPicks, maxPanels,
  onOpenItem, helperNotes, onRefresh, now,
}: {
  tasks: ApiWorkItem[];
  offPanel: ApiWorkItem[];
  storyFor: (task: ApiWorkItem) => ApiUserStoryGroup | null;
  picks: string[];
  onSetPicks: (ids: string[]) => void;
  maxPanels: number;
  onOpenItem: (id: string) => void;
  helperNotes: ApiHelperNotes;
  onRefresh: () => void;
  now: Date;
}) {
  const count = Math.max(1, tasks.length);
  const canAdd = offPanel.length > 0 && count < maxPanels;

  const addPanel = (id: string) => onSetPicks([...new Set([...picks.filter(Boolean), id])].slice(0, maxPanels));
  const removePanel = (id: string) => onSetPicks(picks.filter(p => p !== id));

  return (
    <div className={`r21-focusgrid is-count-${count}`}>
      {/* header: count + which-tasks control */}
      <div className="r21-focusgrid-head">
        <span className="r21-focusgrid-label">Focus</span>
        {tasks.length > 1 && (
          <span className="r21-focusgrid-count">{count} of {tasks.length + offPanel.length} running</span>
        )}
      </div>

      <div className="r21-focusgrid-panels">
        {tasks.map(task => (
          <FocusPanel
            key={task.id}
            task={task}
            story={storyFor(task)}
            state={task.activeSession?.state}
            onOpenItem={onOpenItem}
            onRemove={tasks.length > 1 ? () => removePanel(task.id) : undefined}
            helperNotes={helperNotes}
            onRefresh={onRefresh}
            now={now}
          />
        ))}
      </div>

      {offPanel.length > 0 && (
        <section className="r21-also-live" aria-label="Also running">
          <div className="r21-also-live-head">
            <span className="r21-also-live-label">Also running</span>
            <span className="r21-also-live-count">{offPanel.length}</span>
          </div>
          <div className="r21-also-live-row">
            {offPanel.map(w => (
              <button
                key={w.id}
                type="button"
                className={`r21-also-card${w.activeSession?.state === 'waiting' ? ' is-waiting' : ''}${w.activeSession?.state === 'stale' ? ' is-stale' : ''}`}
                onClick={() => (canAdd ? addPanel(w.id) : onOpenItem(w.id))}
                title={canAdd ? 'Add to Focus' : `Focus is full (${maxPanels}) — open it instead`}
              >
                <StateMark state={w.activeSession?.state} />
                <span className="r21-also-card-title">{w.title}</span>
              </button>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
```

`FocusPanel` = the current `R21Focus` body (story header, "currently running", metrics, drill-in), given a compact class and (a) a `StateMark` in the corner, (b) an optional small ✕ `onRemove` when more than one panel is showing. Refactor `R21Focus`'s existing JSX into `FocusPanel` rather than duplicating it — the single-panel case is just `count === 1`.

- [ ] **Step 3: The state mark**

```tsx
function StateMark({ state }: { state?: 'working' | 'waiting' | 'stale' }) {
  if (state === 'waiting') return <span className="r21-mark is-waiting">waiting for you</span>;
  if (state === 'stale') return <span className="r21-mark is-stale"><span aria-hidden="true">🌙</span> quiet a while</span>;
  return <span className="r21-mark is-working">working</span>;
}
```

Text label always present (never glyph/colour alone). Place one in each panel header and reuse it in the also-running cards (Step 2).

- [ ] **Step 4: CSS**

In `src/styles/dashboard.css`, add a `r21-focusgrid-*` block. Reuse the tokens the existing `r21-focal` / `r21-also-*` rules use (check them; do not invent tokens). Requirements:
- `.r21-focusgrid-panels` is a responsive grid: `is-count-1` → one full-width column; `is-count-2` → two columns; `is-count-3`/`is-count-4` → two columns × two rows. Use `clamp()` for gaps and a breakpoint (`@media (max-width: …)`) that collapses to a single column so panels never shrink below readable — stack vertically instead.
- `.r21-mark` variants: `is-working` (calm/accent), `is-waiting` (accent border like the existing waiting pill), `is-stale` (muted, moon). No pulsing/animation. Min font-size 12px; the muted stale text must not be the faintest ink at a small size.

- [ ] **Step 5: Manual sanity + verify**

Run: `npm test` then `npx tsc -b` — both green.
(The grid itself is visual — covered by the USER smoke below, not a unit test.)

```bash
git add src/components/Dashboard.tsx src/styles/dashboard.css
git commit -m "feat(focus): 1-4 panel Focus grid with working/waiting/stale marks"
```

---

## After all tasks

- Full verification: `npm test` + `npx tsc -b` on the branch.
- Final whole-branch review (superpowers:requesting-code-review), fix wave, then merge per superpowers:finishing-a-development-branch (local merge to main; Moran does not push).
- USER smokes (dashboard restart + browser refresh; MCP reload `/exit`+`claude --resume` for the cap + instructions):
  1. **Cap:** with 4 sessions open, ask a chat to start a 5th → it refuses and names the four running tasks by title; pause one, retry → succeeds. Set `SH_MAX_PARALLEL_SESSIONS=2` and confirm the limit moves.
  2. **Panels:** Focus opens on one task; split to 2, then 3 — pick which tasks fill them; a task left out shows in "Also running" and clicking it adds it (or opens it when full); remove a panel with ✕.
  3. **Marks:** a freshly active task shows "working"; a chat that paused to ask shows "waiting for you"; a task idle > 2h shows 🌙 "quiet a while".
  4. **Calm check (the real test):** on a busy day, does opening Focus feel calmer than before? If a 4-grid still overwhelms, the default-to-one + opt-in design is the lever to revisit.
