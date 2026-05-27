# Chat

_Started 2026-05-27 11:07 UTC_

---

## User

<system-info comment="Only acknowledge these if relevant">
Project title is now "sprint-helper"
Project currently has 11 file(s)
User is viewing file: Sprint Helper.html
Current date is now May 27, 2026
</system-info>

<default aesthetic>
If no references, art direction or design systems were provided, use this default professional modern, minimal aesthetic as a base. Declare your choice out loud so you stick to it. Guidance:
- Choose a type pairing from web-safe set or Google Fonts. Helvetica is a good choice. Avoid hard-to-read or overly stylized fonts. Use 1-3 fonts only.
- Foreground and background: choose a color tone (warm, cool, neutral, something in-between). Use subtly-toned whites and blacks; avoid saturations above 0.02 for whites.
- Accents: choose 0-2 additional accent colors using oklch. All accents should share same chroma and lightness; vary hue.
- NEVER write out an SVG yourself that's more complicated than a square, circle, diamond, etc.
- For imagery, never hand-draw SVGs; use subtly-striped SVG placeholders instead with monospace explainers for what should be dropped there (e.g. “product shot”)

CRITICAL: ignore default aesthetic entirely if given other aesthetic instructions like reference images, design systems or guidance, or if there are files in the project already.
</default aesthetic>

<pasted_text name="Pasted text (120 lines)">
# Sprint Helper — slice 4a design brief

Paste this whole brief into a new chat at **claude.ai/design**. End your prompt with **"give me 2 variations"**.

---

## Context — what's already built

I have a sprint dashboard called **Sprint Helper** (single-user, personal tool, already in production for me). The existing dashboard is a "what am I working on now" surface: top bar with sprint picker, hero greeting + standup draft in the sidebar, stat tiles, "My user stories" chip grid, an Active Story focal card with per-task timers and inline editors (state/estimate/remaining), in-sprint task list, sync banner. Dark warm-dusk palette (`oklch(0.135 0.028 260)` bg), single moonlit-blue accent `oklch(0.78 0.075 245)`, Geist + Geist Mono. The look is calm, dense, ADHD-friendly — one focal point at a time, no pulsing, no rainbow.

## What I'm adding now — ceremony shell

The current dashboard is the **work view**. I need it to become the **Day mode** of a multi-mode workspace. Each mode focuses the dashboard on a specific sprint ceremony:

- **Day** (the current view, lightly polished)
- **Pre-plan** (placeholder for now — "coming soon")
- **Plan** (placeholder)
- **Demo** (placeholder)
- **Retro** (placeholder)

This brief asks you to design **three new pieces**:

1. **The mode switcher** — how you navigate between modes.
2. **A "next ceremony" tile** in Day mode — the small new thing that tells me what's coming up.
3. **A one-time ceremony schedule setup screen** — a modal where I type in when each ceremony happens (standup time, demo day, retro day, etc.). The system uses this to auto-suggest the right mode at the right time.

The other modes (Pre-plan/Plan/Demo/Retro) only need a placeholder treatment in this brief — they get their own designs later.

## Hard constraints (respect strictly)

- **Palette**: dark warm-dusk. Bg `oklch(0.135 0.028 260)`. Text `oklch(0.95 0.014 230)`. Accent `oklch(0.78 0.075 245)` (one accent, never two).
- **ADHD-friendly**: one focal point, no pulsing animations, no decorative motion. Subtle 180ms ease-out only.
- **Typography**: Geist (UI), Geist Mono (numbers/ids/clock).
- **No emoji icons.** Sparing unicode (`›`, `↗`, `↑`, `▶`, `⏸`, `✓`) or simple SVG.
- **Calm density.** Whitespace is intentional; nothing crammed.

## Bit 1 — Mode switcher

The dashboard's top bar today has, left to right: brand `SPRINT HELPER` + my username, then on the right `← 26_11 →` sprint picker, `DAY 4/10 LOCAL 14:32` info chip, refresh pill `↻ live`.

The mode switcher needs to live somewhere that:
- Is visible at all times (not hidden behind a menu).
- Doesn't compete with the sprint picker for attention.
- Makes it obvious which mode is active and what the others are.

Two structural directions to explore:

- **Variation A — Top-bar mode tabs**: a horizontal pill group below the brand line, before the content. Like `Day · Pre-plan · Plan · Demo · Retro`. Active mode is filled accent; inactive are dim text on hover-able transparent. Tabs span the full width or sit left-aligned.
- **Variation B — Left-rail mode column**: a slim vertical column on the far left (32-40px wide), with one tile per mode. Each tile shows a tiny icon + label, active one has accent left-border. Frees the top bar from clutter, makes "where am I" answerable at a glance.

