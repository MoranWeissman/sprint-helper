# Sprint-helper fix: derive Story Points from Effort (they must correlate)

**Status:** brief filed 2026-06-03, awaiting implementation plan
**Source:** Moran, 2026-06-03 — bug observed live on the board (story #431995 showing 4 pts beside 18h)

## Problem

StoryPoints and Effort are currently independent fields — nothing ties them together, so they drift. Example on the board: story #431995 shows 4 points (renders as "4d") next to 18h effort. 18h is ~2 days, so the card contradicts itself: "4d" beside "18h." This isn't a calc error — it's that the two fields were entered separately with no relationship enforced.

## The rule

Effort (hours) is the source of truth. Story Points are a derived view of it, not a separately-entered number:

```
pointsAsDays   = effortHours / workdayHours        # workdayHours is the configured workday (currently 9)
storyPoints    = round(pointsAsDays * 2) / 2        # round to nearest 0.5
```

Worked examples (workday = 9h):

| Effort | ÷ 9  | Points              |
|--------|------|---------------------|
| 9h     | 1.00 | 1.0                 |
| 15h    | 1.67 | 1.5                 |
| 18h    | 2.00 | 2.0                 |
| 24h    | 2.67 | 2.5 ← worked example |
| 27h    | 3.00 | 3.0                 |
| 36h    | 4.00 | 4.0                 |

## Behavior to implement

1. **Compute, don't ask.** When Effort is set or changed on a story (`workitem_edit`, `story_create`, or rolled up from child task hours), auto-compute StoryPoints with the formula above and write both. Don't take points as a separate free input that can disagree.
2. **Use the configured workday.** Read `workdayHours` from the same place capacity uses (currently 9) — don't hardcode 9, so it tracks if the workday changes.
3. **Reconcile-on-read for existing items.** For stories that already have mismatched values (like #431995: 4 pts / 18h), flag them — and on the next effort edit, recompute points so they self-heal. Optionally a one-time sweep that recomputes points from effort across open stories.
4. **Gap check.** The planner should stop treating StoryPoints as a separate "missing" field once Effort exists — if Effort is present, points are derived, so there's no independent points gap.
5. **Edge: if Effort is absent**, leave points blank (can't derive) and report it as the single gap — "missing Effort," not "missing Effort + Points."

## Net

One number to enter (Effort hours), points always follow, and the "4d / 18h" contradiction becomes impossible.

## Implementation pointers (for the next session)

- Story writes go through `mcp/server.ts::story_create` and `mcp/server.ts::workitem_edit`. Both reach `server/writes.ts`. The derivation should sit close to where Effort is written so it can't be bypassed.
- `workdayHours` source: capacity module uses 9 today; check `server/capacity.ts` and the settings table — the value should be read at compute time, not captured at module load.
- Gap check lives in `server/planning.ts::findGaps()` (the R12 cockpit gap scanner). Update its logic so StoryPoints alone is never the gap — only missing Effort is.
- Memory entry `feedback_features_planning_optional.md` already says Features + Epics don't carry these fields — only User Stories. This change keeps that constraint and tightens the Story rule.
- Rolled up from child task hours: confirm whether sprint-helper currently rolls task Effort up into story Effort. If not, that's a separate behavior to add (or to explicitly skip in this fix and capture as a follow-up).
