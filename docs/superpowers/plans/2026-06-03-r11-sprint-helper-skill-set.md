# R11 — /sprint-helper named skill set

**Goal:** Add four named slash-command skills so Moran can re-anchor the assistant on key sprint-helper operations when it drifts past the in-context rules. Recovery tool, not primary UX — automatic triggers (orient, blockNudge, story_match) still fire on their own.

**Approach:** Each skill is a self-contained, one-shot prompt that walks the model through the right MCP tools + rules for that operation. Mirrors the existing `/sprint-helper` shape (frontmatter with `disable-model-invocation: true`, body tells the model exactly what to do).

**The set (decided with Moran 2026-06-03):**

- `/sprint-helper:resume-work` — re-anchor after a chat restart / compact.
- `/sprint-helper:end-work` — pause-vs-done close-the-loop flow.
- `/sprint-helper:status` — read out today's situation (today + yesterday, capacity, blockers) without opening the dashboard.
- `/sprint-helper:new-work` — bootstrap a fresh task or story when starting work that isn't in the sprint yet.

**Skipped on purpose:**
- `check-block` — Moran said no; block-clearing happens organically when he tells the model in conversation that something's unblocked. R10a's auto blockNudge handles the "model drifted past a stale block" case.

---

## Task 1: Verify skill subcommand convention

**Files:** investigation only — read `~/.claude/skills/sprint-helper/SKILL.md` and check Claude Code's docs/source.

- [ ] **Step 1: Inspect how subcommands work in Claude Code skills.**

  Two possibilities to verify:
  - Subdirectory: `~/.claude/skills/sprint-helper/<subname>/SKILL.md` invoked as `/sprint-helper:<subname>`.
  - Sibling skill: `~/.claude/skills/sprint-helper-<subname>/SKILL.md` invoked as `/sprint-helper-<subname>`.

  Try the subdirectory pattern first — it keeps related skills grouped and matches the `:` separator Moran asked for. If Claude Code doesn't pick it up on first try, fall back to sibling.

- [ ] **Step 2: Confirm by creating a test skill.**

  Create a throwaway `/sprint-helper:test` skill, restart, see if Claude Code surfaces it. Delete it once confirmed.

---

## Task 2: Write `/sprint-helper:resume-work` skill

