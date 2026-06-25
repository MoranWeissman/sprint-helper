# Pre-plan page — design

**Date:** 2026-06-25
**Status:** approved in chat (brainstorm complete)

## Problem

Every second Monday there's a pre-plan meeting. The delivery manager (PM) reviews the
sprint's agreed goals (he emails them each time) and goes around asking each engineer, per
story they're carrying: **will it finish this sprint, is it blocked, or does it carry to the
next sprint?** The point of the meeting is early slippage detection — a week before it's too
late to react. Moran's value isn't the meeting itself; it's **walking in already knowing the
answer for each of his stories** instead of being put on the spot.

Today the `preplan` mode exists as a tab but shows only a "coming soon" placeholder
(`ModePlaceholder`). This builds the real page.

## What it is

A **prep screen** — opened before the meeting. For each story Moran is carrying this sprint,
it shows the facts that drive the call and lets him set the call. It is **his private prep**:
nothing on this page writes to Azure DevOps. The board stays the system of record; this page
is context/memory (per [[feedback-ado-owns-truth]]).

It is NOT a live note-taking surface for use during the meeting, and NOT a "capture what was
decided" tool — purely prep beforehand. (Considered and rejected in brainstorm.)

## Decisions locked in brainstorm

1. **Purpose:** prep me before the meeting (not capture-during, not both).
2. **Goals email:** paste the goals in + link stories to goals (not skip, not auto-match).
3. **Goal linking:** suggest-then-confirm, one tap. Never silently auto-assigned.
4. **Where the call lives:** private prep note, local only. Nothing written to ADO from this
   page — including "blocked" (we do NOT flip ADO's Blocked state from here).
5. **Which stories show:** started + not-done stories (Active / Blocked / in-progress, not
   Closed). New/never-started stories and done stories are excluded.
6. **Call suggestion:** suggest-then-override, from facts the page can read honestly.

## The honest limit on suggestions (why the math is sprint-wide, not per-story)

"Room left in the sprint" is a **single sprint-wide number** — Moran's available hours after
meetings, shared across all his stories. The page therefore CANNOT truthfully say "*this*
story is at risk because its hours don't fit the room" — the room is shared, and which story
slips is exactly the human judgment the meeting exists for. Faking a per-story version would
point at the wrong story.

So suggestions are split:

- **Per-story call suggestion** uses only facts that read cleanly on one story:
  - story is **Blocked** (ADO state or `Blocked` tag) → suggest **At risk**;
  - **no activity in 3+ working days** AND hours still remain → suggest **At risk**;
  - otherwise → suggest **On track**.
  - It **never** auto-suggests **Carries over** — rolling a story to next sprint is a
    deliberate planning act, not a guess.
- **One sprint-wide room line** does the overcommit math honestly, e.g.
  *"Your open stories need about 40h; you've got about 28h of room left — roughly 12h won't
  fit."* Reuses the capacity numbers Daily already computes. No blame on any one story.

The suggestion is always overridable with one tap; the stored call is whatever Moran set.

## Page layout

Three stacked regions in the main column (peer of the Plan page; opens stories in the
existing `WorkItemDrawer`):

### 1. Goals strip (top)
A text box where Moran pastes the PM's goals from the email, one goal per line. Saved
per-sprint. On a fresh sprint it's empty (last sprint's goals are not carried forward — a new
email comes each time). Parsed into a list by line; blank lines ignored. Each goal gets a
stable index (Goal 1, Goal 2, …) used for linking and the coverage line.

### 2. Story cards (main column)
One card per carried story (started + not-done). Each card shows:
- Story `displayName` (`**title** (#id)`), opens the drawer on click.
- **Hours left** — the story's `remainingHours` (rolled-up open-task hours).
- **Blocked?** — from the story's ADO state or `Blocked` tag.
- **Last activity** — newest `recentActivity[].createdAt`, shown as "Xd ago" / "today"; "no
  activity logged" when the list is empty.
