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
| `sprint_snapshot` | Current sprint + counts + in-progress items + live sessions. Good to call at the start of a chat. |
| `list_my_work_items` | Flat list of work items in the sprint. Optional `state` filter: `inProgress` / `upNext` / `done`. |
| `sprint_check_in` | **Guardrail.** Before starting unplanned work, check whether it's in Moran's sprint. Returns matches + a `nextStep` (`confirm_match` / `choose_match` / `no_match`). |
| `task_create` | Create a new Task in the current sprint. `adHoc: true` tags it for the quick 1–2h case. Optional `parentStoryId` and `estimateHours`. |
| `workitem_edit` | Update state (`waiting` / `going` / `done`), original estimate, or remaining work in ADO. |
| `session_start` | Open a session against a work item. Returns a `sessionId` and silently starts tracking time. Idempotent. |
| `session_log` | Record an event in a session: `focus` / `progress` / `blocker` / `decision` / `note`. |
| `session_end` | Close a session with a one-line summary. Pauses the silent timer. Pass `done: true` (only after Moran confirms) to push the tracked time to Azure DevOps and close the task. |

## Recommended flow at session start

1. Call `sprint_snapshot` to see what's going on.
2. Ask Moran what she wants to work on.
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

## Notes

- Single-user, local-only. No auth — the MCP server runs as the same OS user
  as Moran's `az login`.
- Writes share the same SQLite file (`~/.sprint-helper/data.db`) and the same
  ADO credentials as the dashboard, so changes show up in both places.
- Session events surface live in the Day dashboard (activity feed + live markers).
