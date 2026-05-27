# sprint-helper MCP server

Lets Claude Code (or any MCP client) read sprint-helper data and drive timers,
edits, and session logging — the same backend the Vite dashboard uses.

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
| `sprint_snapshot` | Current sprint + counts + in-progress items + active timers/sessions. Good to call at the start of a chat. |
| `list_my_work_items` | Flat list of work items in the sprint. Optional `state` filter: `inProgress` / `upNext` / `done`. |
| `timer_start` | Start tracking time on a work item. Idempotent. |
| `timer_pause` | Pause the timer. |
| `timer_sync` | Push tracked time to Azure DevOps (CompletedWork). |
| `timer_done` | Sync time + transition the item to Done/Closed. |
| `workitem_edit` | Update state (`waiting` / `going` / `done`), original estimate, or remaining work in ADO. |
| `session_start` | Open a Claude Code session against a work item. Returns a `sessionId`. |
| `session_log` | Record an event in a session: `focus` / `summary` / `blocker` / `decision` / `note`. |
| `session_end` | Close a session with an optional final summary. |

## Notes

- Single-user, local-only. No auth — the MCP server runs as the same OS user
  as Moran's `az login`.
- Writes share the same SQLite file (`~/.sprint-helper/data.db`) and the same
  ADO credentials as the dashboard, so changes show up in both places.
- The sprint guardrail (`sprint_check_in`, `task_create`) lands in slice 2.1c.
