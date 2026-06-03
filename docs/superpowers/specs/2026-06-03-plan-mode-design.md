# Plan mode — sprint-wide effort discipline

**Date:** 2026-06-03
**Status:** Design decided with Moran. Not yet planned for implementation.

## Goal

Give Moran a way to address sprint-wide effort gaps — items missing OriginalEstimate, RemainingWork, StoryPoints, or Effort — without polluting his story-anchored work chats. The chat-per-cwd model stays focused on execution. Planning lives elsewhere.

## The problem

Sprint-helper's job at the operating-model level is to **never let a task or story in the sprint go without effort numbers**. Right now Moran has a lot of items missing them. The MCP can technically see every item in the sprint, but each Claude Code chat is anchored to one specific story (by cwd), so sprint-wide cleanup feels wrong inside a focused work chat.

## What we decided

### 1. Sprint-helper gets a configurable "home" folder; cwd is the mode signal

- At install (or via a one-time config), the user picks a path for the sprint-helper home folder. Default: `~/sprint-helper/` (already used for the markdown archive) or a new `~/.sprint-helper-home/`.
- When Claude Code opens a chat in that cwd, sprint-helper recognizes it as the planning home — skips the story-anchor (no `story_match` prompt), enables sprint-wide skills.
- Work cwds stay story-anchored as today. Nothing changes for them.
- Detection signal: a marker file inside the folder (e.g. `.sprint-helper-home`) AND/OR a setting in SQLite that records the configured path. Marker file is the strong, explicit signal.

### 2. Plan mode lives in the dashboard

A new tile on the left mode rail. Surfaces sprint-wide planning needs. Two affordances:

#### a. "Scan for gaps" button

- Click it. Dashboard runs a server-side gap query: items missing effort fields, grouped by feature/story, sorted by some sensible priority.
- Result is shown as a list AND turned into a ready-to-paste Claude Code prompt.
- Moran clicks **"Copy prompt"**, pastes it into a Claude Code session (typically the sprint-helper home chat from item 1 above).
- The AI walks through the gaps one at a time using `estimate_anchor` + the decompose-anchor-propose ritual. Each accepted estimate goes through MCP (which already enforces effort discipline at the schema level).
- Dashboard is the **discovery surface**. Chat is the **execution surface**. Clean split.

#### b. Per-item view: show the anchor proposal

- For each gap, the dashboard shows the deterministic anchor proposal inline: "Past tasks under this story averaged **5h** actual. Anchor proposes **5h**."
- The dashboard does NOT let you accept/edit inline. Creation and edit of effort fields stays in the MCP-driven chat flow. The dashboard surfaces what the proposal *will be* so Moran knows what's coming.
- Items with no historical sibling data are flagged: "cold start — needs a real conversation, not a quick accept".

### 3. Creation discipline stays MCP-only

- No "Create story" or "Create task" button in the dashboard.
- All creation flows through Claude Code via `task_create` / `story_create` — already enforce effort fields at the schema level.
- Reason: the decompose-anchor-propose ritual is a conversation, not a form. A form would just shove a number into ADO without the thinking; that's the failure mode we're trying to avoid.

### 4. Mark sprint-helper-created items locally

- New SQLite table: `sh_created_items(work_item_id INTEGER PRIMARY KEY, kind TEXT, created_at TEXT)`.
- On successful `task_create` / `story_create`, MCP logs a row.
- Dashboard payload includes a per-item `wasSHCreated` boolean (joined locally).
- Dashboard UI shows a discreet "SH" pip on those items — visible only to Moran.
- Nothing goes to ADO. Truly invisible on the board.
- Use cases: SH knows what it's responsible for keeping honest; useful for retros ("how did SH-created estimates land?"); catches accidental breakage.
- Acceptable risk: if the local SQLite is wiped, the marker is gone. Data lives on Moran's laptop already (timers, sessions, helper notes) — one more local fact fits the pattern.

## Out of scope (explicitly)

- **Embedded chat / terminal in the dashboard.** Decided too heavy for the value. If we want a faster path from dashboard to a Claude Code chat, a "Launch Claude Code here" button (one OS call to open Terminal at the planning home) is the lighter alternative, deferred to future polish.
- **Dashboard-side creation UI.** Decided to keep creation in MCP — see item 3.

## Generated prompt template

The "Copy prompt" button assembles a deterministic prompt from the gap list. Names before numbers. Echoes `displayName` verbatim.

```
Please help me fill in missing effort for these sprint items. For each, run
the decompose-anchor-propose ritual:

  1. Call `mcp__sprint-helper__estimate_anchor` with the item's parent id.
  2. Decompose the task into 2-4 sub-steps.
  3. Propose hours with the citation visible (per
     feedback_effort_propose_burndown).
  4. Wait for my confirmation before patching via `workitem_edit`.

Walk these one at a time, in order. Don't ask which to start with — start
with the first one.

Items needing effort (N total):

- **<task displayName>** (#id) — Task under **<story displayName>** (#id).
  Missing: OriginalEstimate, RemainingWork.
- **<story displayName>** (#id) — Story under **<feature displayName>** (#id).
  Missing: StoryPoints, Effort.
- ...
```

The prompt is verbose on purpose — when pasted into a fresh chat with no context, the model needs to be reminded of the ritual.

## Build sequence sketch

Not a full plan — that comes via writing-plans when we're ready to implement. Rough order:

1. **Planning-home detection.** Marker file + settings entry. New "PLANNING HOME" block in `SERVER_INSTRUCTIONS` telling the model to skip the story-anchor in that cwd. Updates to `server/orient.ts` to recognize the home cwd.
2. **sh_created_items table.** Migration + writes hook in MCP `task_create` / `story_create` + dashboard payload field.
3. **Gap scanner backend.** `server/planning.ts::findGaps()` returning a structured list. `/api/planning/gaps` endpoint. Prompt-assembly helper that produces the markdown above.
4. **Plan mode UI.** Mode tile on the left rail. Gap list grouped by feature/story. Per-item anchor proposal. "Copy prompt" button. SH-created pip elsewhere in the UI.

Each step is shippable independently.

## Open questions

- Default location of the planning home folder: `~/sprint-helper/` (overload the archive folder) or a separate `~/.sprint-helper-home/`? Overloading the archive folder is convenient but mixes purposes; separating is cleaner but adds another path to manage.
- Should the "Copy prompt" button also offer a "Launch Claude Code in planning home" companion (the lighter version of the rejected embedded-chat idea)? Probably yes, as a future polish.
- Anchor proposal in the dashboard: do we want it to show even WITHOUT clicking the gap scanner? E.g., next to every existing estimate as a "the anchor would have proposed X vs. the current Y"? Probably no — too noisy. Only show on items in the gap list.

## How this fits the existing roadmap

This replaces the R6 "Plan / Pre-plan" line item from `project_slice_backlog.md` with a sharper design. Pre-plan and Plan in the original spec were vaguely about "stories+tasks+efforts checked against real capacity"; this spec makes that concrete — checked how, by whom, with what UI.