**File:** Create `~/.claude/skills/sprint-helper/resume-work/SKILL.md` (or sibling per Task 1's result).

- [ ] **Step 1: Write the skill body.**

  Frontmatter:

  ```yaml
  ---
  name: sprint-helper:resume-work
  description: Re-anchor after a chat restart or compact — runs the full AFTER ORIENT ritual that the model often forgets when context shifts.
  disable-model-invocation: true
  ---
  ```

  Body tells the model:
  1. Call `mcp__sprint-helper__orient` immediately, regardless of whether you already did this turn.
  2. Echo the greeting using the API-shipped strings (greeting, capacitySummary, displayName).
  3. Run the cwd cross-check via `mcp__sprint-helper__story_match` with the chat's cwd + recent git subjects.
  4. If `orient.liveNow` has any item with `mayBeStale: true` → raise it before anything else (STALE LIVE SESSION rule).
  5. If `orient.liveNow` has any item whose `parentStoryId` ≠ `storyMatch.topMatch.workItemId` → raise the drift question (STORY DRIFT rule).
  6. Once the right story is confirmed, walk a short status read: state, children, effort. Don't dump everything — pick the 1-2 things he'd touch next.
  7. End with one sentence telling him what he's about to start.

  Style: plain English, paragraph form, names-before-numbers, no banned words. The skill body should re-state the rules concretely so even a freshly-resumed model has them in context.

- [ ] **Step 2: Manual smoke.**

  Save Moran's existing `~/sprint-helper/` archive output as a reference. Don't run the skill from inside the dev chat (the MCP subprocess is stale). The smoke is: Moran runs it in a fresh chat and confirms it walks the right ritual.

---

## Task 3: Write `/sprint-helper:end-work` skill

**File:** `~/.claude/skills/sprint-helper/end-work/SKILL.md`

- [ ] **Step 1: Write the skill body.**

  Frontmatter:

  ```yaml
  ---
  name: sprint-helper:end-work
  description: Walk Moran through wrapping up the current session — pause vs. done, burndown reconciliation, the close-the-loop ritual.
  disable-model-invocation: true
  ---
  ```

  Body tells the model:
  1. Check `mcp__sprint-helper__orient` to find the current open session. If none, say so and stop.
  2. Ask Moran plainly: "Is this task done, or are you just stopping for now?"
  3. Two branches:
     - **Just stopping** → call `mcp__sprint-helper__session_end` with a one-line summary and `done` omitted/false. Tracked time pauses. Before ending, check if RemainingWork on the task is honest; if it looks stale, propose an update and confirm before patching.
     - **Done** → propose the Completed number using the burndown formula (`CompletedWork = OriginalEstimate − new RemainingWork`). Confirm with Moran ("sound right?"). After he confirms, call `session_end` with `done=true`. NEVER set `done=true` without his nod.
  4. After the call, mention what happened in ADO in one sentence: "session closed, X hours pushed, task marked Closed" or "session paused, nothing pushed."

  Cross-references: [[feedback-effort-propose-burndown]], [[feedback-session-log-cadence]] (already documented in MEMORY.md).

- [ ] **Step 2: Smoke (Moran-side).** Open a session in his work chat, run the skill, confirm it walks the right branch for each case.

---

## Task 4: Write `/sprint-helper:status` skill

**File:** `~/.claude/skills/sprint-helper/status/SKILL.md`

- [ ] **Step 1: Write the skill body.**

  Frontmatter:

  ```yaml
  ---
  name: sprint-helper:status
  description: Read out today's situation — yesterday's work, today's work, current open sessions, any blockers — without opening the dashboard.
  disable-model-invocation: true
  ---
  ```

  Body tells the model:
  1. Call `mcp__sprint-helper__orient` if you haven't already this conversation. Use its `liveNow`, `lastSession`, helper-note count.
  2. Call `mcp__sprint-helper__sprint_snapshot` to get the full story+task breakdown. The standup data (yesterday + today) is in the dashboard payload under `standup` — pull it.
  3. Surface in one paragraph, friend-to-friend voice:
     - "Yesterday you were on <task displayName(s)> — <summary from session_log progress>."
     - "Today you've got <live session displayName> open" or "Nothing live yet today."
     - If `mayBeStale: true` on a live session → mention it.
     - If any current story has state `Blocked` → mention it by displayName.
  4. Don't paste the dashboard JSON. Don't bullet-list. Plain paragraph, short sentences.

  Cross-references: the [[Plain English output]] feedback rule. The standup data is what powers the Daily view's standup card (R9).

- [ ] **Step 2: Smoke.** Moran runs it in any chat (not specifically a work chat — `status` should work in any context), verify it reads aloud well.

---

## Task 5: Write `/sprint-helper:new-work` skill

**File:** `~/.claude/skills/sprint-helper/new-work/SKILL.md`

- [ ] **Step 1: Write the skill body.**

  Frontmatter:

  ```yaml
  ---
  name: sprint-helper:new-work
  description: Bootstrap a fresh task or story when starting work that isn't in the sprint yet. Walks the decompose → anchor → propose ritual.
  disable-model-invocation: true
  ---
  ```

  Body tells the model:
  1. Call `mcp__sprint-helper__orient` if not already this turn. Then `mcp__sprint-helper__story_match` with the cwd to see if there's a confident story match.
  2. Two branches:
     - **Match found** → propose by title: "Looks like you're picking up <topMatch.displayName>. Is this work part of that, or is it a new piece?"
     - **No match** → ask: "What's this work for? — a quick aside (an hour or two) or its own story?"
  3. On "quick aside" → call `mcp__sprint-helper__task_create` with `adHoc=true`, then `session_start`.
  4. On "own story" → run the decompose-anchor-propose ritual:
     - Ask Moran to describe the work briefly.
     - Decompose: propose 3–6 tasks the story breaks into. Ask him to confirm/edit.
     - Anchor: for each task, call `mcp__sprint-helper__estimate_anchor` against his recent history. Use the returned anchor (median ratio over real tasks) to propose hours.
     - Propose: "Story X with Y story points, Z hours total. Tasks: ..."
     - On his nod → `mcp__sprint-helper__story_create` then `mcp__sprint-helper__task_create` for each child. Then `session_start` on the first task.
  5. If cwd is fresh, save the cwd→story mapping via `mcp__sprint-helper__story_match_set` so the next chat in this directory remembers.

  Cross-references: [[feedback-effort-propose-burndown]], [[feedback-use-sprint-helper-strictly]] (never shell to az), [[feedback-self-identify-story]].

- [ ] **Step 2: Smoke.** Moran picks a fresh-feeling cwd, runs the skill, walks through both branches over a couple of chats.

---

## Task 6: Update memory + commit

**Files:**
- `~/.claude/projects/-Users-weissmmo-projects-github-moran-sprint-helper/memory/reference_sprint_helper_skill.md` (update with the new set)
- `~/.claude/projects/-Users-weissmmo-projects-github-moran-sprint-helper/memory/project_slice_backlog.md` (mark R11 ✅ with commit sha)
- `~/.claude/projects/-Users-weissmmo-projects-github-moran-sprint-helper/memory/project_build_state.md` (update latest-commit pointer)

- [ ] **Step 1: Update `reference_sprint_helper_skill.md`** to list all five skills (the existing one-shot `/sprint-helper` plus the four new sub-skills). Note the recovery-tool framing — these are belt-and-suspenders for when auto-triggers miss.

- [ ] **Step 2: Update slice backlog.** Add R11 ✅ entry below R10 with commit sha + the four skill names.

- [ ] **Step 3: Update build state's "Latest commit" line.**

- [ ] **Step 4: Commit.**

  Skills live in `~/.claude/skills/`, NOT in the sprint-helper repo. The commit in this repo is only for the plan file:

  ```bash
  git add docs/superpowers/plans/2026-06-03-r11-sprint-helper-skill-set.md
  git commit -m "R11 plan — /sprint-helper named skill set"
  ```

  Memory updates are saved directly to the memory dir (not committed to a repo — they live in `~/.claude/`).

---

## Self-review checklist

After writing all four skill bodies:

- **Voice:** Each skill body should read like a friend talking to Moran, not a status report. Short sentences, plain English, banned words avoided.
- **Names not IDs:** Every example uses `displayName` from the API or names-before-numbers in prose.
- **No agile jargon:** No "ceremony", no "standup" (in this skill set we renamed to `status`), no "retrospective" unless quoting a literal mode label.
- **No menus inside the skills.** Each skill is one-shot: it acts, asks at most one question (yes/no or pick by title), then proceeds.
- **Cross-references real memories.** Don't restate rules in full where a `[[memory-slug]]` reference will do.
- **Reads well on a fresh model.** Imagine a Claude Code instance that just started, has the orient context but nothing else — does the skill body tell it enough?
