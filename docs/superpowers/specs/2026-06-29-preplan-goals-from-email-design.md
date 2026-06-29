# Pre-plan goals from the PM's email — design

**Date:** 2026-06-29
**Status:** approved in chat (brainstorm complete)

## Problem

The Pre-plan page (shipped 2026-06-25) has a goals box that takes "one goal per line"
plain text. But the PM's goals arrive as an **email with a table** — columns Goal / Status /
Owner, a current-sprint block AND a previous-sprint "Is Achieved" block. Pasting that table
into the box makes every line its own "goal", so the header row ("Goal", "Status", "Owner")
and the owner names ("Gleb", "Maxim + Vis", "Moran", "Vis") all become bogus goals, and the
coverage summary reads as nonsense ("Goal 2 — Goal: nobody's carrying this").

Two failures, really:
1. The box can't make sense of a table — and the email's shape changes sprint to sprint, so
   rule-based parsing in the box would be brittle.
2. The page never tells the user the easy path, so next sprint they face the same empty box.

## What we're building

Three connected pieces:

1. **The page instructs the user.** A short line at the top of the goals area:
   *"Paste your goals email into a chat and ask me to set them up."* So the user knows the
   path instead of guessing at the box.
2. **The assistant reads the email and saves the goals.** The user pastes the PM's email into
   a Claude Code chat. The assistant (which already talks to sprint-helper via MCP) extracts
   the real goals, captures each goal's owner, decides which goals are the user's, and writes
   the finished result into sprint-helper through a new tool.
3. **The page shows owner-aware goals.** Each goal shows its owner; the user's own goals stand
   out; coverage still flags goals nobody is carrying — now owner-aware.

This is **local only** — nothing on the Pre-plan page writes to Azure DevOps, unchanged from
the existing design ([[feedback-ado-owns-truth]]).

## Decisions locked in brainstorm

1. **Where parsing happens:** in the chat (the assistant reads the email), NOT in the dashboard
   box and NOT via a copy-a-prompt detour. The assistant is the robust reader because it uses
   judgment, not rules, so it survives the email changing shape.
2. **What gets saved per goal:** `{ text, owner, isMine }` — clean goal text, the owner from
   the table, and whether it's the user's.
3. **How "is it mine" is decided — story-first, owner-name fallback:**
   - These goals are usually stories. If a goal lines up with one of the **user's stories** in
     the current sprint, it's the user's. (Strongest signal — grounded in real ADO assignment.)
   - If no story of the user's matches, fall back to the **owner name** in the email (the
     assistant always knows the user's name, and can read "Moran" / "Maxim + Vis").
4. **The manual box becomes READ-ONLY display.** After goals are set from chat, the box shows
   them (with owners) and can't be hand-edited. The chat is the single way to set/replace
   goals. Accepted trade-off: no on-page manual escape hatch — the user is always in a chat
   when doing this, and the assistant can always re-set goals.

## The assistant's job before saving (context + calculations)

The assistant must make sense of the pasted email BEFORE calling the save tool. It does not
blindly store lines. Specifically:

- **Identify the sprint.** The email names it ("Sprint 13 - planning"). The assistant matches
  that to sprint-helper's CURRENT sprint (via `orient` / `sprint_snapshot`) so goals land on
  the right sprint, not last sprint and not a guess. If the email's sprint doesn't match the
  current sprint, the assistant says so and asks rather than mis-filing.
- **Take only the current-sprint goals.** The email also has a previous-sprint "Is Achieved"
  table — the assistant ignores it. It extracts only the rows under the current sprint's
  goal table, dropping the header row ("Goal / Status / Owner") and any owner-name-only lines.
- **Is this even a goals email?** If the pasted text isn't a recognizable goals email, the
  assistant says so and saves nothing — it never stores junk.
- **Per goal:** capture `text` (the goal) and `owner` (the Owner column), then compute `isMine`
  using the story-first / owner-name-fallback rule above. For the story match, the assistant
  uses the sprint's stories (it can read them via `sprint_snapshot` and reuse the existing
  `story_match` machinery / `suggestGoalIndex`-style judgment).