Pick which feels more "this is my workspace" and show that. Include a hover state, an active state, and a "suggested mode" state. The **suggested** state is when the schedule says it's time for a different ceremony — that mode gets a soft one-shot shimmer (not infinite!) + a small dot indicator. Example: it's Friday 10:30 and Demo is at 11:00 — Demo tile gets the shimmer.

## Bit 2 — "Next ceremony" tile in Day mode

A small new tile in the sidebar (where the sprint day-rail lives currently). Shows:
- The next ceremony's name in caps small letterspaced (e.g. `NEXT · DAILY STANDUP`)
- Time in mono (e.g. `09:00 — in 23 min`)
- Sub-line dim (e.g. `Pre-planning Wed 14:00 · Demo Fri 11:00`) — a peek further ahead, optional

When the current time is within ~15 minutes of a ceremony, the tile gets a soft accent treatment (border-color, NOT pulsing background). Click → jumps to that mode.

## Bit 3 — Ceremony schedule setup modal

A one-time setup (and editable later via a small `gear` icon on the next-ceremony tile). Modal opens centered, dark scrim behind, ~520px wide, dismissable with `Esc` or the close `✕`. Title: `Ceremony schedule`. Subtitle: `When does each thing happen? You can edit this anytime.`

Body — a stack of rows, one per ceremony:

```
DAILY STANDUP        weekdays            at  [ 09:00 ]
SPRINT PRE-PLANNING  [ Wednesday ▾ ]    at  [ 14:00 ]   in week  [ 2 ▾ ]
SPRINT PLANNING      [ Monday ▾ ]       at  [ 09:00 ]   in week  [ 1 ▾ ]
SPRINT DEMO          [ Friday ▾ ]       at  [ 11:00 ]   in week  [ 2 ▾ ]
SPRINT RETROSPECTIVE [ Friday ▾ ]       at  [ 13:00 ]   in week  [ 2 ▾ ]
```

(My sprints are 2 weeks. "Week 1" = first week of the iteration, "Week 2" = second week.)

Right edge of each row: a small `disable` toggle (some teams don't do all ceremonies). When disabled, the row dims and the time inputs go disabled.

Footer of modal: `Cancel` ghost button on the left; `Save` accent button on the right. Plus a small note at the very bottom in dim small: `Outlook integration coming soon — once you connect Outlook, these times can auto-fill from your calendar.`

Visually it should feel like the same understated workspace, not like a settings form. Inputs are low-chrome (no big borders), the same `stepper`/`statepick` visual language we use elsewhere where possible. Time inputs are click-to-type with an inline mono value (e.g. `09:00`) — not a giant `<input type="time">`.

## Sample data to use in the mockup

```
User:     moran
Sprint:   26_11    Day 4/10    Local Wednesday 14:32

Schedule (already configured, shown in modal):
  Daily standup       weekdays · 09:00
  Sprint pre-planning Wednesday week 2 · 14:00
  Sprint planning     Monday week 1 · 09:00
  Sprint demo         Friday week 2 · 11:00
  Sprint retrospective Friday week 2 · 13:00

Current state:
  Active mode:       Day
  Suggested mode:    Pre-plan   (it's Wed 14:32, pre-planning is overdue)
  Next ceremony:     Sprint pre-planning — 14:00 today (started 32 min ago)
```

## Anti-patterns to avoid

- **A traditional left sidebar nav with many items.** This is a workspace, not an admin tool.
- **Big input boxes for time / day.** Inline, low-chrome, mono.
- **A pulsing or color-cycling "suggested" indicator.** One-shot shimmer on first appearance, then static.
- **Two accent colors.** Stay on moonlit blue.
- **Tabs that look like browser tabs.** Pill segments, not file folders.
- **Modal with form labels above each input.** Inline `LABEL value` rhythm only.

## Deliverable

Two variations of:
- The dashboard top region with the mode switcher visible + the Day mode being the active mode + Demo mode showing the **suggested** state (shimmer + dot).
- The new **next ceremony** tile in the sidebar.
- The **ceremony schedule modal** open, with the sample data above filled in.

Standalone HTML, single file with shared CSS. Reuse the existing dashboard's OKLCH palette and Geist fonts. When I'm happy, I'll Export → Handoff to Claude Code.

</pasted_text>


<system-reminder>Auto-injected reminder (ignore if not relevant): do not recreate copyrighted or branded UI unless the user's email domain matches that company. Create original designs instead.</system-reminder>

## Assistant

_[tool: list_files]_

_[tool: read_file]_

_[tool: read_file]_

_[tool: read_file]_