- **The call** — a three-way pick: **On track · At risk · Carries over**. Pre-filled with the
  page's suggestion the first time; Moran's saved choice thereafter. A small "suggested"
  marker shows when the current value still equals the suggestion (so he can see what he
  hasn't reviewed yet).
- **Goal link** — a dropdown of the pasted goals plus "no goal". Pre-filled with the
  suggested goal (token-overlap match, same approach as `sprint_check_in` / story-match);
  Moran confirms or changes. Disabled/hidden when no goals are pasted yet.

### 3. Coverage line (below cards, only when goals exist)
A short plain-English summary tying goals to the stories linked to them:
- "Goal 2 — 2 stories on it."
- "**Goal 3 — nobody's carrying this.**" ← the gap the PM cares about, emphasized.
Plus the sprint-wide room line described above.

## Architecture

Follows the Plan page's end-to-end shape exactly (backend payload builder → one API endpoint
→ a view component → `WorkItemDrawer` reuse). New, focused files; no rewrite of existing ones.

### Backend — `server/preplan.ts` (new)
- `buildPrePlanPayload(): Promise<PrePlanPayload>`:
  - Reads `buildDashboardCached()` for the current sprint's `userStories` + capacity (same
    source Daily/Plan use — no new ADO calls).
  - Selects carried stories: `type` is story-level (User Story / Bug — not Feature/Epic) AND
    `state` not in `DONE_STATES` AND the story is started (`hasActiveSession`, OR `state` in
    `ACTIVE_STATES`, OR it has any non-done task). (Mirrors how the dashboard already buckets.)
  - For each, projects the card facts: `id`, `displayName`, `remainingHours`, `blocked`
    (state/tag), `lastActivityAt` (max `recentActivity[].createdAt` or null).
  - Computes the sprint-wide room line inputs: `openStoriesRemainingHours` (Σ carried-story
    `remainingHours`) and `roomHours` (from capacity — available-after-meetings remaining).
  - Loads Moran's saved per-sprint state (goals, calls, links) and merges: each card carries
    its saved `call` + `goalIndex` if present, else the page's suggestion.
- Pure helpers in this file, unit-tested:
  - `suggestCall({ blocked, lastActivityAt, remainingHours, now, workingDaysIdleThreshold })`
    → `'on-track' | 'at-risk'` (never `'carries-over'`).
  - `suggestGoalIndex(storyTitle, goals)` → number | null (token-overlap; reuse the existing
    matching util the guardrail/story-match use; threshold returns null when weak).
  - `summarizeCoverage(cards, goals)` → per-goal counts + the "nobody's carrying" list.
- The "started + not-done" selection and the idle-days computation are pure and testable
  (pass `now` in; no `Date.now()` baked into the pure layer).

### Storage — local, per-sprint (no new table)
One settings row per sprint, key `preplan_<sprintName>`, value a JSON blob:
```jsonc
{
  "goals": ["Improve rollout confidence", "..."],   // pasted lines
  "stories": {
    "443697": { "call": "carries-over", "goalIndex": 1 }
  }
}
```
Uses the existing `getSetting`/`setSetting` (`server/timers.ts`) + JSON, the same pattern as
the capacity nudge and ceremony schedule. Read/written through small helpers in
`server/preplan.ts` (`getPrePlanState(sprintName)` / `savePrePlanState(sprintName, state)`).
Stories absent from the blob fall back to the suggestion. No migration needed.

