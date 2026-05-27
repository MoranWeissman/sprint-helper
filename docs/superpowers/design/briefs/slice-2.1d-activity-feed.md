# Sprint Helper — slice 2.1d design brief (activity feed)

Paste this into the **same Claude Design chat** where you did slices 1.7 and 4a — it already knows the palette, fonts, components, layout, and the existing chip + task-row expand panels. End your message with **"give me 2 variations"**.

---

## Context — what's already built

The Day dashboard has: a left mode rail, a sidebar (greeting · sprint day · up-next tile · remaining-hours rail), and a main content area with the chip grid of stories. Each story chip expands to show description + STATE / ESTIMATE / REMAINING editors and a list of its child tasks. Each task row also expands the same way. Dark warm-dusk palette, single moonlit-blue accent, Geist + Geist Mono.

The MCP plugin now runs in the background. While I work in Claude Code, it reports back to sprint-helper every time it:
- Starts working on a task (`focus` event)
- Hits something blocking (`blocker`)
- Makes a tradeoff decision (`decision`)
- Summarizes a chunk of progress (`progress`)
- Logs a free-form note (`note`)

Each event is stamped with a timestamp and stored against the relevant task.

## What I'm adding now — activity feed

A way to **see what Claude Code is reporting** without leaving the Day dashboard. This should feel like a calm presence — not a chat log, not a console — surfacing inside the parts of the dashboard I already look at.

Two things to design:

1. **A "live" marker** that appears on a story chip and a task row when a Claude Code session is currently open against it.
2. **A "Recent activity" feed** that lives inside the existing chip + task-row expand panels.

Plus an empty state for tasks with no activity yet.

## Vocabulary (use this exact wording)

- Section title inside the expand panel: **"Recent activity"** (caps small letterspaced, like the other section titles).
- The live indicator label: **"live"** (lowercase mono, small).
- The five event types render with these plain English labels: **Focus**, **Progress**, **Blocker**, **Decision**, **Note**.
- Empty state copy: **"Nothing yet. Claude Code will log things here as you work."**
- Never say "session" in user-facing text. Internally it's a session; for me it's "live" + activity.

## Hard constraints (respect strictly)

- **Palette**: `oklch(0.135 0.028 260)` bg, `oklch(0.95 0.014 230)` text, single accent `oklch(0.78 0.075 245)`. No second accent.
- **ADHD-friendly**: one focal point, **no pulsing**, no decorative motion. Subtle 180ms ease-out only. The "live" dot is static.
- **Typography**: Geist (UI), Geist Mono (numbers/ids/clock/event timestamps).
- **No emoji**. Sparing unicode if needed.
- **Calm density** — generous whitespace. The feed should feel like a list of notes, not a feed of notifications.

## Event row anatomy

Each activity entry is a single row with three parts:

```
14:32   FOCUS       Started on auth refactor
14:45   BLOCKER     Token expiry edge case
15:12   DECISION    Use refresh tokens, not session cookies
15:30   PROGRESS    Refactored middleware, opened PR #42
15:48   NOTE        Need to circle back to error messages
```

- **Timestamp**: mono, dim (`--ink-3`). 5-char `HH:MM` format. If the event is from a previous day, render the date inline (`Tue 09:15`).
- **Type label**: caps small letterspaced, mono. Use a subtle color variation per type — **all within the same hue family, all desaturated**. Suggestion: Focus = accent dim, Progress = success-leaning (a calm sage), Blocker = warm (a muted rust, NOT bright red), Decision = neutral ink, Note = ink-3. Show the type as text only, no badge box. **No bright reds, no greens** — keep everything calm and ADHD-friendly.
- **Body**: normal text, single line preferred (truncate with `…`). If a long body must wrap, indent the wrap to align with the body column, not the timestamp.

Show 5 most recent events by default. If there are more, show a small dim caps button at the bottom: **"5 of 12"** → expands to show all (max ~20).

## Bit 1 — Live marker

When a Claude Code session is open against a task or story, mark it. Two design directions:

- **Variation A — Inline label**: a small `live` lowercase mono pill sits in the chip header (next to title) and the task row's right edge. Color: accent-toned background, ink text. ~9px font.
- **Variation B — Accent dot only**: a tiny static dot (no label) in the same spot. Hover/focus shows a tooltip with "Claude Code is working on this".

For both, also show how a story chip with a live child task looks (chip header gets a dimmer version of the marker, since the work is "in" but not "on" the chip itself).

## Bit 2 — Recent activity inside expand panels

The activity feed slots into the **existing** expand panel — the one with description + STATE / ESTIMATE / REMAINING. Place it **below** the editors row, separated by a thin divider. New section header: **"Recent activity"**.

Show the 5 most recent events in the row format above. The chip's expand panel rolls up across all child tasks (same data shape, just merged + sorted by time). The task row's expand panel shows only that task's events.

Empty state when there are no events: a single dim sentence, no icon, no big illustration:

> Nothing yet. Claude Code will log things here as you work.

## Bit 3 — Sidebar "live now" tile (optional, both variations)

Above or near the existing "Up next" tile, when at least one Claude Code session is open, show a small tile:

```
LIVE NOW · 2 SESSIONS
Auth refactor — 14 min
Branch protection — 4 min
```

Title is caps small letterspaced (existing `.dim-cap` style). Each line is a story/task title + elapsed time (mono). Click a line → jumps to that story (focuses the chip, expands the panel, scrolls if needed).

If only one session is open, the tile shows the title + elapsed time alone — no "1 session" pluralizer.

When no sessions are open, hide the tile entirely (don't leave an empty placeholder).

## Sample data to use in the mockup

```
User:      moran
Sprint:    26_11   Day 4/10   Wednesday 14:32

Story (chip):  "Discovery: Access & Guardrails"   live (1 child)
  Task #426267 "CODEOWNERS model"      — no activity yet
  Task #426268 "Branch protection rules"  LIVE  ← session open since 14:18

Activity on #426268 (newest first):
  14:32  Focus      Started on auth refactor
  14:45  Blocker    Token expiry edge case
  15:12  Decision   Use refresh tokens, not session cookies
  15:30  Progress   Refactored middleware, opened PR #42
  15:48  Note       Circle back to error messages
```

Use this exact data in the mockup, both for the story-level rolled-up view and the task-level view.

## Anti-patterns to avoid

- **Chat-bubble styling** for events. This is a workspace activity log, not a conversation.
- **Bright red blockers / bright green progress.** Stay within the muted palette.
- **Icon-only event types.** Labels carry the meaning; icons (if any) are secondary.
- **A separate "Activity" page or tab.** Activity lives inside Day mode, in the panels I already look at.
- **A pulsing or animated "live" marker.** Static dot or pill, no motion.
- **The word "session" anywhere user-facing.** Use "live" + "Recent activity".
- **Toasts / notifications.** No interruption — Moran will look when she wants to.

## Deliverable

Two variations of:
- A story chip with one live child task, with the chip's expand panel open showing rolled-up Recent activity.
- The same story's task row #426268 expanded, showing the task's Recent activity feed (same 5 events).
- An empty-state version of the panel (task #426267) for comparison.
- A "Live now" sidebar tile with 2 sessions.

Plus: one extra static frame showing what a story chip looks like when **no** child has a session — to confirm the live marker is absent and the layout is unchanged.

Standalone HTML, single file with shared CSS. Reuse the existing dashboard's OKLCH palette, Geist fonts, expand panel styling, and event-row mono treatment. When I'm happy, Export → Handoff to Claude Code.
