# Handoff: Sprint Helper — Slice 4a (Ceremony Shell)

## Overview

Adds mode-switching to the existing Sprint Helper dashboard. The current single-view dashboard becomes the **Day** mode of a five-mode workspace, with placeholders for the other four modes coming in later slices.

This slice ships three new pieces:
1. **Mode rail** — a slim vertical column on the far left with one tile per mode
2. **Up next tile** — a small tile in the sidebar showing the next/current scheduled event
3. **Schedule modal** — a one-time setup (re-openable) for when each recurring thing happens

The rail, the tile, and the modal all read from a single `schedule` data structure. The dashboard uses the schedule to highlight the right mode at the right time ("Switch to Pre-plan?" state on the rail).

## About the Design Files

The files in this bundle are **design references created in HTML** — high-fidelity prototypes showing the intended look, copy, spacing, and interactions. They are **not production code to copy directly**.

Your task is to **recreate these designs in the Sprint Helper codebase** (React + the existing OKLCH/Geist token system already established in `dashboard.css`). Reuse the design tokens, font stack, and visual vocabulary that's already there — these new pieces should feel like the same workspace, not a separate UI.

If you're starting fresh in a different framework, pick what fits the project and port the tokens.

## Fidelity

**High-fidelity.** Colors, typography, spacing, copy, and motion are all final. Match pixel-perfectly using the existing dashboard's tokens and patterns.

## Vocabulary (use this exact wording)

The brief drew a deliberate line here — **don't conflate these**:

| Concept | Term | Where it appears |
|---|---|---|
| The five workspace modes | **Day**, **Pre-plan**, **Plan**, **Demo**, **Retro** | Rail labels, mode state |
| The recurring scheduled things | **Daily**, **Pre-planning**, **Planning**, **Demo**, **Retro** | Modal rows, Up next tile |
| The suggested-mode signal | **"Switch to X?"** | Rail dot + shimmer; copy when shown |
| The sidebar tile | **Up next** | Tile flag is `UP NEXT · <THING>` |
| The modal | **Schedule** | Title; subtitle: "When does each thing happen? You can edit this anytime." |

**Never** use: `ceremony`, `standup`, `retrospective`, or `sprint <thing>` (e.g. "Sprint demo"). The vocabulary is intentional — Day is the mode you live in, Daily is one event that happens during it.

## Screens / Views

### 1. Mode rail (left column)

**Purpose:** Persistent navigation between the five modes. Always visible. Doesn't compete with the sprint picker for attention.

