# Sprint Helper — slice 1.7 design brief

Paste this whole brief into a new chat at **claude.ai/design**. At the end, ask for **"2 variations"** so you can pick a direction.

---

## What I'm designing

I have a sprint dashboard called **Sprint Helper** — already built. Right now, tasks and user stories on the dashboard are read-only: click one and a side **drawer** opens with full details (description, comments). To edit anything, I have to leave the app and open Azure DevOps.

I want to add **two new patterns** to the existing dashboard, side-by-side:

1. **Expand-in-place rows** — each task and each user-story chip gets a small chevron. Click it and a compact details strip slides open below the row, right inside the dashboard. The strip shows parent context, a short description preview, child counts, and **editable fields** (see below). Click the chevron again to collapse. The side drawer stays exactly as it is for the deep dive (full HTML description + comments) — the expand strip is for *quick peeks and quick edits*.

2. **Inline editors** for two field families:
   - **State** — change a task between *waiting*, *going*, *done*. Visual: a 3-segment pill picker (current state highlighted in accent; others muted; one click = transition).
   - **Effort hours** — edit *estimate* and *remaining* directly. Visual: small number with two tiny `−` / `+` stepper buttons next to it, plus the number itself is click-to-type. Increments by 0.5 hours.

These edits push to Azure DevOps as soon as you click away from the field (no Save button).

## Vibe + hard constraints (please respect strictly)

- **Dark, warm dusk** palette. Background `oklch(0.135 0.028 260)` (deep midnight blue). Text `oklch(0.95 0.014 230)`.
- **One accent only** — moonlit blue `oklch(0.78 0.075 245)`. Use for the *one* primary focus signal at a time. Never two accents fighting.
- **No pulsing, no rainbow, no celebratory color bursts.** I have ADHD; bouncing UI breaks me.
- **One focal point per screen** — the "active story" card is the focal. Everything else is supporting.
- **Generous whitespace.** Calm rhythm.
- **Typography:** Geist (UI), Geist Mono (numbers/ids). Numeric stats and ids ALWAYS in mono; tabular figures.
- **No emoji icons.** Use unicode arrows and chevrons (`↗ ↑ ▶ ⏸ ✓ › ⌄`) sparingly, or simple SVG.
- **Subtle motion only** — chevron rotates on expand, panel reveals with a quick height + opacity ease (~180ms ease-out). No bouncy springs.

## What already exists (don't redesign, just integrate)

The existing dashboard has, top to bottom:
- Top bar: `SPRINT HELPER` brand, sprint picker (← `26_11` →), day chip, local clock chip, refresh pill with "live" indicator.
- Left sidebar: long date, greeting + name, sub-copy, big FOCUS button linking to the active story, sprint rail (S M T W T F days with current highlighted), "remaining hours" big number.
- Main content: 6-block stat grid (LOGGED, REMAINING, ESTIMATE, DAYS, GOING, NEXT), then a **My user stories** chip grid (one chip per parent story — clickable to focus), then the **Active Story** focal card (this is where most editing happens), then a "Standup draft" card + "In this sprint" list, then a sync banner.
- Right side: a side drawer slides in for full work-item details (description as sanitized HTML, comments, parent/children/related links). Closes with Esc or click-out.

**Just design the new bits — don't redo the whole dashboard.** Specifically I need:

### Bit A — Task row in the Active Story card

Today, each task row is a single line:
```
#12345   Wire ADO PATCH effort       1h 23m / 4h     ▶ start  ✓ done    GOING
```

New version, when **collapsed** (default): same one-line row, but add a `›` chevron on the right. When **expanded**: the row stays, and a soft panel slides down below it inside the same card. Show in the expanded panel:
- Parent user-story tag (`User Story · #12340 · OAuth login flow`)
- Description preview (first ~3 lines, plain text)
- **State pill picker** (segmented): `waiting · going · done` (one accent-highlighted)
- **Estimate** editor: `estimate  4h` with `−` `+` steppers (0.5h increments)
- **Remaining** editor: `remaining  2.5h` with `−` `+` steppers
- A small note: "edits push to Azure DevOps when you click away"
- A tiny ghost link at the bottom: `see full description and comments →` (opens the existing drawer)

Multiple tasks can be expanded at the same time. Collapsing one shouldn't collapse others.

### Bit B — Story chip in the "My user stories" grid

Today, each chip is a small card with type/id, title, and counts pills. Add a chevron in the corner. When expanded (inline below the chip grid, NOT in a popover), show a compact panel for the story:
- Story metadata (state, area)
- Description preview
- Same **state pill picker** and **effort editors** as tasks
- Counts of child tasks
- "open story details →" ghost link

Only one story can be expanded at a time from the chip grid (since they're side-by-side chips; expanding multiple would mess the layout).

### Bit C — Editor visual language (very important)

The editors need to feel **calm and tactile**, not form-y. No big borders, no obvious "input field" boxes. Think: numbers and pills that gently afford editing on hover.

- **Estimate / Remaining stepper**:
  - Label (caps, dim small): `ESTIMATE`
  - Value (mono, bold-ish): `4h`
  - `−` and `+` buttons: 22×22, transparent until hovered, soft accent border on hover.
  - Click on the value → becomes a tiny inline text input, accepts `2.5`, `1.25`, etc., commits on blur/Enter.

- **State pill picker**:
  - Three pills in a row: `waiting` `going` `done`
  - Current state: filled accent background, ink-0 text.
  - Others: transparent, dim text, accent on hover.
  - Click a non-current pill → transitions.
  - During the in-flight PATCH: brief shimmer on the *target* pill, not on the whole picker.

- All these should look at home next to the existing timer controls (`▶ start ⏸ pause ✓ done`).

## Sample data to use in the mock

```
Sprint:           26_11    Day 4/10    Local 14:32
User:             moran

Active Story:     #426267  CODEOWNERS model — automate routing
                  In progress · 3 tasks assigned to you
                  logged 2h 15m   estimate 6h   remaining 3h 45m

Tasks (in the active story card):
  #426268  Wire ADO PATCH effort           1h 23m / 4h     GOING    ›
  #426269  Test against staging org        0h     / 2h     WAITING  ›
  #426270  Update CODEOWNERS docs          0h 52m / 1h 30m WAITING  ›

Story chips (above the active card):
  [User Story #426267  CODEOWNERS model    3 going · 0 waiting · 0 done   3h 45m left   ›]
  [User Story #426280  Outlook integration 0 going · 4 waiting · 0 done   12h left      ›]
  [Bug        #426301  Sprint picker flicker 0 going · 1 waiting · 0 done  1h left       ›]
```

## Anti-patterns to avoid

- **Modal dialogs for editing.** Everything edits in place.
- **Save / Cancel buttons.** Commit on blur or pill click.
- **Stacked tabs inside the expand panel.** It should be one flat strip of fields.
- **A second accent color.** Stay on the existing moonlit blue.
- **Bouncy / spring animations.** Quick 180ms ease-out only.
- **Putting the description editor in here.** Description editing is a separate, later phase — show description as read-only preview text only.
- **A "draft / pending" status visible per field.** No "*" markers. If a PATCH fails, that's a row-level error (we'll handle it inline elsewhere — assume success in the mock).

## Deliverable

Two variations of:
- The Active Story card with **one task collapsed** and **one task expanded**, showing all editor affordances.
- Below it, a "My user stories" chip grid with one chip expanded.

Standalone HTML, single file. Same OKLCH palette, Geist fonts, current ember layout grid. When I'm happy, I'll Export → Handoff to Claude Code.
