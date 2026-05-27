# Sprint Helper — slice 4a design brief

Paste this into the **same Claude Design chat** where you did slice 1.7 — it already knows the palette, fonts, components, and dashboard structure. End your message with **"give me 2 variations"**.

---

## Context — what's already built (we keep this look)

Sprint Helper is my personal sprint dashboard. The existing layout you've been designing has: top bar (brand · sprint picker · day/clock chip · refresh pill), left sidebar (greeting + standup draft + sprint day rail + remaining hours), main content (stat tiles · "My user stories" chip grid with chevron expand · Active Story card with per-task timers + inline editors · in-sprint task list · sync banner). Dark warm-dusk palette, single moonlit-blue accent, Geist + Geist Mono, calm density. Keep this whole look.

## What I'm adding now — modes

The current dashboard is the **Day** view. I want a way to switch the dashboard's focus to the other things I do in a sprint:

- **Day** — what I'm working on right now (the current view, lightly polished)
- **Pre-plan** — placeholder for now ("coming soon")
- **Plan** — placeholder
- **Demo** — placeholder
- **Retro** — placeholder

Only Day is real in this slice. The others will land later, one per slice. Today's design covers:

1. **A mode switcher** — how I navigate between the five modes.
2. **An "Up next" tile** — a small new thing in Day mode that tells me what's coming.
3. **A "Schedule" setup modal** — a one-time setup where I type in when each thing happens. The dashboard uses this to highlight the right mode at the right time.

## Vocabulary (please use this exact wording in the UI)

- The five modes are named: **Day**, **Pre-plan**, **Plan**, **Demo**, **Retro**. No prefixes ("Sprint demo"), no formal terms ("retrospective"), no "ceremony" anywhere.
- The recurring things on the schedule are: **Daily**, **Pre-planning**, **Planning**, **Demo**, **Retro**.
- The tile in Day mode is titled "**Up next**".
- The modal is titled "**Schedule**" (subtitle: "When does each thing happen? You can edit this anytime.").
- "Switch to X?" for the suggested-mode signal — not "suggested mode".

## Hard constraints (respect strictly)

- **Palette**: `oklch(0.135 0.028 260)` bg, `oklch(0.95 0.014 230)` text, single accent `oklch(0.78 0.075 245)`. No second accent.
- **ADHD-friendly**: one focal point, no pulsing, no decorative motion. Subtle 180ms ease-out only.
- **Typography**: Geist (UI), Geist Mono (numbers/ids/clock/time).
- **No emoji**. Sparing unicode (`›`, `↗`, `↑`, `▶`, `⏸`, `✓`).
- **Calm density** — generous whitespace.

## Bit 1 — Mode switcher

Two structural directions:

- **Variation A — Top-bar pill row**: a horizontal pill group sitting below the existing top bar, just above the content. `Day · Pre-plan · Plan · Demo · Retro`. Active pill = filled accent + dark text. Inactive = transparent, dim text, hover-able. Left-aligned, not full-width.
- **Variation B — Left-rail column**: a slim vertical column on the far left (~36-44px wide) with one tile per mode. Tile shows a tiny SVG icon + label below it. Active = accent left-border + brighter text. Frees the top bar.

For each variation, also show:
- **Hover** state on an inactive mode
- **Active** state (the current mode)
- **"Switch to X?" state** — when the schedule says it's time for a different mode. Use a soft, one-shot 600ms shimmer on that mode the first time it appears, plus a tiny accent dot next to its label that stays put (no pulse). Example to mock: the user is in Day, but it's Friday 10:50 and Demo is at 11:00 → Demo pill has the dot.

## Bit 2 — "Up next" tile

A small tile in the sidebar (place it near the existing sprint day rail — above, below, or replacing — your call). Shows:

```
UP NEXT · DAILY
09:00 — in 23 min
```

Plus a dim small sub-line peeking further ahead:
```
Pre-planning Wed 14:00 · Demo Fri 11:00
```

