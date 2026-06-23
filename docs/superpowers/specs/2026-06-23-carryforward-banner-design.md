# Carry-forward banner — design

**Date:** 2026-06-23
**Status:** approved (the user, 2026-06-23)

## Problem

When a new sprint starts, the user's unfinished work from the previous sprint
doesn't appear on Daily. Reason (verified, working as designed): nothing moves
automatically. The team convention — open child **tasks** move to the new
sprint, the parent **story stays** — is manual, done per-task on the Plan page.
But the user treats the Plan page as an optional helper, doesn't reliably use
it, and so leftover tasks stay stranded in the old sprint. Daily only shows a
story when at least one of its tasks is in the current sprint, so those stories
silently vanish from Daily.

The user wants carry-forward to feel like the default — without having to learn
or open the Plan page — but reviewed the trade-off and chose a one-tap
suggestion over a silent auto-write (sprint-helper has never changed the board
on its own, and the board is delivery-manager-visible).

## What this builds

A **banner on the Daily page**: when open tasks are stranded in a sprint that is
no longer current, Daily shows a single prompt —

> **N unfinished tasks from {old sprint} — pull them into this sprint**  [button]

One tap moves all of them into the current sprint. The banner persists every day
until nothing is stranded (the user may not open Daily on day one, and may not
act immediately). It disappears once there's nothing to pull.

### Why this shape (decisions already made with the user)
- **Tasks move, story stays** — unchanged June convention. Once tasks land in
  the current sprint, the parent story reappears on Daily automatically (Daily
  groups by parent). So "carry forward" and "I see it on Daily" are one outcome.
- **What moves:** every child task that is **not done** — both `New` (not
  started) and `Active` (and Blocked/etc.) states. Done tasks stay put.
- **Suggestion, not silent write.** The board only changes on the user's tap.
- **No day-one timer.** "Don't fire during planning" falls out for free: on the
  last day of the old sprint that sprint is still current, so nothing is
  "stranded in a previous sprint" yet — no banner. The banner can only appear
  once the new sprint becomes current. No scheduled job exists or is added.
- **Persists until handled**, not day-one-only — can't be missed, and since it
  never writes on its own it can't nag the user into a mistake.

## Architecture

Three pieces: a backend query (find the stranded tasks), an API surface
(expose them + a bulk-move endpoint), and the Daily banner (show + tap).

### 1. Backend — find stranded open tasks

New function in `server/ado.ts`: `listMyOpenTasksNotInSprint(currentSprintPath)`.
Mirrors the existing `listMyOpenStoriesNotInSprint` but for tasks:

```
WHERE [System.AssignedTo] = @Me
  AND [System.WorkItemType] = 'Task'
  AND [System.State] NOT IN ('Done','Closed','Resolved','Completed','Removed','Cut')
  AND [System.IterationPath] <> '<currentSprintPath>'
```

Returns `WorkItem[]` (each carries `id`, `title`, `iterationPath`, `parentId`).

The classification of which iteration paths count as "a real previous sprint"
vs "backlog / year / quarter" reuses the existing logic in
`server/planning-cockpit.ts` (the `BacklogLevel` classifier). We only surface
tasks whose iteration path is a **named sprint other than the current one** —
NOT backlog/year/quarter items (those were never in a sprint, so they're not
"carry-over"; pulling them is a planning act, which stays on the Plan page).

### 2. Backend — summarize for the banner

In `server/dashboard.ts` `buildDashboard`, after the current-sprint items are
loaded, call `listMyOpenTasksNotInSprint(iteration.path)`, classify, and attach
a new payload field:

```ts
carryForward: {
  taskIds: number[];          // open tasks stranded in previous sprint(s)
  count: number;              // taskIds.length
  fromSprintLabel: string;    // e.g. "26_12" — the sprint label most of them sit in
} | null                       // null when nothing is stranded
```