### API — `vite.config.ts` middleware (mirrors `/api/planning/cockpit`)
- `GET /api/preplan` → `buildPrePlanPayload()`.
- `POST /api/preplan` → body `{ goals?: string[], story?: { id, call?, goalIndex? } }`;
  merges into the per-sprint blob via `savePrePlanState`, returns the updated payload. Granular
  saves (one story's call, or the goals text) so the UI can fire on each change.
  Server resolves the current sprint name itself (don't trust a client-passed sprint).

### Frontend — `src/components/PrePlanView.tsx` (new)
- Routed in `Dashboard.tsx` when `mode === 'preplan'` (replaces `ModePlaceholder` for that
  mode only — the others keep the placeholder).
- Fetches `/api/preplan`; renders goals strip + cards + coverage line.
- Calls (three-way) and goal links save optimistically via `POST /api/preplan` (same
  optimistic-with-revert pattern as the existing edit hooks).
- Goals box saves on blur (debounce-free; one POST when focus leaves).
- Opens stories via the `onOpenItem` prop already used by `PlanView`.
- CSS namespaced `preplan-*` in `dashboard.css`, reusing existing palette tokens + the
  Jira-backlog row vocabulary from the Plan page (per [[feedback-planning-view-shape]]).

### API types — `src/lib/api.ts`
`ApiPrePlanCard`, `ApiPrePlanPayload`, `fetchPrePlan()`, `savePrePlan(body)` — mirrors the
`fetchCockpit` helpers.

## Data flow
1. `PrePlanView` mounts → `GET /api/preplan`.
2. Server builds facts from the cached dashboard + capacity, merges Moran's saved blob,
   computes suggestions for any story he hasn't set yet, returns payload.
3. Moran pastes goals / sets a call / picks a goal link → `POST /api/preplan` → blob updated →
   fresh payload returned → view reconciles.
4. Nothing touches ADO at any step.

## Error handling
- No sprint / dashboard build fails → endpoint returns `{ error }`; view shows the same calm
  error state the Plan page uses. Never throws to a blank screen.
- Empty goals → goal-link dropdowns and the coverage line are hidden; cards still work.
- No carried stories → calm empty state ("No stories in flight to review — nothing to prep.").
- Capacity unavailable (no calendar) → the sprint-wide room line is hidden; per-story facts
  and calls still work. (Don't block the page on Outlook.)

## Testing
- Unit (Vitest), `server/preplan.test.ts`:
  - `suggestCall`: blocked → at-risk; idle 3+ working days with hours left → at-risk; fresh
    activity → on-track; never returns carries-over.
  - story selection: excludes done + never-started; includes Active / Blocked / has-open-task.
  - `summarizeCoverage`: per-goal counts; flags goals with zero stories.
  - `suggestGoalIndex`: returns null on weak overlap; picks the obvious match on strong.
  - room-line math: Σ remaining vs room, sign of the gap.
- MCP/handler + React glue not unit-tested by repo convention → Moran live-smokes (below).
- Live smoke (after dashboard restart): open Pre-plan → carried stories appear with facts;
  paste 3 goals → link suggestions appear, confirm/override sticks across reload; set a call
  on each → persists across reload; coverage line flags an uncovered goal; room line reads
  honestly against Daily's number.

## Out of scope (named so they're decisions, not omissions)
- **Writing any call to ADO** — including Blocked. Local prep only.
- **Capture-during-meeting / "decided" state** — rejected; this is prep only.
- **Auto-matching goals without confirmation** — rejected; suggest-then-confirm only.
- **Per-story room math** — impossible to do honestly (shared sprint room); sprint-wide line
  instead.
- **Auto-suggesting "carries over"** — deliberate planning act, left to Moran.
- **An MCP/chat tool for pre-plan** — UI-only for now (matches how Plan/top-up shipped).
- **Carrying goals forward between sprints** — a new email arrives each time; start empty.

## Files
- `server/preplan.ts` (new) — payload builder + pure suggestion/coverage helpers + state I/O.
- `server/preplan.test.ts` (new) — unit tests for the pure helpers + selection.
- `vite.config.ts` — `GET`/`POST /api/preplan` middleware.
- `src/lib/api.ts` — `ApiPrePlan*` types + `fetchPrePlan` / `savePrePlan`.
- `src/components/PrePlanView.tsx` (new) — the view.
- `src/components/Dashboard.tsx` — route `mode === 'preplan'` to `PrePlanView`.
- `src/styles/dashboard.css` — `preplan-*` styles.

## Note on reload
The backend + API changes need a **dashboard dev-server restart** (Vite doesn't HMR backend
code). No MCP change, so no `claude --resume` needed. Plain browser refresh isn't enough for
the server-built payload.

## Related memory
[[feedback-ado-owns-truth]] (local prep, board owns truth), [[feedback-planning-view-shape]]
(row vocabulary + responsive shape), [[feedback-plain-english-ui]] / [[feedback-plain-english-output]]
(no jargon), [[feedback-capacity-preferences]] (Sun–Thu, 9h, room math source),
[[reference-ado-state-machine]] (Blocked is a real state), [[project-build-state]].
