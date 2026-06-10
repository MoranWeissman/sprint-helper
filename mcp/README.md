# sprint-helper MCP server

Lets Claude Code (or any MCP client) read sprint-helper data and drive edits
and session logging — the same backend the Vite dashboard uses. Time is tracked
silently by the session lifecycle; there are no manual timer tools.

## Register with Claude Code

From any directory, run:

```sh
claude mcp add sprint-helper -- npm --prefix /Users/weissmmo/projects/github-moran/sprint-helper run mcp --silent
```

Then in any Claude Code session, the tools below will be available.

To remove later: `claude mcp remove sprint-helper`.

## Tools

| Tool | What it does |
|---|---|
| `orient` | **Opening greeting.** Call this BEFORE responding whenever Moran is reorienting — at the start of a new chat, after a /compact, when she resumes and greets you ("hi", "morning", "where were we"), etc. Don't wait for a brand-new session — she almost always works through resume/compact, so the greeting triggers matter more. Call at most once per orientation moment. Returns a small read of: what time of day it is, what day of the sprint we're on, any work sessions still open, the last task she worked on (with her summary), the current helper's notes + how many nudges are still open, and a quick count of stories/tasks missing planning fields. Use it to write a friendly 2-4 sentence greeting — not a dump of the numbers. |
| `sprint_snapshot` | Current sprint + counts + in-progress items + live sessions. Heavier than `orient`; call when you need the full board. |
| `list_my_work_items` | Flat list of work items in the sprint. Optional `state` filter: `inProgress` / `upNext` / `done`. |
| `sprint_check_in` | **Guardrail.** Before starting unplanned work, check whether it's in Moran's sprint. Returns matches + a `nextStep` (`confirm_match` / `choose_match` / `no_match`). |
| `task_create` | Create a new Task in the current sprint. **Requires `estimateHours`** — ask Moran for it first. Sets both OriginalEstimate and RemainingWork. `adHoc: true` tags it for the quick 1–2h case. Optional `parentStoryId`. |
| `story_create` | Create a new User Story in the current sprint. **Requires `storyPoints` (her team: 1 point = 1 day) AND `effortHours`** — ask Moran for both first. Optional `parentFeatureId`. |
| `workitem_edit` | Update state (`waiting` / `going` / `done`), `originalEstimate`, `remainingWork`, `storyPoints`, or `effort` in ADO. Use this to backfill planning fields on existing items. |
| `session_start` | Open a session against a work item. Returns a `sessionId` and silently starts tracking time. Idempotent. |
| `session_log` | Record an event in a session: `focus` / `progress` / `blocker` / `decision` / `note`. |
| `session_end` | Close a session with a one-line summary. Pauses the silent timer. Pass `done: true` (only after Moran confirms) to push the tracked time to Azure DevOps and close the task. |
| `helper_notes_get` | Read what's in Moran's "helper's notes" space now: his open nudges. Call before writing to avoid repeats. |
| `helper_note_add` | Drop one short, casual plain-English nudge into his notes space. He ticks them off himself — don't spam. Never writes to ADO. |

## Recommended flow at session start

1. Call `orient` first — write a short greeting from what it returns (where she left off, what day of the sprint, how many helper notes are still open).
2. Ask Moran what she wants to pick up today.
3. Call `sprint_check_in` with her description.
4. Based on `nextStep`:
   - `confirm_match` — confirm the match, then `session_start({workItemId})`.
   - `choose_match` — list the candidates, ask which, then `session_start`.
   - `no_match` — ask whether it's a quick ad-hoc thing or a real new story.
     Call `task_create` (with `adHoc: true` for the quick case), then
     `session_start` against the new id.
5. As you work, call `session_log` for blockers / decisions / progress notes.
   Time tracks itself while the session is open — don't manage it by hand.
6. When wrapping up, ask Moran: "done, or just stopping for now?"
   - Stopping → `session_end` with a summary (time pauses, nothing written to ADO).
   - Done → confirm first, then `session_end` with `done: true` + a summary
     (pushes the tracked time and closes the task).

Throughout, keep Moran's "helper's notes" space current: drop the
occasional nudge (`helper_note_add`) when you spot something worth his attention
— a low estimate, a stalled task, a clear day for deep work. Check
`helper_notes_get` first so you don't repeat yourself. These are just your read
for him; they never touch Azure DevOps.

## Notes

- Single-user, local-only. No auth — the MCP server runs as the same OS user
  as Moran's `az login`.
- Writes share the same SQLite file (`~/.sprint-helper/data.db`) and the same
  ADO credentials as the dashboard, so changes show up in both places.
- Session events surface live in the Day dashboard (activity feed + live markers).
