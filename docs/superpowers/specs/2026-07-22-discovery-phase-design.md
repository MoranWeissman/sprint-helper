# Discovery Phase — Design

**Date:** 2026-07-22
**Status:** Design approved, ready for implementation plan.

## What this is

A way for sprint-helper to run — and lightly enforce — a specific discovery method
on each ADO feature the user works on. The method is the user's real team process
(from his tech lead). sprint-helper's job is threefold: **steer** the AI to run
discovery the right way, **track** it so any chat can see its state, and **enforce**
the few rules that matter — in code, at the moments a tool is actually called.

This is the first phase of the larger "Discovery & Design" work. A later, separate
design covers the Design Review (DR) gate.

## The discovery method (what we are encoding)

- **Per feature, not per story.** A feature is created by a PM / tech lead; the user
  does the work under it, and discovery is the first piece of that work.
- **Time-boxed: 2 calendar days default, 3 max.** The 3rd day is a deliberate choice,
  never the default.
- **High level only.** Topics are one-liners, never blocks of detail. "Fast, but not
  fast-and-dirty" — every one-liner must be correct, just not deep.
- **Two things to surface:**
  - **Diffs** — where this feature makes the team work differently than today (only if
    a difference exists).
  - **Risks** — the cost or new-skill each diff brings (e.g. "double the ArgoCD apps →
    more SaaS cost"; "a section needs functions in language X → a new skill the team
    must learn").
- **Tag each item `fact` / `option` / `both`.** A fact is a given, not up for debate
  ("our CD is in GitHub, different from the Azure DevOps users know — but it's a
  fact"). An option is a real choice. Some items are a fact that spawns a choice —
  those are `both`. This is a tag on each item, **not** a forced either-or bucket.
- **No trade-off analysis, no picking sides.** That is the later Design phase's job and
  is explicitly out of scope here.
- **Produces an end-to-end flow** of the feature — the plain story of how it works,
  step by step.
- **The flow feeds a simple demo** for a focus group. The demo *simulates* the thing to
  make the point — nobody builds a real demo during discovery. The demo is **optional**
  per discovery and **never gates** anything; it gets scheduled while design and the
  platform-team talk run in parallel.

## Platform constraint (why enforcement lives where it does)

The MCP server can only enforce things **at the moment a tool is called** — session
start, story move, story close, a tool response. It **cannot** watch what the user
types in a chat. So every hard rule below is attached to a real tool call. The rest of
the steering is done by a seeded skill, which shapes what the AI produces during a
session. This split — code for the few hard gates, a skill for the shape and habit — is
the core design principle here.

## Architecture — the three parts

Built in dependency order. Each is usable on its own once the one before it exists.

### Part 1 — Discovery skill + source file + tracking

**The seeded discovery skill.** A skill copied into every workspace by the existing
scaffold path (`ensureWorkspaceScaffold` in `server/workspace.ts` already copies
`_bmad` + `.claude/skills` + `CLAUDE.md` + the hook from the seed folder into each
workspace). We add a discovery skill to the seed folder; it then ships to every feature
session for free. The skill teaches the AI to run discovery the method's way and to
fill the source file.

**The source-of-content file.** One structured file per feature, in that feature's
workspace subfolder. It is the single place the discovery content lives. It holds:

- `problem` — what we're solving, 2–3 lines, plain words.
- `flow` — the end-to-end flow, an ordered list of high-level steps.
- `groups` — context groups (the feature split into areas that make sense to a
  reviewer). Each group has a name and a list of items; each item is a one-liner tagged
  `diff` / `risk` / `fact` / `option` / `both`.
- `lanes` — one line each: ours vs the tech lead's (parked, not designed here).
- `demo` — status (`none` / `scheduled` / `built`), the chosen demo shape, a date.
- `openQuestions` — one-liners for the platform-team talk.

**The markdown render.** The source file renders to a markdown discovery doc — the
git-friendly record, and the thing the close-gate reads. No auto-HTML render of the doc
in this build (see "Out of scope").

**Tracking / read-from-any-session.** The source file plus a small stats record live in
the feature folder, reachable from any chat and any repo. Any session can answer: does
feature X have discovery? which day is it on? is a demo scheduled or built? This builds
on the existing active-feature pointer (`getActiveFeature` in `server/workspace.ts`).

### Part 2 — The demo step

Built right after Part 1 — it needs a real, finished discovery to read.

The flow: sprint-helper reads the finished discovery **in the context of its feature**,
then **describes 2–3 fitting demo ideas in plain words** (e.g. "an animated pipeline of
the deploy flow", "a before-and-after of the developer's screen", "a mock of the new
screen"). The user picks one. sprint-helper then **builds that one** as a self-contained
HTML demo in the dark showcase style, with a **mandatory "this is a simulation, nothing
here is real yet" banner**.

- **Describe in plain words, then build one.** sprint-helper does NOT render three full
  HTML demos to browse — it describes the options in words, the user picks, then it
  builds the single chosen one.
- **A few fixed shapes, not infinite freedom.** The demo-builder skill carries a small
  set of demo shapes (a flow, a before/after, a mock screen). The topic decides which
  shape fits; the shape gives the AI something to anchor quality to.
- **Two entry points.** The demo step can be kicked off from the **Discovery & Design
  section in the UI** (the user gets a prompt to open a session for it), or **from
  inside a session** (which updates the UI).
- **Optional, never a gate.** A discovery may finish with no demo at all.

### Part 3 — Dashboard demo viewer

The Discovery & Design section shows a built demo in a **sealed iframe** (so its flashy
style cannot leak into the calm dashboard) plus a **download** button. The list of built
demos comes from the feature folder.

## Enforcement — in code, in the right places

### Build-start = smart nudge (never a wall)

When the user starts build work on a feature that has no finished discovery,
sprint-helper **reminds** him and offers to start one — it does **not** block. This
handles the common case cleanly: the PM created the feature but no discovery story
exists on the board yet, so a hard block would fire on nearly every feature and train
reflex-overriding. The nudge informs without trapping.

### Story-close = the hard gate

The real teeth live here, reusing the existing `story_close` guard pattern
(`mcp/server.ts` — `story_close` already refuses to close a story with open child
tasks). We add: **a discovery story will not close until its source file has the
required parts filled** — the end-to-end flow, plus at least one full context group
(a group containing at least one `diff`, one `risk`, and at least one item tagged
`fact`, `option`, or `both`). Once the story is closed, **"story closed" is the single
truth** for "discovery finished." This obeys the standing rule that ADO owns status: we
do not keep a second, separate "is discovery done" flag that could drift from the board.

**Honest limit, stated plainly:** this check verifies the parts are *present*, not that
they are *correct*. "Fast but not dirty" means the content must be right, and only the
skill's steering (and the user reading it) can judge that. The close-gate is a
"did you at least fill these in" backstop, not a quality judge. We do not oversell it.

### Day cap = gentle, no nag-fatigue

The day count starts from the user's **first discovery session** on the feature (not
from story creation, since the story may be created days early), and **pauses when he
pauses**. On the Sun–Thursday workweek:

- Day 2: a gentle "aim to wrap today" nudge.
- Day 3: "this is the extra day — close it out."
- Over-run (past day 3): a flag that fires **once**, then goes quiet — not every
  session. Firing every session is the exact nag that makes the user mute all nudges.

### Story-exception

Discovering a whole **feature** is the easy default — one action, no friction.
Discovering a **single story** instead requires an explicit spoken confirm
("Just this one story, not the whole feature? That's the special case — yes?") and is
recorded as the exception, so a later look-back shows it was a deliberate one-off, not
the normal way.

## Data flow

```
feature (created by PM/tech lead on ADO)
   │
   ▼
discovery session (workspace feature folder)
   │  seeded discovery skill steers the shape
   ▼
source-of-content file  ──renders──▶  markdown discovery doc  (git record + close-gate reads this)
   │
   │  (optional)
   ▼
demo step: sprint-helper reads discovery → describes 2–3 demo ideas in words
   │  user picks one
   ▼
built demo HTML (self-contained, "simulation" banner)  ──shown in──▶  dashboard sealed iframe + download

enforcement touches:
  • build-start  → smart nudge (never blocks)
  • story-close  → hard gate (required parts filled)
  • per session  → day-count nudges (from first session, pause-aware, over-run once)
  • story-level  → spoken confirm + recorded exception
```

## Error handling

- **Source file missing / malformed.** Reads return a safe empty state (no discovery
  yet), never throw — same defensive pattern as the existing settings parsers in
  `server/workspace.ts`. A malformed file is treated as "discovery not started."
- **No discovery story on the board.** Build-start nudges; nothing blocks. Close-gate
  simply has nothing to guard.
- **Feature folder / workspace not found.** The reader returns "no discovery"; the nudge
  offers to start one.
- **Day count with no recorded first session.** Treated as "not started" — no nag until
  a first discovery session is recorded.

## Testing

Follows the existing Vitest approach: pure functions unit-tested; MCP handler glue
smoke-tested by the user after an MCP reload.

- **Source-file parse/render:** garbage → safe empty; a full file → correct markdown;
  round-trips fields.
- **Close-gate check:** a doc with the flow + one full context group passes; missing
  flow fails; a group missing diff/risk/tag fails; empty file fails.
- **Day-count:** counts Sun–Thu only; starts at first session not story creation;
  pauses across a gap; over-run flag computed once.
- **Read-from-any-session:** given a feature id, returns has-discovery / day / demo
  status from the folder regardless of cwd.
- **Story-exception:** feature-level path needs no confirm; story-level path is flagged
  as needing confirm and recorded.

## Out of scope (deliberately deferred)

- **DR (Design Review) gate** — a separate later design.
- **Poster / meeting-recap skills** — separate, later.
- **Auto-HTML render of the discovery doc** — a mechanical markdown→HTML render would
  look plainer than the hand-crafted reference pages and get abandoned; markdown-only
  until the user actually misses the HTML. (The *demo* is the crafted HTML artifact; the
  *doc* stays markdown.)

## Why this shape (design decisions)

- **Code for gates, skill for shape.** The seeded skill does ~90% of the work by
  steering. Code enforces only the few rules that fit sprint-helper's existing
  tool-call-moment pattern. This keeps a team-sized process light enough for an audience
  of one.
- **Teeth at close, not at build-start.** Build-start can't be a hard gate because the
  user does not control whether a discovery story exists — a block there misfires and
  trains reflex-overriding. Close is a real tool call the user makes deliberately, and
  it already has a guard pattern to extend.
- **One truth for "finished."** "Story closed" is the single source, matching ADO-owns-
  status; the required-parts check runs at the close moment rather than living as a
  second flag that could drift.
- **The demo is a first-class part, not a someday.** It is built second only because it
  depends on a real discovery existing to read — the same reason a foundation is poured
  before the walls.