- **Coverage** is then computed by the page from the saved goals + the user's story links, as
  it already is — now more accurate because goals carry owners.

The page only DISPLAYS what the assistant worked out. No parsing logic lives in the page.

## Architecture

### Data model change — a goal becomes a record (not a bare string)

Today (`server/preplan.ts`): `PrePlanState.goals: string[]`, and a story links to a goal by
**index** (`goalIndex: number | null`). The index linking is load-bearing — keep it.

New: a goal carries owner + mine flag. Introduce:

```ts
export interface PrePlanGoal {
  text: string;          // the goal itself, e.g. "GitOps - finish Phase 1"
  owner: string | null;  // from the email's Owner column; null when none given
  isMine: boolean;       // decided by the assistant (story-first, owner-name fallback)
}
```

`PrePlanState.goals` becomes `PrePlanGoal[]`. Story links stay index-based against this array.

**Backward compatibility:** existing saved state has `goals: string[]`. `getPrePlanState` must
migrate on read: a `string` element becomes `{ text: <string>, owner: null, isMine: false }`.
This keeps the one already-saved sprint (and the manual box's prior text) working. No DB
migration — it's a settings JSON blob; normalize in the read path.

Everywhere goals are consumed by text (e.g. `suggestGoalIndex(storyTitle, goals)`,
`summarizeCoverage`, the payload's `goals`), switch to reading `goal.text`. The payload
exposes the full `PrePlanGoal[]` (the page needs owner + isMine), so `PrePlanPayload.goals`
and `ApiPrePlanPayload.goals` change from `string[]` to the goal-record array (mirror the new
type to `ApiPrePlanGoal` in `src/lib/api.ts`).

### New MCP tool — `preplan_set_goals`

Registered in `mcp/server.ts`, mirroring the existing tool pattern (e.g. `helper_note_add` /
`planning_gaps`). Signature:

```
preplan_set_goals({
  goals: Array<{ text: string; owner?: string | null; isMine?: boolean }>
}) -> { saved: number, sprintName: string }
```

- Resolves the current sprint name SERVER-SIDE (does not trust a client/agent-passed sprint) —
  same rule the `/api/preplan` POST already follows.
- REPLACES the current sprint's goals with the provided list (the assistant sends the full,
  cleaned set each time — this is a "set", not "append"). Per-story `goalIndex` links are
  preserved where they still point at a valid index; links beyond the new length reset to null
  (the assistant is replacing the whole goal set, so stale links are expected to drop).
- Writes via the existing `savePrePlanState`. Local only — no ADO write.
- Defaults: `owner` → null, `isMine` → false when omitted.

The tool's description tells the assistant the workflow plainly: read the pasted goals email,
confirm the sprint matches the current sprint, extract only the current-sprint goals (drop the
header row, owner-name lines, and the previous-sprint table), set `isMine` story-first then by
owner name, then call this with the full cleaned list.

### SERVER_INSTRUCTIONS — a short Pre-plan goals section

Add a brief block so the assistant fires this proactively: when the user pastes a goals email
(or says "set my goals / here are the sprint goals"), the assistant runs the steps above and
calls `preplan_set_goals`. Keep it short — it points at the tool, it doesn't re-teach parsing.

### Page changes — `src/components/PrePlanView.tsx` + CSS

- **Instruction line** at the top of the goals area (above the box): the plain-English hint.
- **Goals box becomes read-only**: render the saved goals as a list (text + owner), not an
  editable textarea. A goal that `isMine` gets a clear (calm, on-theme) marker — e.g. a "mine"
  tag or accent, honoring the no-small-and-gray rule.
- Coverage list + room line unchanged in behavior; coverage now reads `goal.text` and benefits
  from owner-awareness.
- `savePrePlan({ goals })` over the existing `/api/preplan` POST is no longer the page's path
  for setting goals (the box is read-only). The POST stays for the per-story call/goalIndex
  saves, which are unchanged. (The `goals` field on POST can remain for backward-safety but the
  page stops sending it.)

## Data flow
1. User pastes the PM's email into a chat.
2. Assistant: confirm current sprint → extract current-sprint goals → per goal capture owner +
   decide isMine (story-first, owner-name fallback) → call `preplan_set_goals(full list)`.
3. Tool replaces the current sprint's goals locally; returns count + sprint name.
4. User opens / refreshes the Pre-plan page → goals show with owners, the user's flagged,
   coverage owner-aware.
5. Nothing touches Azure DevOps at any step.

## Error handling
- Email isn't a recognizable goals email → assistant says so, saves nothing.
- Email's sprint ≠ current sprint → assistant asks rather than mis-filing.
- Empty goals list passed → tool clears the sprint's goals (valid "reset"); page shows the
  empty state + the instruction line.
- Old `string[]` state on read → normalized to records (owner null, isMine false), no crash.
- Page with no goals → instruction line + calm empty state (today's behavior).

## Testing
- Unit (`server/preplan.test.ts`):
  - `getPrePlanState` normalizes legacy `string[]` goals to `PrePlanGoal[]` (owner null,
    isMine false), and round-trips the new record shape.
  - `suggestGoalIndex` / `summarizeCoverage` read `goal.text` and still pass against records.
  - `buildPrePlanPayload` emits `PrePlanGoal[]` and preserves story `goalIndex` links.
- `preplan_set_goals` is MCP-handler glue (not unit-tested by repo convention) → covered by
  the description + a small pure helper if one is extracted (e.g. a `setGoals(state, goals)`
  merge that resets out-of-range links — unit-test THAT).
- Live smoke (after dashboard restart + MCP reload): paste the real PM email into a chat →
  assistant sets 4 goals with owners, flags the user's → Pre-plan page shows them read-only,
  owner-aware, coverage clean, no header/owner-name junk.

## Out of scope (named so they're decisions, not omissions)
- **Parsing the email in the dashboard box** — rejected; brittle to shape changes. The chat
  reads it.
- **A copy-a-prompt detour through the dashboard** — rejected; the email is already in hand,
  paste straight to the assistant.
- **Hand-editing goals on the page** — rejected; box is read-only, chat is the single setter.
- **Writing goals or ownership to Azure DevOps** — local prep only.
- **Auto-importing the email (IMAP/Graph)** — out; the user pastes it. (Calendar/Outlook
  integration elsewhere is separate.)
- **Capturing the previous-sprint "Is Achieved" table** — ignored; only current-sprint goals.

## Files
- `server/preplan.ts` — `PrePlanGoal` type; `PrePlanState.goals: PrePlanGoal[]`; legacy
  normalization in `getPrePlanState`; switch text consumers to `goal.text`; payload emits
  records; a `setGoals(state, goals)` merge helper (pure, tested).
- `server/preplan.test.ts` — normalization + record round-trip + payload tests.
- `mcp/server.ts` — register `preplan_set_goals`; short SERVER_INSTRUCTIONS Pre-plan-goals
  block.
- `src/lib/api.ts` — `ApiPrePlanGoal`; `ApiPrePlanPayload.goals` becomes the record array.
- `src/components/PrePlanView.tsx` — instruction line; read-only owner-aware goals list; stop
  sending `goals` on POST.
- `src/styles/dashboard.css` — styles for the instruction line + owner / "mine" markers.

## Note on reload
Server + page changes need a **dashboard dev-server restart**. The new MCP tool +
SERVER_INSTRUCTIONS need an **MCP reload** (`/exit` + `claude --resume`) in the work chat to
become callable. Both, for the full flow.

## Related memory
[[feedback-ado-owns-truth]] (local prep), [[reference-sprint-helper-skill]] /
[[feedback-pull-vs-react-split]] (fire from natural language, not a menu),
[[feedback-plain-english-ui]] / [[feedback-plain-english-output]] (no jargon),
[[feedback-no-small-and-gray]] (the "mine" marker), [[feedback-self-identify-story]] /
[[reference-backlog-classification]] (story matching for isMine), [[project-build-state]].
