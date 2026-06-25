# Top up the current sprint — design

**Date:** 2026-06-25
**Status:** approved (design agreed with Moran in chat; "yes, but make it look easy to work with")

## Problem

Moran wants, from a central place, to see all his open stories that are NOT in the current
sprint, and pull their work into the running sprint to fill his hours — mid-sprint, after the
new sprint has already started. The Plan page's existing "Pull into [next sprint]" section
targets the NEXT sprint (planning ahead) and only shows backlog-shelf stories; it goes dead
when no next sprint is scheduled. It does not cover "top up the sprint I'm in right now."

## Decision

Add ONE new section to the Plan page, **below** the three numbered planning steps and visually
set apart from them (it is not a numbered step — it's an any-time tool, not part of the
plan-the-next-sprint ceremony).

Section title: **"Top up this sprint"**
Sub-line: *"Pull tasks from your other stories into <current sprint> to fill your hours."*

### What it shows

Every open story assigned to Moran that is NOT in the current sprint — from the backlog
shelves AND from other named sprints (past or future). "Basically all," per Moran. Each story
is one row carrying:

- kind badge + state chip + title + `#id` (title click opens the existing `WorkItemDrawer`),
- a **location label** — where the story lives now (`Backlog`, or the sprint name like `26_12`),
- its open tasks (not-done children), each with remaining hours,
- a **pullable-hours total** = sum of the story's open tasks' remaining hours (falls back to
  originalEstimate when remaining is blank).

### What "easy to work with" means here (the real spec)

1. **One primary button per story, and it states its effect.** The button reads
   **`Pull 8h in →`** (the number = that story's pullable hours). One tap moves ALL the story's
   open tasks into the current sprint. No expand-then-click-each-task dance for the common case.
2. **No confirm dialog, one tap.** Same as the Daily carry-forward banner. Moving tasks is
   reversible from this very page, so a confirm only adds friction. (This differs from the
   close-out rows, which use `window.confirm` — those are inside the planning ceremony; this
   section is the lightweight any-time tool.)
3. **The hours impact is visible before acting** — it's on the button itself, so Moran never
   guesses what a pull will do to his load.
4. **Expand to pull a single task** — a chevron reveals the task list; each task has its own
   small `+ pull` so he can take just one if the whole story is too much. Power-use, not the
   default path.
5. **Acting rows show progress** — after a pull the section refreshes; pulled tasks are now in
   the sprint, so the story's pullable hours drop (or the row clears when it has no open tasks
   left). Visible feedback that the tap did something.
6. **Stories with no open tasks are shown greyed, with no button**, and read *"no tasks yet"*.
   Hours live on tasks, so there's nothing to pull until tasks exist — showing the story (so
   "see all my stories" holds) while being honest there's nothing to move.

### What moves, and what stays

Only **tasks** move into the current sprint. The **story stays where it is** — Moran's
carryover convention, already enforced by `setIterationPath` (it moves tasks freely, refuses
to drag a started story). So this section never moves a story; it only ever moves tasks. That
also means there's no "started story can't move" edge to handle — we're not moving stories.

### Deliberate omissions (v1, flagged not forgotten)

- **No second capacity meter in this section.** The Daily "Sprint time" card already shows
  remaining desk time for the current sprint. A second gauge here is scope to add only if the
  single number proves not enough in use.
- **No new MCP/chat tool.** UI-only, as asked. A chat tool can come later.
- **No story↔task auto-anything beyond the explicit pull.**

## Architecture

```
PlanView
  └─ TopUpSection (new, after SanityCheckSection)
        rows ← cockpit.data.topUpStories
        per-story  "Pull Nh in →"  ─┐
        per-task   "+ pull"         ─┴─▶ onTopUp(taskIds)
                                            │
                                            ▼
                              POST /api/carry-forward { taskIds }   (EXISTING endpoint)
                              → resolves current sprint server-side
                              → setIterationPath(taskId, currentPath) per id
                              → invalidateDashboardCache()
                                            │
                                            ▼
                              cockpit refetch → row updates
```

### Server — new cockpit data

`server/planning-cockpit.ts`:
- New types `CockpitTopUpStory` (story fields + `locationLabel: string` + `openTasks` +
  `pullableHours: number`) and `CockpitTopUpTask` (id, title, displayName, state, type,
  remainingWork, originalEstimate).
- `buildCockpitPayload` gains `topUpStories: CockpitTopUpStory[]`, collected by a new
  `collectTopUpStories(currentIteration)`:
  - fetch `listMyOpenStoriesNotInSprint(path)` and `listMyOpenTasksNotInSprint(path)` (both
    already exist, built for carry-forward) — run in parallel with the existing queries,
  - hand both lists to a **pure** `groupTopUp(stories, tasks)` helper (unit-tested) that:
    - groups open tasks under their parent story by `task.parentId === story.id`,
    - drops dead stories (DEAD_STATES) and dead tasks,
    - computes `pullableHours` = Σ open-task (remainingWork ?? originalEstimate ?? 0), rounded,
    - sets `locationLabel` from the iteration path: a sprint-level path → its last segment
      (e.g. `26_12`); backlog/quarter/year → `Backlog`,
    - sorts: stories with pullable hours first (most hours first), then no-task stories last.
- Tasks whose parent story isn't in the story list are ignored in v1 (parent is in-sprint or
  not Moran's) — YAGNI on an orphan bucket.

### Client

- `src/lib/api.ts` — mirror the new types as `ApiCockpitTopUpStory` / `ApiCockpitTopUpTask` on
  the cockpit payload. Reuse the existing `postCarryForward(taskIds)` helper (already there) —
  no new fetch helper needed.
- `src/components/PlanView.tsx` — `TopUpSection` + `TopUpRow` + `TopUpTaskRow`, rendered after
  `SanityCheckSection`. New `onTopUp(taskIds: number[])` handler in the parent calls
  `postCarryForward`, then refetches the cockpit. Reuse `KindBadge`, `StateChip`, `SectionHead`
  (with no `step`), `classifyState`, `kindFromType`, the `plan2-*` row classes.
- `src/styles/dashboard.css` — a few `plan2-topup-*` rules: the big hours-on-button treatment,
  the greyed no-task row, the section divider above it. Reuse existing tokens.

## Files

- `server/planning-cockpit.ts` — types + `collectTopUpStories` + pure `groupTopUp` + payload field.
- `server/topup.test.ts` (new) — unit tests for `groupTopUp` (grouping, hours sum, location
  label, dead-item filtering, no-task story, sort order).
- `src/lib/api.ts` — payload types.
- `src/components/PlanView.tsx` — the section + rows + handler.
- `src/styles/dashboard.css` — `plan2-topup-*`.

## Error handling

- Server: a fetch failure in `collectTopUpStories` returns `[]` (best-effort, mirrors
  `collectBacklogStories`) so the rest of the Plan page still renders.
- Client: pull failure surfaces in the existing `actionError` banner the page already shows;
  the row stays put so Moran can retry.

## Testing

- Unit (Vitest): `groupTopUp` pure-function tests in `server/topup.test.ts`.
- The `/api/carry-forward` route is reused unchanged (already covered by live use).
- Live smoke (Moran, after dashboard restart): open Plan → "Top up this sprint" lists his
  out-of-sprint stories with hour totals → tap `Pull Nh in` on one → those tasks land in the
  current sprint (verify on Daily / the board) and the row updates → expand another story and
  pull a single task → confirm a task-less story shows greyed with no button.
```
