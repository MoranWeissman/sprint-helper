# Skills sync — one edit, every copy updated

Date: 2026-07-27
Status: approved (chat), pending user review

## The problem

The workspace-craft skills (`demo`, `discovery`, `walkthrough`) live as copies in
three kinds of places:

1. the **seed** — `~/projects/github-moran/features/.claude/skills/<name>` (the
   canonical source; `workspace_set` already scaffolds new workspaces from it),
2. every **registered workspace** — `<workspace>/.claude/skills/<name>`,
3. the **global** folder — `~/.claude/skills/sprint-helper-plus/skills/<name>`.

`ensureWorkspaceScaffold` already copies seed skills into workspaces, but it only
ADDS skills a workspace is missing — it never overwrites. So an EDIT to an
existing skill does not travel. Today (2026-07-27) the demo skill was updated by
hand-copying to all three places. Forget one copy and the folders silently
drift: one chat builds demos the new way, another the old way.

Key fact that shapes the design: a session reads a skill's body from disk at the
moment it invokes the skill. There is no per-session cache of skill bodies to
refresh — fixing the FILES fixes every session, open or future, at once. (Only
the skill name/description list is cached per session; we don't change those.)

## The fix — a `skills_sync` MCP tool

One new tool on the sprint-helper MCP server. No inputs. Any chat can trigger it
("sync the skills").

- **Canonical source: the seed.** The rule going forward: edit a managed skill
  at the seed path, then run `skills_sync`. Never hand-copy again.
- **Managed list, explicit in code:** `MANAGED_SKILLS = ['demo', 'discovery',
  'walkthrough']`. Only these are synced. The seed's ~65 BMAD skills and the
  global-only session subs (`end-work`, `new-work`, `pause-work`, `resume-work`,
  `status`) are out of scope (see below). Adding a skill to the list is a
  deliberate one-line code change.
- **Destinations per managed skill:**
  - `<workspace>/.claude/skills/<name>` for every workspace returned by
    `getWorkspaces()` (skips a workspace folder that no longer exists on disk —
    reported, not an error),
  - `~/.claude/skills/sprint-helper-plus/skills/<name>`.
- **Overwrite semantics:** destination folder is replaced by the seed folder
  (delete + recursive copy), so removed files disappear too.
- **Compare first, report plainly:** each skill×destination is checked (content
  compare over the folder's files) and the tool returns a short plain-English
  report — e.g. "demo: updated in 2 places · walkthrough: already current
  everywhere · discovery: already current everywhere". No banned jargon; the
  report text ships from the server pre-formatted, per the echo-API-strings
  rule.
- **Missing seed skill:** if a managed skill is absent from the seed, the report
  says so plainly and that skill is skipped. Never delete a destination because
  the seed lost a folder — that needs a human look.

## Drift nudge (enforce in code, not prose)

Reuse the existing every-tool-response nudge pipe (same infrastructure as the
stale-log nudge): a cheap drift check compares the seed's managed skills against
all destinations. When copies differ, any chat's next tool response carries one
plain line — "the demo skill's copies are out of sync — run skills_sync." Cost
control: the check is stat/hash over a handful of small files and runs at most
once per hour per server process; between runs the pipe adds nothing.

## Server instructions

Add a short block to SERVER_INSTRUCTIONS: managed skills are edited AT THE SEED,
then `skills_sync` fans them out; never hand-copy; the tool exists and what it
reports. Honest limitation, stated in the block: changes to SERVER_INSTRUCTIONS
itself only reach a chat when its MCP connection restarts — skills need no
restart, the manual does.

## Out of scope (deliberate)

- **BMAD skills**: still handled by the existing add-only scaffold sync.
  Overwriting 65 vendored folders on every sync is risk without a present need.
- **Session subs** (`end-work` etc.): global-only, no copies, nothing to sync.
- **Pushing instruction text into open sessions**: not possible by protocol;
  documented, not worked around.
- **A per-session "update my skills" command**: unnecessary — disk is shared;
  one sync fixes all sessions.

## Testing

- The sync function is pure fs over paths → unit tests in
  `server/workspace.test.ts` style, on temp dirs: updates a stale copy, leaves a
  current copy untouched, adds a missing skill folder, skips + reports a dead
  workspace path, skips + reports a seed-missing skill, removed file in seed
  disappears at destination.
- The drift check: unit test the compare on temp dirs (in sync / out of sync).
- The MCP tool handler itself is inline glue → user smokes it (per project
  convention: MCP handlers are not unit-tested).

## Success criteria

Edit the seed's demo skill, call `skills_sync` from any chat: every workspace
and the global folder are byte-identical to the seed, and the report names what
changed. Break a copy on purpose: the next tool response in any chat mentions
the drift.