**Layout:**
- Vertical column, **64px wide**, full-height of the body region (sits between the top bar and the bottom of the content).
- Background: `oklch(0.118 0.024 260)` (slightly darker than the dashboard's `bg-0` to recede)
- Right border: `1px solid var(--line-soft)`
- Padding: `22px 8px 16px`
- Flex column, `gap: 6px`

**Children, top to bottom:**
1. Small vertical cap text "MODE" — `oklch(0.38 0.025 248)` (`ink-4`), letterspaced `0.18em`, uppercase, weight 600, 9px, written rotated 180° with `writing-mode: vertical-rl`. Centered.
2. Five mode tiles (Day, Pre-plan, Plan, Demo, Retro)
3. Thin separator (`height: 1px; background: var(--line-hair); margin: 8px 8px`)
4. A "Schedule" gear tile pinned to the bottom (uses `margin-top: auto` on the tile *above* the gear so the gear sits at the bottom of the rail — see the implementation; really it's `margin-top: auto` on `.s4a-rail-gear` itself)

**Mode tile (`.s4a-rail-tile`):**
- `flex-direction: column`, gap 6px, items centered
- Padding: `10px 4px 10px`
- Border-radius: 6px
- Border: 1px transparent (becomes `var(--line-soft)` when active)
- Content: 18×18 SVG glyph + tiny label below (9px, uppercase, 0.10em letterspaced, weight 500, line-height 1)
- **Rest:** color `var(--ink-3)`, transparent bg
- **Hover:** color `var(--ink-1)`, bg `oklch(0.18 0.030 258 / 0.6)`
- **Active:**
  - Color `var(--ink-0)`
  - Bg: `linear-gradient(180deg, oklch(0.225 0.040 256), oklch(0.180 0.030 258))`
  - Border: `var(--line-soft)`
  - Plus a 2px accent left-marker absolutely positioned at `left: -8px, top: 12px, bottom: 12px` (`background: var(--accent)`, `border-radius: 2px`)
- **"Switch to X?" state** (suggested):
  - Color `var(--accent)`
  - Bg: `var(--accent-soft)` (= `oklch(0.78 0.075 245 / 0.18)`)
  - Border: `var(--accent-hair)` (= `oklch(0.78 0.075 245 / 0.30)`)
  - 6px round accent dot positioned top-right corner (with a 2px ring of bg color so it punches out)
  - **One-shot 600ms shimmer** on first appearance, then static. Implemented as a vertical gradient sweep (see CSS `@keyframes s4a-shimmer-v`) with `animation: ... 1 forwards` and `pointer-events: none`. After ~700ms the React component removes the `shimmer-on` class so it's truly inert.

**SVG glyphs** (18×18, stroke `currentColor`, `stroke-width: 1.4`, `stroke-linecap: round`):
- **Day** — sun (circle radius 3.5 at 9,11 + 4 short rays around)
- **Pre-plan** — dashed circle r=5.4 at 9,9 (`strokeDasharray="2 2.2"`) with a clock-hand path inside (`M9 6.3 v3 h2.6`)
- **Plan** — rounded square (rx 1.2) at 3.4,3.4 size 11.2 with three horizontal lines inside (the bottom one shorter)
- **Demo** — solid play triangle: `M7 5.8 v6.4 l5.4 -3.2 z` with `stroke-linejoin: round`
- **Retro** — three-quarter arc + arrowhead: `M14.4 9 a5.4 5.4 0 1 1 -1.9 -4.1` + `M14.5 3.8 v3 h-3`
- **Gear** — small gear: circle r=2.2 at 9,9 + eight short spokes

All glyphs are defined inline in `slice-4a.jsx` (the `Glyph` object).

---

### 2. Up next tile

**Purpose:** Tells the user what's coming next (or what's overdue) without leaving Day mode. Click to jump to that mode.

**Where:** In the sidebar (the existing left column of the Ember dashboard), as a sibling of the greeting block. Not inside the sprint day rail — adjacent to it, above or below depending on flow.

**Layout:**
- Background: `oklch(0.165 0.028 258)`
- Border: 1px `var(--line-soft)`, radius 8px
- Padding: `18px 20px 16px`
- Flex column, gap 10px
- Full button (whole tile is clickable; only the gear in the top-right stops propagation)

**Content (4 stacked elements):**

1. **Head row** (`flex; justify-content: space-between`):
   - **Left:** 5px round dot + flag text `UP NEXT · <THING>` (uppercase, 0.16em letterspaced, weight 500, 10px). Dot color: `var(--ink-3)` normally, `var(--accent)` when imminent.
   - **Right:** 13×13 gear icon button to open the Schedule modal. Stops click propagation.
2. **Name** (h4): plain-case thing name, e.g. `Pre-planning`. 18px, weight 500, letter-spacing −0.012em, `var(--ink-0)`.
3. **When row** (`flex; align-items: baseline; gap: 12px`):
   - **Time**: mono, 18px, weight 500, `var(--ink-0)`. Accent color (`var(--accent)`) when imminent.
   - **Relative**: sans, 12px, `var(--ink-2)`. E.g. "in 23 min" / "started 32 min ago".
4. **Peek line** (sub-line further ahead):
   - Top border: 1px `var(--line-hair)`, padding-top 10px
   - 11px, `var(--ink-3)`, 0.02em letterspaced
   - Example: `<Demo> Fri <11:00>  ·  <Retro> Fri <13:00>` where `<>` content is `var(--ink-2)` and times are mono

**"Imminent" treatment** (within ~15 min of start OR overdue):
- Replace flat bg with `linear-gradient(180deg, oklch(0.20 0.034 256), oklch(0.165 0.028 258))`
- Border-color → `var(--accent-hair)`
- Add a 2px accent left-rail (`::before`, absolutely positioned, `top: 12px, bottom: 12px, left: 0`)
- Flag dot & time switch to accent color
- **No background pulse, no infinite animation.** Static-only treatment.

**Empty state** (rare — nothing scheduled in lookahead window):
> "Nothing scheduled in the next two weeks."
in `var(--ink-3)`, normal weight. Tile keeps the same chrome but no flag/time/peek.

---

### 3. Schedule modal

**Purpose:** One-time setup (re-openable) for when each recurring thing happens. The schedule data drives the rail's "Switch to X?" state and the Up next tile.

**Trigger:** Schedule gear at the bottom of the mode rail, OR the gear in the Up next tile's head row.

**Layout:**
- Centered modal on a dark scrim
  - Scrim: `oklch(0.08 0.020 260 / 0.55)` + `backdrop-filter: blur(2px)`
- Modal width: `min(560px, 100%)`
- Border: 1px `var(--line)`, radius 12px
- Background: `linear-gradient(180deg, oklch(0.195 0.032 256), oklch(0.155 0.028 258))`
- Shadow: `0 30px 80px -20px oklch(0.04 0.04 260 / 0.7), 0 0 0 1px oklch(0.36 0.030 252 / 0.2)`
- Three sections: head, body (scrollable), foot
- Dismissable with `Esc`, the `✕` button, or clicking the scrim outside the modal

**Head:**
- Padding: `22px 26px 16px`, border-bottom 1px `var(--line-soft)`
- Title (h2): **Schedule** — 20px, weight 500, ls −0.012em, `var(--ink-0)`
- Subtitle (p): "When does each thing happen? You can edit this anytime." — 13px, `var(--ink-3)`
- Close button (right): 28×28, transparent, becomes bordered on hover; ✕ glyph in mono, 16px

**Body — five rows:**

Each row is a `grid` of three columns: `168px minmax(0,1fr) auto`. Padding `14px 0`, bottom border 1px `var(--line-hair)` except last.

| Column | Content |
|---|---|
| 1: Name | UPPERCASE name (`DAILY`, `PRE-PLANNING`, `PLANNING`, `DEMO`, `RETRO`). 11px, weight 500, 0.14em letterspaced, `var(--ink-2)` |
| 2: Fields | Inline flex row, gap 8px, wrap-able. See sub-pattern below |
| 3: Toggle | The on/off switch — see toggle pattern |

**Field layout for `weekdays` (Daily only):**
- Static label "weekdays" (12px, `var(--ink-2)`, padding 4px 0)
- Plain text label "at" (11px, `var(--ink-3)`)
- Time input

**Field layout for `per-sprint` (everything else):**
- Day pill (`Wednesday ▾` etc.) — see PillSelect
- Plain text label "week" (11px, `var(--ink-3)`)
- Week pill (`1 ▾` / `2 ▾`)
- Plain text label "at"
- Time input

So the order on every per-sprint row is: **day · week N · at HH:MM**. Week comes BEFORE time.

**PillSelect** (`.s4a-pill`):
- `appearance: none`, button, bg `oklch(0.155 0.028 258)`, border 1px `var(--line-soft)`
- Padding `5px 10px 5px 12px`, radius 5px
- 12.5px font, `var(--ink-0)`
- Right side: chevron `▾` in mono, 10px, `var(--ink-3)`
- Hover: border-color `var(--accent-hair)`, bg `oklch(0.175 0.030 258)`
- Focus-visible: border-color `var(--accent)`
- For the mockup, the pill is a static visual — no popover implemented. **You will implement an actual dropdown menu** (small floating list anchored to the pill, same border + bg as the modal, options at 13px, hover bg `oklch(0.20 0.030 256)`).

**TimeInput** (`.s4a-time`):
- Click-to-edit. Renders as a `<button>` in display mode and an `<input>` in edit mode.
- Display: mono, 13px, `var(--ink-0)`, bg `oklch(0.155 0.028 258)`, border 1px `var(--line-soft)`, padding `5px 12px`, radius 5px, min-width 64px, center-aligned.
- Edit: same look but with the `<input>` accepting `HH:MM`. Commits on `Enter` or blur if matching `/^\d{1,2}:\d{2}$/`. `Escape` reverts.
- Hover: border-color `var(--accent-hair)`
- Focus (edit mode): outline none, border-color `var(--accent)`, bg `oklch(0.180 0.030 258)`

**Toggle** (`.s4a-toggle`):
- 30×18px pill button, radius 999px
- Off: bg `oklch(0.275 0.030 254)`, knob `var(--ink-2)`
- On: bg `var(--accent)`, knob `oklch(0.16 0.04 260)` (dark)
- Knob: 14×14 round, transition `left 0.18s ease, background 0.18s ease`
- When **off**, the *whole row* dims (`opacity: 0.4`) and the fields go `pointer-events: none`. Just the toggle stays interactive so the user can re-enable.

**Foot:**
- Padding `16px 26px 18px`, top border 1px `var(--line-soft)`
- Flex row, `justify-content: space-between`, gap 16px
- **Left:** dim small note that wraps:
  > "Outlook integration coming soon — once you connect Outlook, these times can auto-fill from your calendar."
  11px, `var(--ink-4)`, 0.02em letterspaced, line-height 1.45
- **Right** (actions group, gap 10px):
  - `Cancel` ghost button — transparent, `var(--ink-2)`, hover bg `oklch(0.18 0.030 258 / 0.6)`, 13px
  - `Save` accent button — bg `var(--accent)`, color `oklch(0.16 0.04 260)`, 13px weight 600, padding `10px 18px`, radius 5px, with the same inset highlight + drop shadow as the existing dashboard's `.ember-report` button

---

## Interactions & Behavior

### Mode rail
- Click any tile → activate that mode. (Day is real in this slice; the other four show a "coming soon" placeholder.)
- Hover an inactive tile → color + bg lift (180ms ease-out)
- "Switch to X?" appears when the schedule says it's time for a different mode (within ~5 min of start, or overdue by < 60 min). Logic:
  - For each enabled schedule entry: compute the next occurrence in local time
  - If `now >= (occurrence - 5min) && now <= (occurrence + 60min)` and the mode it belongs to isn't the currently active mode → mark that mode as `suggested`
  - At most one suggestion at a time. If two qualify, the one with the more recent start wins.
- On first render where a `suggested` mode appears, play the 600ms shimmer **once**, then remove the shimmer class so the tile is static. Use a CSS animation with `1 forwards` + an effect that strips the class after `~700ms`.
- The accent dot in the corner stays put as long as the suggested state is active. **It does not pulse.**

### Up next tile
- Click anywhere except the gear → activate the corresponding mode
- Click the gear → open the Schedule modal
- Imminent treatment toggles when `|now - start| <= 15min` OR the start is in the past by < 60min
- The "started 32 min ago" / "in 23 min" string updates live (re-render every minute is fine; sub-minute precision isn't needed)

### Schedule modal
- Open via either gear button. Trap focus inside (recommend `focus-trap-react` or hand-rolled with a sentinel)
- Close: `Esc`, `✕` click, or click outside the modal panel (scrim click)
- Each row's day/week pills open a small floating menu (you'll implement this — see PillSelect notes)
- Time inputs: click-to-edit; `Enter` commits, `Esc` reverts
- Disable toggle dims the whole row's fields immediately
- `Cancel` discards changes and closes
- `Save` persists the schedule and closes. The rail and tile re-derive from the new schedule on next render.

### Motion
- All transitions: `180ms ease-out` (consistency with the rest of the dashboard)
- Toggle knob: `180ms` on `left` and `background`
- Modal open: don't add an entrance animation in this slice — the existing dashboard has no modal pattern yet, keep it simple
- "Switch to X?" shimmer: **600ms one-shot, then static.** Never repeats.

---

## State Management

```ts
// Schedule (persists locally; later: synced to backend)
type ScheduleEntry = {
  id: 'daily' | 'preplan' | 'plan' | 'demo' | 'retro';
  name: 'Daily' | 'Pre-planning' | 'Planning' | 'Demo' | 'Retro';
  cadence: 'weekdays' | 'per-sprint';
  day: 'Monday' | 'Tuesday' | 'Wednesday' | 'Thursday' | 'Friday' | null;  // null when cadence=weekdays
  time: string;  // 'HH:MM'
  week: 1 | 2 | null;  // null when cadence=weekdays
  enabled: boolean;
};

// Workspace mode (URL-driven recommended — ?mode=day)
type Mode = 'day' | 'preplan' | 'plan' | 'demo' | 'retro';

// Derived (computed from schedule + current time):
// - suggestedMode: Mode | null
// - upNext: { entry: ScheduleEntry; startsAt: Date; imminent: boolean } | null
```

The schedule lives in `localStorage` for now (one-user app). The Outlook integration mentioned in the modal footer is a later slice — leave the line of copy but no plumbing for it.

---

## Design Tokens

These are already defined in the existing `dashboard.css`. Reuse them — do not redeclare with new values.

### Colors (OKLCH)
| Token | Value | Purpose |
|---|---|---|
| `--bg-0` | `oklch(0.135 0.028 260)` | Page background |
| `--bg-1` | `oklch(0.180 0.030 258)` | Raised surface |
| `--bg-2` | `oklch(0.215 0.030 256)` | Card surface |
| `--bg-3` | `oklch(0.275 0.030 254)` | Inset / track |
| `--line` | `oklch(0.36 0.030 252 / 0.55)` | Stronger divider |
| `--line-soft` | `oklch(0.36 0.030 252 / 0.28)` | Standard divider |
| `--line-hair` | `oklch(0.36 0.030 252 / 0.18)` | Hairline divider |
| `--ink-0` | `oklch(0.95 0.014 230)` | Primary text |
| `--ink-1` | `oklch(0.87 0.016 232)` | Default body |
| `--ink-2` | `oklch(0.67 0.022 238)` | Secondary text |
| `--ink-3` | `oklch(0.50 0.025 244)` | Tertiary / caps |
| `--ink-4` | `oklch(0.38 0.025 248)` | Dimmest / disabled |
| `--accent` | `oklch(0.78 0.075 245)` | Single accent — moonlit blue |
| `--accent-deep` | `oklch(0.62 0.090 250)` | Accent shadow tone |
| `--accent-soft` | `oklch(0.78 0.075 245 / 0.18)` | Accent fill at 18% |
| `--accent-hair` | `oklch(0.78 0.075 245 / 0.30)` | Accent fill at 30% |

**Accent rule:** there is exactly one accent. Never introduce a second hue for status, error, success, or any other meaning. Use ink levels for non-accented signal.

### Rail-specific surfaces (slightly darker than `--bg-0`)
- Rail bg: `oklch(0.118 0.024 260)`
- Modal scrim ring color: same as `--bg-0`

### Typography
- **Geist** for UI text (weights used: 300, 400, 500, 600)
- **Geist Mono** for numbers, ids, times, schedule values (weights: 400, 500, 600). Apply `font-feature-settings: "tnum" 1, "zero" 1` for tabular figures.

### Spacing & radii
- Modal corner radius: 12px
- Card / tile corner radius: 8px
- Pill / time input radius: 5px
- Toggle radius: 999px
- Rail-tile radius: 6px
- Common gaps: 4 / 6 / 8 / 10 / 12 / 14 / 16 / 18 / 20 / 22 / 24 / 28 / 32 / 36 / 40 / 44 / 48 / 56
- Common padding rhythm: see CSS for exact per-component values

### Motion
- Standard transition: `180ms ease-out`
- Toggle: `180ms ease`
- Shimmer one-shot: `600ms ease-out 1 forwards`

---

## Assets

No raster images. All glyphs are inline SVG (in `slice-4a.jsx`, `Glyph` object). Reproduce them as-is or extract into your icon system using the exact same paths.

Fonts: load Geist + Geist Mono from Google Fonts. The mockup uses:
```html
<link href="https://fonts.googleapis.com/css2?family=Geist:wght@300;400;500;600;700&family=Geist+Mono:wght@400;500;600&display=swap" rel="stylesheet" />
```

---

## Files in this bundle

| File | What it is |
|---|---|
| `Sprint Helper — Slice 4a.html` | The host HTML — opens both artboards in a design canvas. Reference only. |
| `slice-4a.css` | All new styles for this slice. Scoped under `.s4a`. Reuses the dashboard's OKLCH tokens. |
| `slice-4a.jsx` | React components: `ModeTabs`, `ModeRail`, `UpNextTile`, `ScheduleModal`, plus the `DashboardShell` wrapper. **Variation B (rail) is the chosen direction** — `ModeTabs` is included for reference but not used in the final design. |
| `dashboard.css` | The **existing** dashboard CSS. Your new pieces extend this; the design tokens here are the source of truth. |
| `dashboard.jsx` | The **existing** dashboard components for context. |
| `design-canvas.jsx` | Canvas wrapper used by the host HTML. Not part of the design. |

---

## Implementation notes

1. **Reuse the existing dashboard's token vocabulary verbatim.** Do not redeclare colors with hex values; use the OKLCH custom properties. The Sprint Helper visual identity depends on the OKLCH lightness ramp staying consistent.
2. **Set up `Mode` as URL state**, not just React state. `?mode=preplan` should deep-link.
3. **Compute the schedule's "current/next" event in local time.** Don't store offsets; store wall-clock times and resolve against `Date.now()` per render.
4. **Persist the schedule to `localStorage` for now.** Schema is forward-compatible — when the Outlook integration lands, that becomes the source of truth and `localStorage` becomes a fallback.
5. **The mode rail is fixed-width (64px) but the dashboard layout otherwise stays flexible.** Wrap the existing dashboard body in a two-column grid: `64px 1fr` when the rail is mounted.
6. **The four placeholder modes (Pre-plan, Plan, Demo, Retro)** can render a simple centered card with the mode name and a "Coming in slice 4b/4c/…" line. Not in this design — define a `<ModePlaceholder>` component for them.
7. **Accessibility:** rail tiles should be `<button>` with `aria-pressed`. Modal needs focus trap + `aria-modal="true"` + `aria-labelledby` pointing at the title. Toggle uses `aria-pressed`. The mockup already follows these.

---

## What's NOT in this slice

- The four placeholder modes' content (just the mode rail entry exists for them — landing pages are future slices)
- The day/week popover menus inside PillSelect (mockup shows static pills; you implement the actual menu)
- Outlook integration (line of copy only)
- Animations between mode switches (don't add one — instant switch is fine)
- Mobile / narrow-viewport handling for the rail (this is a desktop-first single-user tool; deal with mobile later)
