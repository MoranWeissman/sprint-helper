# R1 — Silent Time + Close-the-Loop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the visible start/pause/sync/done stopwatch with silent time tracking driven by the Claude Code session, and add a session-end "is this done?" step that closes the task in Azure DevOps only after Moran confirms.

**Architecture:** A Claude Code session already exists (`sessions` table) and a silent timer already exists (`time_entries` table). R1 couples them: opening a session starts the silent timer; ending a session pauses it, or — when Moran confirms the task is done — pushes the tracked time to Azure DevOps and closes the task. The frontend stops rendering any live/ticking counters or manual timer buttons and instead shows the accumulated total statically. The standalone manual-timer surface (HTTP endpoints, MCP `timer_*` tools, frontend buttons) is removed because the session now owns timing.

**Tech Stack:** Vite + React 18 + TypeScript, better-sqlite3 (`~/.sprint-helper/data.db`), `@modelcontextprotocol/sdk` (stdio MCP server run via `tsx`), Azure DevOps via the `az` CLI.

**Verification approach (read this — it deviates from the skill's default TDD):** This project has **no automated test framework** (see `package.json` — only `dev`, `mcp`, `build`, `typecheck`). It is a solo tool owned by a non-developer; prior slices were verified by `npm run typecheck` + manual smoke testing. We follow that established pattern rather than introducing a test runner Moran won't maintain. Each task is verified by: (1) `npm run typecheck` (must report no errors), (2) where it adds real signal, a **self-cleaning `tsx` snippet** that exercises backend logic against a clearly-fake work-item id and deletes its own rows, and (3) a precise manual smoke check. The MCP server and Vite dev server must be **restarted** to pick up server-side changes (Vite does not HMR backend code; the MCP client must reconnect to reload tools/instructions).

---

## File Structure

| File | Responsibility | Change |
|------|----------------|--------|
| `mcp/server.ts` | MCP tool surface + server instructions | Couple session↔timer in `session_start`/`session_end`; add `done` flag to `session_end`; rewrite `SERVER_INSTRUCTIONS`; remove the four `timer_*` tools |
| `server/sessions.ts` | Session storage + reads | Add `getSessionCountMap()` |
| `server/dashboard.ts` | Build the `/api/dashboard` payload | Add `sessionCount` to `DashboardWorkItem` + `projectWorkItem` |
| `src/lib/api.ts` | Frontend types + fetch/mutation helpers | Add `sessionCount` to `ApiWorkItem`; remove the timer mutation helpers |
| `src/components/Dashboard.tsx` | Day dashboard, story card, task rows | Remove live-tick math + manual timer buttons; show static logged total + sittings count |
| `src/components/LiveNowTile.tsx` | Sidebar "live now" tile | Stop per-second ticking |
| `vite.config.ts` | Dev API middleware | Remove the `/api/timer/` endpoint block |

`server/timer-service.ts` and `server/timers.ts` are **unchanged** — they remain the silent-timer engine, now called only from the session handlers.

---

### Task 1: Session owns the silent timer + `session_end` gains a `done` flag

**Files:**
- Modify: `mcp/server.ts:374-376` (`session_start` handler) and `mcp/server.ts:398-414` (`session_end` tool)

- [ ] **Step 1: Make `session_start` also start the silent timer**

In `mcp/server.ts`, the `session_start` handler currently is:

```ts
  async ({ workItemId, client }) =>
    jsonResult(startSession({ workItemId, client })),
```

Replace it with:

```ts
  async ({ workItemId, client }) => {
    const session = startSession({ workItemId, client });
    timerService.start(workItemId); // silent time tracking begins with the session
    return jsonResult(session);
  },
```

(`timerService` is already imported at `mcp/server.ts:29`. `timerService.start` is idempotent, so reconnect-driven repeat calls are safe.)

- [ ] **Step 2: Add the `done` flag to the `session_end` tool definition + handler**

Replace the entire `session_end` registration (currently `mcp/server.ts:398-414`):

```ts
server.registerTool(
  'session_end',
  {
    title: 'End a Claude Code session',
    description:
      'Close a session, optionally with a final summary of what got done. Surfaces in her dashboard and feeds future Demo prep recall.',
    inputSchema: {
      sessionId: z.string(),
      summary: z.string().optional(),
    },
  },
  async ({ sessionId, summary }) => {
    const result = endSession({ sessionId, summary });
    if (!result) return errorResult(`Session not found: ${sessionId}`);
    return jsonResult(result);
  },
);
```

with:

```ts
server.registerTool(
  'session_end',
  {
    title: 'End a Claude Code session',
    description:
      'Close a session with a one-line summary of what got done. Set done=true ONLY after Moran has confirmed the task is finished — that pushes the tracked time to Azure DevOps and closes the task. Omit done (or pass false) when she is just stopping for now: the silent timer pauses and NOTHING is written to Azure DevOps, so she can pick it back up later.',
    inputSchema: {
      sessionId: z.string(),
      summary: z.string().optional(),
      done: z
        .boolean()
        .optional()
        .describe('True only when Moran has explicitly confirmed the task is complete. Pushes tracked time + closes the task in Azure DevOps.'),
    },
  },
  async ({ sessionId, summary, done }) => {
    const session = endSession({ sessionId, summary });
    if (!session) return errorResult(`Session not found: ${sessionId}`);
    try {
      const timer = done
        ? await timerService.markDone(session.workItemId)
        : timerService.pause(session.workItemId);
      return jsonResult({ session, timer });
    } catch (e) {
      return errorResult(e instanceof Error ? e.message : String(e));
    }
  },
);
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: completes with no errors.

- [ ] **Step 4: Verify the silent-timer engine coupling (self-cleaning script)**

This proves the engine behavior the handler relies on: starting tracks time, pausing stops it. It uses a fake work-item id and deletes its own rows. (It does NOT call `markDone`, which would hit Azure DevOps — that path is covered by the manual smoke in Step 5.)

Run:
```bash
npx tsx -e "
import { startSession, endSession } from './server/sessions';
import * as timer from './server/timer-service';
import { getDb, closeDb } from './server/db';
const WI = 999000111;
const s = startSession({ workItemId: WI });
const started = timer.start(WI);
console.log('after start running =', started.snapshot.running ? 'RUNNING (ok)' : 'NOT RUNNING (BAD)');
endSession({ sessionId: s.id });
const paused = timer.pause(WI);
console.log('after end running  =', paused.snapshot.running ? 'STILL RUNNING (BAD)' : 'PAUSED (ok)');
const db = getDb();
db.prepare('DELETE FROM session_events WHERE work_item_id = ?').run(WI);
db.prepare('DELETE FROM sessions WHERE work_item_id = ?').run(WI);
db.prepare('DELETE FROM time_entries WHERE work_item_id = ?').run(WI);
closeDb();
console.log('cleaned up');
"
```
Expected output:
```
after start running = RUNNING (ok)
after end running  = PAUSED (ok)
cleaned up
```

- [ ] **Step 5: Manual MCP smoke (handler path)**

Restart the MCP client (start a fresh Claude Code session so it reconnects). In that session, ask Claude Code to call `session_start` for a real in-sprint task id, then `session_end` with `done: false` — confirm it returns `{ session, timer }` with `timer.action === 'paused'`. Do NOT exercise `done: true` here unless you want a real ADO write on a real task. If you do test `done: true`, use a throwaway task you're willing to close.

- [ ] **Step 6: Commit**

```bash
git add mcp/server.ts
git commit -m "R1: session owns the silent timer; session_end gains a confirm-gated done flag"
```

---

### Task 2: Add `sessionCount` to the dashboard payload

**Files:**
- Modify: `server/sessions.ts` (add a reader near the other read helpers, after `getActiveSessionMap`)
- Modify: `server/dashboard.ts` (`DashboardWorkItem` interface, `buildDashboard`, `projectWorkItem`)
- Modify: `src/lib/api.ts` (`ApiWorkItem` interface)

- [ ] **Step 1: Add `getSessionCountMap` to `server/sessions.ts`**

Append this function at the end of the Reads section in `server/sessions.ts` (after `getActiveSessionMap`, before end of file):

```ts
/**
 * {workItemId → number of sessions (open or closed)} for the given items.
 * Used by the dashboard to show a calm "N sittings" total. Items with no
 * sessions are omitted from the map.
 */
export function getSessionCountMap(workItemIds: number[]): Map<number, number> {
  const m = new Map<number, number>();
  if (workItemIds.length === 0) return m;
  const placeholders = workItemIds.map(() => '?').join(',');
  const rows = getDb()
    .prepare<number[], { work_item_id: number; n: number }>(
      `SELECT work_item_id, COUNT(*) AS n FROM sessions
       WHERE work_item_id IN (${placeholders})
       GROUP BY work_item_id`,
    )
    .all(...workItemIds);
  for (const r of rows) m.set(r.work_item_id, r.n);
  return m;
}
```

- [ ] **Step 2: Add the field + wiring in `server/dashboard.ts`**

(a) Import the new reader. Change the sessions import block (`server/dashboard.ts:23-28`) from:

```ts
import {
  getActiveSessionMap,
  getRecentEventsMap,
  type Session,
  type SessionEvent,
} from './sessions';
```

to:

```ts
import {
  getActiveSessionMap,
  getRecentEventsMap,
  getSessionCountMap,
  type Session,
  type SessionEvent,
} from './sessions';
```

(b) Add the field to the `DashboardWorkItem` interface. Immediately after the `recentActivity: SessionEvent[];` line (`server/dashboard.ts:72`), add:

```ts
  /** Number of work sessions (open or closed) recorded against this item. */
  sessionCount: number;
```

(c) In `buildDashboard`, populate the count map. After the line `const recentEvents = getRecentEventsMap(itemIds, 5);` (`server/dashboard.ts:210`), add:

```ts
  const sessionCounts = getSessionCountMap(itemIds);
```

(d) Pass it into `projectWorkItem`. Change the call (`server/dashboard.ts:217`) from:

```ts
    const projected = projectWorkItem(w, uncaptured, running, activeSessions, recentEvents);
```

to:

```ts
    const projected = projectWorkItem(w, uncaptured, running, activeSessions, recentEvents, sessionCounts);
```

(e) Extend the `projectWorkItem` signature. Change (`server/dashboard.ts:396-402`) from:

```ts
function projectWorkItem(
  w: WorkItem,
  uncaptured: Map<number, number>,
  running: Map<number, string>,
  activeSessions: Map<number, Session>,
  recentEvents: Map<number, SessionEvent[]>,
): DashboardWorkItem {
```

to:

```ts
function projectWorkItem(
  w: WorkItem,
  uncaptured: Map<number, number>,
  running: Map<number, string>,
  activeSessions: Map<number, Session>,
  recentEvents: Map<number, SessionEvent[]>,
  sessionCounts: Map<number, number>,
): DashboardWorkItem {
```

(f) Set the value in the returned object. In `projectWorkItem`'s return, immediately after the `recentActivity: recentEvents.get(w.id) ?? [],` line (`server/dashboard.ts:431`), add:

```ts
    sessionCount: sessionCounts.get(w.id) ?? 0,
```

- [ ] **Step 3: Add `sessionCount` to `ApiWorkItem` in `src/lib/api.ts`**

In `src/lib/api.ts`, the `ApiWorkItem` interface has a `recentActivity` field near `localUncapturedSeconds` (line ~42) and `runningSince` (line ~44). Add, alongside those fields:

```ts
  sessionCount: number;
```

(Place it next to `localUncapturedSeconds` so the type mirrors `DashboardWorkItem`.)

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck`
Expected: completes with no errors.

- [ ] **Step 5: Verify the count reader (self-cleaning script)**

Run:
```bash
npx tsx -e "
import { getSessionCountMap, startSession, endSession } from './server/sessions';
import { getDb, closeDb } from './server/db';
const WI = 999000222;
const a = startSession({ workItemId: WI }); endSession({ sessionId: a.id });
// second sitting (must end the first so startSession is not idempotent)
const b = startSession({ workItemId: WI });
const n = getSessionCountMap([WI]).get(WI);
console.log('session count =', n, n === 2 ? '(ok)' : '(BAD, expected 2)');
const db = getDb();
db.prepare('DELETE FROM session_events WHERE work_item_id = ?').run(WI);
db.prepare('DELETE FROM sessions WHERE work_item_id = ?').run(WI);
db.prepare('DELETE FROM time_entries WHERE work_item_id = ?').run(WI);
closeDb();
console.log('cleaned up');
"
```
Expected output:
```
session count = 2 (ok)
cleaned up
```

- [ ] **Step 6: Commit**

```bash
git add server/sessions.ts server/dashboard.ts src/lib/api.ts
git commit -m "R1: surface per-task session count in the dashboard payload"
```

---

### Task 3: Rewrite MCP instructions for session-owned time + remove the `timer_*` tools

**Files:**
- Modify: `mcp/server.ts` (`SERVER_INSTRUCTIONS` at lines ~38-73; remove the four timer tool registrations at lines ~199-253)

- [ ] **Step 1: Remove the four `timer_*` tool registrations**

Delete the entire block from the `Timer tools` banner comment through the end of the `timer_done` registration (`mcp/server.ts:195-253`) — i.e. remove the registrations for `timer_start`, `timer_pause`, `timer_sync`, and `timer_done` and their section banner:

```ts
/* ============================================================ */
/*  Timer tools                                                  */
/* ============================================================ */

server.registerTool(
  'timer_start',
  ...
);

server.registerTool(
  'timer_pause',
  ...
);

server.registerTool(
  'timer_sync',
  ...
);

server.registerTool(
  'timer_done',
  ...
);
```

Leave the `timerService` import in place — it is still used by the session handlers (Task 1).

- [ ] **Step 2: Rewrite the work-in-progress and wrap-up sections of `SERVER_INSTRUCTIONS`**

In `SERVER_INSTRUCTIONS` (`mcp/server.ts:38-73`), replace the `AS WORK PROCEEDS:` and `WHEN WORK WRAPS UP:` sections. Find:

```
AS WORK PROCEEDS:
  - Log meaningful moments with \`session_log\`: focus (switching attention),
    progress (what got done), blocker (something in the way), decision (a
    tradeoff chosen), note (anything else worth remembering).
  - Use \`timer_start\` / \`timer_pause\` to track time, \`timer_sync\` to push
    it to Azure DevOps, \`timer_done\` when a task is finished.

WHEN WORK WRAPS UP:
  - Call \`session_end\` with a one-line summary of what got done. This feeds
    her demo prep and retro later.
```

Replace with:

```
AS WORK PROCEEDS:
  - The open session tracks time automatically. You do NOT start, pause, or
    sync any timer by hand — just keep the session open while she works.
  - Log meaningful moments with \`session_log\`: focus (switching attention),
    progress (what got done), blocker (something in the way), decision (a
    tradeoff chosen), note (anything else worth remembering).

WHEN WORK WRAPS UP — always ask first:
  Ask Moran plainly: "Is this task done, or are you just stopping for now?"
  - Just stopping: call \`session_end\` with a one-line summary. The tracked
    time pauses and NOTHING is written to Azure DevOps — she can pick it back
    up later.
  - Done: confirm with her, THEN call \`session_end\` with done=true and a
    summary. This is the only time you write to Azure DevOps automatically, and
    only after she has said yes — it pushes the tracked time and closes the
    task. Never set done=true without her explicit confirmation.
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: completes with no errors (confirms the removed tools aren't referenced elsewhere).

- [ ] **Step 4: Confirm no dangling references to the removed tools**

Run: `grep -rn "timer_start\|timer_pause\|timer_sync\|timer_done" mcp server`
Expected: no matches.

- [ ] **Step 5: Manual MCP smoke**

Start a fresh Claude Code session (so the new instructions + tool list load). Mention starting work on an in-sprint task; confirm Claude Code opens a session (no manual timer call), and that when you say you're stopping it asks "done or stopping for now?" and only proposes an Azure DevOps write when you say it's done.

- [ ] **Step 6: Commit**

```bash
git add mcp/server.ts
git commit -m "R1: MCP instructions teach session-owned time + confirm-gated close; drop manual timer tools"
```

---

### Task 4: Remove live ticking + manual timer buttons from the Day UI; show a static total

**Files:**
- Modify: `src/components/Dashboard.tsx` (imports; `ActiveStoryCard` ~533-618; `TaskRow` ~620-731)

- [ ] **Step 1: Drop the now-unused imports**

(a) Remove the four timer helpers from the `../lib/api` import (`src/components/Dashboard.tsx:2-14`). Change:

```ts
import {
  nameFromEmail,
  timerDone,
  timerPause,
  timerStart,
  timerSync,
  updateWorkItem,
  useDashboardData,
  type ApiPayload,
  type ApiUserStoryGroup,
  type ApiWorkItem,
  type StateBucket,
} from '../lib/api';
```

to:

```ts
import {
  nameFromEmail,
  updateWorkItem,
  useDashboardData,
  type ApiPayload,
  type ApiUserStoryGroup,
  type ApiWorkItem,
  type StateBucket,
} from '../lib/api';
```

(b) Remove `useTick` from the `../lib/time` import (`src/components/Dashboard.tsx:16-26`). Delete the `useTick,` line from that import block (leave the other names). `useMemo` stays (used in many other places).

- [ ] **Step 2: Make `ActiveStoryCard` static (no tick, no drift)**

In `ActiveStoryCard`, replace the body from the `useTick();` line through the two `storyLive*` declarations (`src/components/Dashboard.tsx:544-554`):

```ts
  // Live tick — re-render once per second so running timers' counters advance.
  useTick();
  const fetchedAtMs = useMemo(() => new Date(fetchedAt).getTime(), [fetchedAt]);
  // Seconds elapsed since the server's snapshot — added to each running task's logged total.
  const driftSec = Math.max(0, Math.floor((Date.now() - fetchedAtMs) / 1000));

  const storyLiveHours = story.completedHours + (story.tasks.filter(t => t.runningSince).length * driftSec) / 3600;
  const storyLiveRemaining = Math.max(
    0,
    story.remainingHours - (story.tasks.filter(t => t.runningSince).length * driftSec) / 3600,
  );
```

with:

```ts
  // Time is tracked silently by the open session; show the server's totals as-is, no live counter.
  const storyLoggedHours = story.completedHours;
  const storyRemaining = story.remainingHours;
```

- [ ] **Step 3: Update the story number blocks + remove the `fetchedAt` prop**

(a) In the `ember-active-story-numbers` block (`src/components/Dashboard.tsx:581-587`), change `storyLiveHours` → `storyLoggedHours` and `storyLiveRemaining` → `storyRemaining`:

```tsx
      <div className="ember-active-story-numbers">
        <NumberBlock label="logged" value={storyLoggedHours} accent />
        <Divider />
        <NumberBlock label="estimate" value={story.totalEstimateHours} dim />
        <Divider />
        <NumberBlock label="remaining" value={storyRemaining} dim />
      </div>
```

(b) Remove the `fetchedAt` prop from `ActiveStoryCard`. In the props destructure + type (`src/components/Dashboard.tsx:533-543`), delete the `fetchedAt,` line and the `fetchedAt: string;` line. The signature becomes:

```ts
function ActiveStoryCard({
  story,
  onOpenItem,
  onAfterChange,
}: {
  story: ApiUserStoryGroup;
  onOpenItem: (id: string) => void;
  onAfterChange: () => void;
}) {
```

(c) Remove the `driftSec` prop passed to each `TaskRow` (`src/components/Dashboard.tsx:600-608`):

```tsx
        {story.tasks.map(task => (
          <TaskRow
            key={task.id}
            task={task}
            onOpen={() => onOpenItem(task.id)}
            onAfterChange={onAfterChange}
          />
        ))}
```

(d) Remove the `fetchedAt={data.fetchedAt}` line from the `<ActiveStoryCard>` render site (`src/components/Dashboard.tsx:363-368`):

```tsx
            <ActiveStoryCard
              story={activeStory}
              onOpenItem={openItem}
              onAfterChange={onRefresh}
            />
```

- [ ] **Step 4: Strip the timer state, action, and buttons from `TaskRow`**

(a) Update the `TaskRow` props (`src/components/Dashboard.tsx:620-630`) to drop `driftSec`:

```ts
function TaskRow({
  task,
  onOpen,
  onAfterChange,
}: {
  task: ApiWorkItem;
  onOpen: () => void;
  onAfterChange: () => void;
}) {
```

(b) Replace the state + derived-values block (`src/components/Dashboard.tsx:631-665`). Find:

```ts
  const [expanded, setExpanded] = useState(false);
  const [timerPending, setTimerPending] = useState<null | 'start' | 'pause' | 'sync' | 'done'>(null);
  const [timerError, setTimerError] = useState<string | null>(null);

  const stateEdit = useEditable<StateBucket>(bucketForState(task.state));
  const estimateEdit = useEditable<number>(task.originalEstimate ?? 0);
  const remainingEdit = useEditable<number>(task.remainingWork ?? 0);

  const isDone = stateEdit.display === 'done';
  const running = !!task.runningSince;
  const hasUnsynced = task.localUncapturedSeconds > 0 || running;

  const baseLoggedSec = Math.round((task.completedWork ?? 0) * 3600) + task.localUncapturedSeconds;
  const liveLoggedSec = baseLoggedSec + (running ? driftSec : 0);
  const loggedDisplay = fmtHM(liveLoggedSec, 0);

  async function doTimerAction(kind: 'start' | 'pause' | 'sync' | 'done') {
    setTimerPending(kind);
    setTimerError(null);
    try {
      switch (kind) {
        case 'start': await timerStart(task.id); break;
        case 'pause': await timerPause(task.id); break;
        case 'sync':  await timerSync(task.id); break;
        case 'done':  await timerDone(task.id); break;
      }
      onAfterChange();
    } catch (e) {
      setTimerError(e instanceof Error ? e.message : String(e));
    } finally {
      setTimerPending(null);
    }
  }

  const errorMsg = timerError ?? stateEdit.error ?? estimateEdit.error ?? remainingEdit.error;
```

Replace with:

```ts
  const [expanded, setExpanded] = useState(false);

  const stateEdit = useEditable<StateBucket>(bucketForState(task.state));
  const estimateEdit = useEditable<number>(task.originalEstimate ?? 0);
  const remainingEdit = useEditable<number>(task.remainingWork ?? 0);

  // Time is tracked silently by the open session — show the accumulated total, no live counter.
  const loggedSec = Math.round((task.completedWork ?? 0) * 3600) + task.localUncapturedSeconds;
  const loggedDisplay = fmtHM(loggedSec, 0);

  const errorMsg = stateEdit.error ?? estimateEdit.error ?? remainingEdit.error;
```

(`onAfterChange` is still passed to inline editors elsewhere in the row; it is also passed by the parent and used by `useEditable` callbacks below the expand panel — leave the prop in place.)

- [ ] **Step 5: Remove the `is-running` class and the running accent on the logged readout**

(a) The task row class (`src/components/Dashboard.tsx:676`) — remove the `${running ? 'is-running' : ''}` segment:

```tsx
        className={`ember-active-story-task task-row state-${stateEdit.display} ${expanded ? 'is-open' : ''}`}
```

(b) The logged `<Mono>` in the meta cell (`src/components/Dashboard.tsx:691-695`) — drop the `running` accent and add a static "sittings" count:

```tsx
        <span className="ember-task-meta task-effort">
          <Mono>{loggedDisplay}</Mono>
          &nbsp;<span className="of">/</span>&nbsp;
          <Mono style={{ color: 'var(--ink-2)' }}>{estimateFor(task)}</Mono>
          {task.sessionCount > 0 && (
            <span className="task-sittings dim-small">&nbsp;· {task.sessionCount} sitting{task.sessionCount === 1 ? '' : 's'}</span>
          )}
        </span>
```

- [ ] **Step 6: Replace the controls cell (remove all four buttons; keep the live marker)**

Replace the `ember-task-controls` span (`src/components/Dashboard.tsx:697-723`). Find:

```tsx
        <span className="ember-task-controls task-quickacts">
          {!isDone && !running && (
            <button className="ember-task-btn task-quick" onClick={stop(() => doTimerAction('start'))} disabled={timerPending !== null} title="Start timer">
              <span className="task-quick-glyph">▶</span> start
            </button>
          )}
          {!isDone && running && (
            <button className="ember-task-btn pause task-quick" onClick={stop(() => doTimerAction('pause'))} disabled={timerPending !== null} title="Pause timer">
              <span className="task-quick-glyph">⏸</span> pause
            </button>
          )}
          {!isDone && hasUnsynced && !running && (
            <button className="ember-task-btn sync task-quick" onClick={stop(() => doTimerAction('sync'))} disabled={timerPending !== null} title="Push logged time to Azure DevOps">
              <span className="task-quick-glyph">↑</span> sync
            </button>
          )}
          {!isDone && (
            <button className="ember-task-btn done task-quick" onClick={stop(() => doTimerAction('done'))} disabled={timerPending !== null} title="Mark done in Azure DevOps">
              <span className="task-quick-glyph">✓</span> done
            </button>
          )}
          {task.activeSession && (
            <span className="task-live-slot">
              <LiveMarker />
            </span>
          )}
        </span>
```

Replace with:

```tsx
        <span className="ember-task-controls task-quickacts">
          {task.activeSession && (
            <span className="task-live-slot">
              <LiveMarker />
            </span>
          )}
        </span>
```

- [ ] **Step 7: Typecheck**

Run: `npm run typecheck`
Expected: no errors. (This confirms `useTick`, `driftSec`, `isDone`, `running`, `hasUnsynced`, `timerStart/Pause/Sync/Done`, `timerPending`, `timerError` are fully removed with no stragglers, and that `stop` is still used by other handlers in the row.)

- [ ] **Step 8: Manual UI smoke**

Restart the dev server (`npm run dev`) and open the Day view. Confirm: (1) no start/pause/sync/done buttons on task rows; (2) the logged number does not tick; (3) tasks with recorded sittings show "· N sittings"; (4) a task with a live Claude Code session still shows the live marker.

- [ ] **Step 9: Commit**

```bash
git add src/components/Dashboard.tsx
git commit -m "R1: remove manual timer buttons + live ticking from the Day view; show static logged total + sittings"
```

---

### Task 5: Stop the per-second tick in `LiveNowTile`

**Files:**
- Modify: `src/components/LiveNowTile.tsx:1-2,25-26`

- [ ] **Step 1: Remove the `useTick` import and call**

(a) Change the imports (`src/components/LiveNowTile.tsx:1-2`) from:

```ts
import { useTick } from '../lib/time';
import { Mono } from './Mono';
```

to:

```ts
import { Mono } from './Mono';
```

(b) Remove the tick call (`src/components/LiveNowTile.tsx:25-26`):

```ts
  // Re-render every second so elapsed times tick.
  useTick();
```

Delete both lines. `elapsedShort` stays — it now computes a calm, coarse "N min" / "Hh Mm" once per render (the tile re-renders when the dashboard data refreshes), with no per-second ticking.

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 3: Manual UI smoke**

With a live session open, confirm the "LIVE NOW" tile shows a coarse elapsed (e.g. "12 min") that does not visibly tick second-by-second.

- [ ] **Step 4: Commit**

```bash
git add src/components/LiveNowTile.tsx
git commit -m "R1: stop the per-second tick in the live-now tile"
```

---

### Task 6: Remove the dead manual-timer HTTP surface

**Files:**
- Modify: `vite.config.ts:54-101` (the `/api/timer/` middleware)
- Modify: `src/lib/api.ts:297-326` (the timer mutation helpers)

- [ ] **Step 1: Remove the `/api/timer/` middleware block**

In `vite.config.ts`, delete the entire `server.middlewares.use('/api/timer/', ...)` block (`vite.config.ts:54-101`) — from the `server.middlewares.use('/api/timer/', async (req, res) => {` line through its closing `});`. Leave the `/api/dashboard`, `/api/workitem/`, and `/api/schedule` middleware blocks intact.

- [ ] **Step 2: Remove the timer helpers from `src/lib/api.ts`**

Delete the entire `Timer mutations` section (`src/lib/api.ts:297-326`) — the section banner comment, the `TimerActionResponse` interface, the `timerCall` function, and the four exports `timerStart`, `timerPause`, `timerSync`, `timerDone`:

```ts
/* -------------------------------------------------------------------------- */
/*  Timer mutations                                                           */
/* -------------------------------------------------------------------------- */

export interface TimerActionResponse { ... }

async function timerCall(path: string, workItemId: string): Promise<TimerActionResponse> { ... }

export const timerStart = (id: string) => timerCall('start', id);
export const timerPause = (id: string) => timerCall('pause', id);
export const timerSync = (id: string) => timerCall('sync', id);
export const timerDone = (id: string) => timerCall('done', id);
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 4: Confirm nothing references the removed surface**

Run: `grep -rn "timerStart\|timerPause\|timerSync\|timerDone\|TimerActionResponse\|/api/timer" src vite.config.ts`
Expected: no matches.

- [ ] **Step 5: Manual UI smoke**

Restart `npm run dev`, open the Day view, open the browser console. Confirm the dashboard loads with no network calls to `/api/timer/*` and no console errors.

- [ ] **Step 6: Commit**

```bash
git add vite.config.ts src/lib/api.ts
git commit -m "R1: remove the dead manual-timer HTTP endpoints + client helpers"
```

---

## Self-Review

**1. Spec coverage** (against `docs/superpowers/specs/2026-05-28-sprint-helper-complete-design.md`, "Time, tracked silently" + the session loop's "End → close the loop"):

- "No stopwatches, nothing ticking" → Task 4 (remove buttons + live-tick math), Task 5 (de-tick live-now tile). ✓
- "Knows how long each task's sessions ran… until the task is done" → Task 1 (session_start starts the silent timer; session_end pauses it; done pushes effort). ✓
- "Shows a calm total… '~3h across 2 sittings'" → Task 4 renders static logged hours + Task 2/Task 4 render the sittings count. ✓
- "End → is this done? → propose closing (you confirm) → close in ADO; No → remembers where you stopped" → Task 1 (`done` flag → `markDone`; not-done → `pause`, time accrues) + Task 3 (instructions tell Claude Code to ask first and only set `done=true` after confirmation). ✓
- "Confirm before every ADO write" → enforced at the conversational layer by Task 3's instructions; the only auto-write path (`session_end done=true`) is gated on Moran's yes. ✓

No spec requirement for R1 is left without a task.

**2. Placeholder scan:** No TBD/TODO/"handle edge cases"/"similar to Task N". Every code step shows the exact before/after. ✓

**3. Type consistency:**
- `getSessionCountMap(workItemIds: number[]): Map<number, number>` — defined in Task 2 Step 1, imported and called identically in Task 2 Step 2. ✓
- `sessionCount: number` — added to `DashboardWorkItem` (Task 2 Step 2b), populated in `projectWorkItem` (Task 2 Step 2f), mirrored on `ApiWorkItem` (Task 2 Step 3), read as `task.sessionCount` in the UI (Task 4 Step 5b). ✓
- `session_end` handler returns `{ session, timer }`; `session` comes from `endSession` (type `Session`, has `workItemId`), `timer` from `timerService.pause` / `markDone` (type `TimerActionResult`). Both already imported. ✓
- `timerService.start` / `.pause` / `.markDone` signatures match existing `server/timer-service.ts` (`start`/`pause` sync, `markDone` async). ✓

Plan is internally consistent. Ready to execute.