The `UP NEXT · DAILY` is the existing caps small letterspaced style. The time is mono. When the current time is within ~15 minutes of the start, the tile gets a soft accent treatment — border-color change, not background pulse. Click the tile → jumps to that mode.

If no thing is in the lookahead window (rare — at the very end of a sprint maybe), show a calm empty state: "Nothing scheduled in the next two weeks."

## Bit 3 — Schedule modal

Opens centered on a dark scrim, ~520px wide, dismissable with `Esc` or `✕`. Title: **Schedule**. Subtitle: **When does each thing happen? You can edit this anytime.**

Body — five rows, one per thing:

```
DAILY              weekdays                          at  [ 09:00 ]       [ ☑ on ]

PRE-PLANNING       [ Wednesday ▾ ]  week  [ 2 ▾ ]    at  [ 14:00 ]       [ ☑ on ]

PLANNING           [ Monday ▾ ]     week  [ 1 ▾ ]    at  [ 09:00 ]       [ ☑ on ]

DEMO               [ Friday ▾ ]     week  [ 2 ▾ ]    at  [ 11:00 ]       [ ☑ on ]

RETRO              [ Friday ▾ ]     week  [ 2 ▾ ]    at  [ 13:00 ]       [ ☑ on ]
```

(My sprints are 2 weeks. "Week 1" = first week of the iteration, "Week 2" = second.)

- Row labels are caps small letterspaced (the existing `.dim-cap` style), but the words themselves are plain (Daily, Pre-planning…).
- Pickers (day + week) are low-chrome inline dropdowns — same visual feel as the existing `Stepper` and `StatePicker`, not big form controls.
- Time is click-to-type with an inline mono value (e.g. `09:00`) — no giant `<input type="time">`.
- Right edge: an on/off toggle. When off, the row dims and the inputs grey out (some teams don't do all five things — for example, no Pre-planning).

Footer:
- Left: `Cancel` ghost button.
- Right: `Save` accent button.
- Below, dim small: **"Outlook integration coming soon — once you connect Outlook, these times can auto-fill from your calendar."**

Visually the modal should feel like part of the dashboard — same understated workspace tone, not like a settings form. Inputs are low-chrome; the inline editor language we landed on for slice 1.7 (the stepper / state pill) is the reference.

## Sample data to use in the mockup

```
User:      moran
Sprint:    26_11   Day 4/10   Local Wednesday 14:32

Schedule (configured, shown in the modal):
  Daily        weekdays · 09:00
  Pre-planning Wednesday week 2 · 14:00
  Planning     Monday week 1 · 09:00
  Demo         Friday week 2 · 11:00
  Retro        Friday week 2 · 13:00

Current state:
  Active mode:    Day
  "Switch to X?": Pre-plan (it's Wed 14:32 and pre-planning started 32 min ago)
  Up next tile:   Pre-planning — 14:00 today (32 min ago)
                  Demo Fri 11:00 · Retro Fri 13:00
```

## Anti-patterns to avoid

- **A traditional left sidebar nav with many items.** This is a workspace, not an admin tool.
- **Big input boxes for time / day.** Inline, low-chrome, mono.
- **Pulsing or color-cycling "switch to X?" indicator.** One-shot shimmer + a static dot.
- **Two accent colors.** Stay on moonlit blue.
- **Tabs that look like browser tabs.** Pill segments, not file folders.
- **Form-y modal with stacked label-above-input fields.** Inline `LABEL value` rhythm only.
- **Any use of "ceremony", "standup", "retrospective", or "sprint X".** Use Daily / Pre-planning / Planning / Demo / Retro.

## Deliverable

Two variations of:
- The dashboard top region with the mode switcher visible · Day is active · Pre-plan shows the "switch to X?" treatment (dot + shimmer).
- The new **Up next** tile in the sidebar.
- The **Schedule** modal open, with the sample data filled in.

Standalone HTML, single file with shared CSS. Reuse the existing dashboard's OKLCH palette and Geist fonts. When I'm happy, Export → Handoff to Claude Code.