`null` (not an empty object) when `count === 0`, so the client renders nothing.
When tasks span more than one old sprint, `fromSprintLabel` names the most
common one and the copy reads "N unfinished tasks from earlier sprints".

This is one extra WIQL query per dashboard build. It rides the same
stale-while-revalidate cache as the rest of the payload, so it's not run on
every keystroke.

### 3. API — bulk move endpoint

New endpoint in `vite.config.ts` middleware (where the other `/api/*` routes
live): `POST /api/carry-forward`. Body: `{ taskIds: number[] }`. For each id it
calls the EXISTING `setIterationPath(id, currentSprintPath)` (which already
permits task moves and already enforces "started story-level items can't move"
— tasks are unaffected). Resolves the current sprint path server-side; the
client never sends a path. Returns `{ moved: number, failed: number[] }`.
Invalidates the dashboard cache so the next load reflects the moves.

A partial failure (one task rejected by Azure) doesn't abort the rest — it's
collected into `failed[]` and surfaced. The endpoint never throws on a single
bad id.

### 4. UI — the Daily banner

In `src/components/Dashboard.tsx`, above the "Your stories" feature list (it's a
day-one orientation cue, so it sits at the top of Daily, not in the right rail).
Renders only when `data.carryForward != null`. Plain-English copy following the
project's rules (no "carry-over"/"WIP"/jargon):

> **{count} unfinished {task/tasks} from {fromSprintLabel}**
> These didn't get finished last sprint. Pull them in so they're on your board.
> [ Pull them into this sprint ]

On tap: disable the button, `POST /api/carry-forward` with the ids, then refresh
the dashboard (same refresh path the note actions already use). If `failed[]` is
non-empty, show a plain line: "Couldn't move N — open them in Azure DevOps." The
banner re-renders from fresh data (gone if all moved).

## Data flow

```
buildDashboard
  -> listMyOpenTasksNotInSprint(currentPath)   [ado.ts, new]
  -> classify out backlog/year/quarter         [reuse planning-cockpit classifier]
  -> payload.carryForward = {taskIds,count,fromSprintLabel} | null

Daily banner (carryForward != null)
  -> user taps
  -> POST /api/carry-forward {taskIds}
       -> for each id: setIterationPath(id, currentPath)   [writes.ts, existing]
       -> invalidateDashboardCache()
       -> {moved, failed}
  -> client refreshes dashboard -> banner reflects result
```

## Error handling

- Stranded-task query fails → `carryForward: null` (best-effort, like the recap
  enrichment in Fix A); the dashboard still renders. Logged, not thrown.
- Bulk move: per-id failures collected in `failed[]`, never abort the batch.
- The move reuses `setIterationPath`'s guard verbatim — no new write rules. A
  task is always movable; the guard only ever refuses started *stories*, which
  this flow never sends.

## Testing

- `listMyOpenTasksNotInSprint` builds the expected WIQL (Task + not-done +
  not-current-iteration). Unit test with the fake ado client.
- The classifier filter: a task in `…\2026\Q2\26_12` (named sprint) is
  surfaced; a task in `…\2026` (year) or a Backlog-literal path is NOT.
- `buildDashboard` sets `carryForward` to null when nothing's stranded and to
  the right count/label when tasks are stranded (fake the query).
- The `/api/carry-forward` handler and the banner UI are thin glue / view —
  not unit-tested per the project convention; the user smoke-tests after reload.

## Out of scope (YAGNI)

- Silent auto-move (explicitly rejected by the user).
- A scheduled/background job (none exists; the banner is computed on dashboard
  load, which is enough).
- Moving the story itself, or any change to the tasks-move-story-stays split.
- Pulling backlog/year/quarter items — that stays a Plan-page planning act.
- Per-task choosing in the banner — it's all-or-nothing one tap; granular moves
  remain on the Plan page for when the user wants control.
- Touching the Plan page (it keeps working exactly as today, as the override).
```
