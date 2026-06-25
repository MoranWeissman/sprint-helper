# Top-up hours meter, move-rule relaxation, Daily Sprint-time + rail polish — design

**Date:** 2026-06-25
**Status:** approved in chat (4 items, decisions captured below)

Four related changes, all from Moran using the tool:

1. **Top-up hours meter** — "Top up this sprint" needs an hours bar that fills as he pulls.
2. **Move-rule relaxation** — allow moving more stories, block only out of a PAST sprint.
3. **Daily "Sprint time" card** — the hours bar is a mess (two denominators, bar tracks days).
4. **Left-rail sprint days** — gray Fri/Sat, count 10 working days not 14 calendar days.

---

## 1. Top-up hours meter

### Problem
The "Top up this sprint" section pulls task hours into the current sprint, but there's no
gauge — Moran can't see how full the sprint is getting as he pulls.

### Decision
Add a meter at the top of the `TopUpSection`, styled like the existing Plan-header
`plan2-meter`, but measuring the **current** sprint:

- **Cap** = current sprint's available desk hours after meetings (the same `computeCapacity`
  the cockpit already runs for the next sprint, run for the current sprint window).
- **Filled** = current sprint's committed task hours (sum of open-task remaining/estimate
  hours already IN the current sprint) **plus** what Moran pulls this session.
- The bar fills and the verdict ("Nh to spare" / "Nh left" / "Nh over") updates on each pull,
  reusing the existing `pulledHoursThisSession` counter — credited with each task's hours on
  pull. So the meter responds immediately, same mechanism the next-sprint meter uses.

### Server
`server/planning-cockpit.ts`:
- Add `currentSprintCapacity: CockpitCapacity | null` to the payload — compute it with
  `computeCapacity({ sprintStart: currentSprint.start, sprintEnd: currentSprint.finish })`,
  mirroring the existing `nextSprintCapacity` block.
- Add `currentSprintCommittedHours: number` — sum over `openStories` of each open task's
  `remainingWork ?? originalEstimate ?? 0` (the hours already committed to the running
  sprint). This is the meter's starting fill, before any pull this session.

### Client
- `src/lib/api.ts` — mirror `currentSprintCapacity` + `currentSprintCommittedHours` on
  `ApiCockpitPayload`.
- `src/components/PlanView.tsx` — a `TopUpMeter` (small, reuses `plan2-meter` classes). Fill =
  `currentSprintCommittedHours + pulledHoursThisSession`; cap = current available hours. The
  `onTopUp` handler credits `pulledHoursThisSession` by the moved tasks' hours (it doesn't
  today — it only refetches). Compute the credited hours from the task list before the move.

### Note
This reuses `pulledHoursThisSession`, which is ALSO fed by the next-sprint backlog pulls. That
double-use is fine in practice (Moran does one or the other in a session), and resets on
re-mount. Not worth a second counter (YAGNI). Flagged so it's a known, not a surprise.

---

## 2. Move-rule relaxation — block only out of a PAST sprint

### Problem / current behavior
`setIterationPath` refuses to move ANY started (not-never-started) story to another iteration.
That over-blocks: a started story sitting in the backlog, the current sprint, or a future
sprint can't be moved, even though there's no finished-sprint number to protect there.

### Decision (Moran)
Relax the guard. The ONLY case that still refuses a wholesale story move:

- the story is **started** (not in a never-started state), AND
- its **current** iteration is a **past sprint** (a sprint-level path whose finish date is
  before today).

Everything else moves: New (never-started) stories from anywhere (including a past sprint),
and started stories from the backlog / current / future sprints. Tasks always move (unchanged).

Reason: the guard exists to keep a *finished* sprint's planned-vs-completed numbers honest. A
story that started and is leaving a sprint that's already over would silently drop out of that
sprint's record — that's the only genuinely harmful move. Pulling a started story OUT of the
current or a future sprint, or a New story from anywhere, harms no closed record.

### Implementation
`server/writes.ts::setIterationPath`:
- Keep "tasks always move."
- For a story-level item in a started state, decide "is its current iteration a past sprint?":
  - read `System.IterationPath` (already reading fields here),
  - resolve it against `listAllIterations()` — if it matches a sprint-level iteration whose
    `finishDate` < today (start of today), it's a past sprint → REFUSE with the existing
    message. Otherwise allow.
  - If the path can't be matched to a known iteration (backlog / year / quarter), it's not a
    past sprint → allow.
- New helper `isPastSprintPath(iterationPath, now)` — pure-ish (takes the iteration list), so
  it's unit-testable without ADO. Put the date logic in a pure function
  `classifyPastSprint(iterations, iterationPath, now): boolean` and unit-test that.

### Tests
`server/writes.test.ts` (extend the existing iteration-path describe block, which mocks the
board): started story in a PAST sprint → refused; started story in a FUTURE sprint → moves;
started story in the BACKLOG → moves; New story in a past sprint → moves. The existing
"started story stays put" test changes meaning — update it to seed a PAST sprint so it still
asserts refusal for the right reason.

### Knock-on: whole-story pull in Top-up (Moran said yes)
Add a second action in `TopUpRow` — **"Pull story in"** — that moves the story itself into the
current sprint, for stories the relaxed rule allows (New stories, and started stories not in a
past sprint). For a started story still in a past sprint, the whole-story button is hidden /
disabled with a hint ("only its tasks can carry over"), and the per-task / pull-all-tasks
button remains. The button calls a new `POST /api/workitem/<id>/edit` with `iterationPath` =
current sprint (route already exists and already calls `setIterationPath`, which now enforces
the relaxed rule server-side — so the UI can't push a disallowed move; a refusal surfaces in
the existing error banner).

The top-up server query already returns stories from past sprints, the backlog, and other
sprints (it's `listMyOpenStoriesNotInSprint`), so no query change needed — the UI just needs
to know whether a whole-story pull is allowed. Add `canPullStory: boolean` to
`CockpitTopUpStory`, computed server-side with the same `classifyPastSprint` rule (DRY — the UI
shouldn't re-implement the date logic).

---

## 3. Daily "Sprint time" card — one clear story

### Problem (Moran, verbatim sense)
The card shows `69h left after meetings` (good), then `of 85h after meetings` (so what?), then
a bar that actually tracks **working days remaining**, not hours. Three signals, two of them
fighting.

### Decision
Make it one coherent thing — HOURS:
- **Headline** stays: `69h left after meetings` (real desk time still ahead).
- **The bar fills with HOURS, not days**: `pctLeft = availableHoursRemaining / availableHours`.
  So the bar visually matches the headline number.
- **Drop the standalone "of 85h after meetings" line.** Fold the whole-sprint total into the
  bar's meaning: a single quiet caption under the bar reads
  `N working days left · Mh of total Kh`-style — but plain: e.g.
  *"4 working days left — 69h of 85h still open."* One line, the total is context for the
  headline, not a competing number.
- Day-of-N stays in the small card-head meta (top-right) as it is.

Net: big number = hours left; bar = hours left; one caption ties in days + total. No orphan
"of 85h" line.

### Implementation
`src/components/Dashboard.tsx` `SprintTimeCard` (around line 1439): change `pctLeft` to the
hours ratio; remove the `of-line` paragraph; rewrite the caption to combine working-days-left
with the `availableLeft` / `available` totals in one sentence. No server change — the payload
already carries `availableHours`, `availableHoursRemaining`, `workingDaysRemaining`.

---

## 4. Left-rail sprint days — gray weekends, count working days

### Problem
The rail renders all 14 calendar days with no weekend distinction, and the header says
`day X/14`. Moran works Sun–Thu (Fri+Sat off) — 10 working days, and the weekends should read
as off.

### Decision
- Each day cell that falls on **Friday or Saturday** gets an `is-off` class → grayed/dimmed,
  visually clearly not a work day.
- The rail header count uses **working days**, not calendar days:
  `day <workingDayOfSprint> / <workingDaysTotal>` (e.g. `day 3 / 10`), from the capacity
  payload's working-day numbers — NOT the calendar `totalDays`.

### Implementation
- `src/lib/time.ts::sprintDays` — add `isOff: boolean` to each `SprintDay` (true when the
  date's `getDay()` is 5 (Fri) or 6 (Sat)). Keep the existing past/today/future state.
- `src/components/Dashboard.tsx` rail (around line 600) — add `is-off` to the cell class when
  `d.isOff`; change the header `day {today}/{totalDays}` to use the working-day count. The
  card already has access to capacity via the payload — pass `workingDaysTotal` /
  a computed working-day-of-sprint down, or read from `data.capacity`. (The `today`/`totalDays`
  the rail gets today are calendar-based; swap to the capacity working-day figures.)
- `src/styles/dashboard.css` — `.r21-side-week-cell.is-off { opacity / color }` so Fri/Sat
  read as off. Match the existing `is-past`/`is-future` token language.

Note: the "day X of N" shown elsewhere (top bar `day {today}/{totalDays}`, Sprint-time card
meta) is calendar-based today. This change targets the LEFT RAIL specifically (what Moran
pointed at). The top-bar day-of-N is out of scope unless he asks — flag it but don't sweep it,
to keep the change focused.

---

## Files (all four)

- `server/planning-cockpit.ts` — currentSprintCapacity + currentSprintCommittedHours +
  `canPullStory` on top-up stories (uses shared `classifyPastSprint`).
- `server/writes.ts` — relaxed `setIterationPath` + pure `classifyPastSprint`.
- `server/iteration-paths.ts` or a small helper — host `classifyPastSprint` if it keeps
  writes.ts from importing ado's iteration list awkwardly; otherwise inline in writes.ts and
  export for the test. (Decide at build time; keep it pure + tested either way.)
- `server/writes.test.ts` — relaxed-rule tests.
- `server/topup.test.ts` — `canPullStory` cases if computed in `groupTopUp` (pass the
  past-sprint set in).
- `src/lib/api.ts` — payload mirrors (currentSprintCapacity, currentSprintCommittedHours,
  canPullStory).
- `src/components/PlanView.tsx` — TopUpMeter + whole-story pull button + credit pulledHours.
- `src/components/Dashboard.tsx` — SprintTimeCard rewrite + rail weekend/working-day.
- `src/lib/time.ts` — `isOff` on SprintDay.
- `src/styles/dashboard.css` — `.r21-side-week-cell.is-off`, top-up meter (reuse plan2-meter).

## Testing
- Unit: `classifyPastSprint` (past/future/backlog/unknown), relaxed `setIterationPath`,
  `groupTopUp.canPullStory`.
- Build + full suite green.
- Live smoke (Moran): top-up meter fills on pull; whole-story pull works for a New/backlog
  story and is blocked for a started past-sprint story; Daily Sprint-time card reads as one
  hours story; left rail grays Fri/Sat and counts to 10.
```
