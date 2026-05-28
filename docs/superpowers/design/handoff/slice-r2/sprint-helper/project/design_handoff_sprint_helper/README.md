# Handoff: Sprint Helper — Slice 1.7 + Slice 2.1d

## Overview

Two slices to be added to the existing **Sprint Helper** dashboard (a personal
sprint dashboard that sits in front of Azure DevOps). Both slices integrate into
parts of the page that already exist; they do **not** redesign the dashboard.

- **Slice 1.7 — Expand-in-place rows + inline editors.** Task rows in the
  Active Story card and chips in the "My user stories" grid each get a
  chevron. Clicking it slides open a calm strip with the parent context, a
  description preview, and inline editors for State / Estimate / Remaining.
  Edits push to Azure DevOps on blur (no Save button). The existing side
  drawer is unchanged — a ghost link still opens it for the deep dive.

- **Slice 2.1d — Activity feed + live markers.** When the MCP plugin runs
  Claude Code against a task, the row gets a small `live` marker, and a
  "Recent activity" section appears inside the existing expand panel,
  beneath the editors. The parent chip gets a dimmer rolled-up marker.
  A sidebar "Live now" tile lists open sessions; it hides entirely when
  none are open.

Both slices share the existing dark, warm-dusk palette and the single
moonlit-blue accent. No new accent colors were introduced.

## About the design files

The files in this bundle are **design references created in HTML/JSX** —
prototypes showing intended look, behavior, and timing. They are **not**
production code to copy directly. The task is to recreate them in the
Sprint Helper codebase's existing environment, using its established
component patterns, state management, and conventions.

If the codebase is React + CSS modules, port the JSX components into that
shape. If it's React + Tailwind, translate the design tokens below into
your tokens.css / tailwind.config. The mocks are the source of truth for
visual + behavioral fidelity; your codebase is the source of truth for
how the code should be structured.

## Fidelity

**High fidelity.** All colors, typography, spacing, transition timings,
hover/active/focus states, and copy are pixel-accurate. Recreate them
faithfully using the codebase's existing libraries and patterns. If your
codebase already has a `Stepper`, `SegmentedControl`, or `Tooltip`
primitive, prefer using it (and theming it to match) over building new ones.

---

## Design tokens

These are already declared on `:root` in `slice-1.7.css` (and re-declared
in `slice-2.1d.css` for self-containment). Move them into your tokens
file and reference them by name everywhere.

### Colors (OKLCH — preserve, don't convert)

```css
/* Backgrounds — deep dusk, 4 levels */
--bg-0: oklch(0.135 0.028 260);   /* page */
--bg-1: oklch(0.180 0.030 258);   /* raised */
--bg-2: oklch(0.215 0.030 256);   /* card */
--bg-3: oklch(0.275 0.030 254);   /* inset / track */

/* Lines */
--line:      oklch(0.36 0.030 252 / 0.55);
--line-soft: oklch(0.36 0.030 252 / 0.28);
--line-hair: oklch(0.36 0.030 252 / 0.18);

/* Ink — 5 levels */
--ink-0: oklch(0.95 0.014 230);   /* primary text */
--ink-1: oklch(0.87 0.016 232);
--ink-2: oklch(0.67 0.022 238);
--ink-3: oklch(0.50 0.025 244);
--ink-4: oklch(0.38 0.025 248);

/* Single accent — moonlit blue. Never add a second accent. */
--accent:      oklch(0.78 0.075 245);
--accent-deep: oklch(0.62 0.090 250);
--accent-soft: oklch(0.78 0.075 245 / 0.18);
--accent-hair: oklch(0.78 0.075 245 / 0.30);

/* Event-type tints (slice 2.1d only) — all desaturated, all single hue family.
   These are NOT a multi-accent system — they're micro-variations of "calm". */
--ev-focus:    oklch(0.78 0.075 245);  /* same as accent — "this is on" */
--ev-progress: oklch(0.78 0.050 160);  /* muted sage — NOT bright green */
--ev-blocker:  oklch(0.74 0.060 38);   /* muted rust — NOT red */
--ev-decision: oklch(0.87 0.016 232);  /* ink-1 — neutral */
--ev-note:     oklch(0.55 0.022 244);  /* dim ink */
```

### Typography

- UI: **Geist**, 300/400/500/600/700 weights
- Mono: **Geist Mono**, 400/500/600 — used for **all numbers, IDs, clock
  values, event timestamps, and effort durations**. Always enable tabular
  figures: `font-feature-settings: "tnum" 1, "zero" 1;`. Slight negative
  tracking: `letter-spacing: -0.005em`.
- Google Fonts import:
  `https://fonts.googleapis.com/css2?family=Geist:wght@300;400;500;600;700&family=Geist+Mono:wght@400;500;600&display=swap`

### Spacing

The mocks use a calm rhythm. Common values:
- card padding: `32px 36px` (Active Story), `16px 18px` (chips), `20px 22px` (expand inner)
- gap between sections: 24–32px
- gap between rows in a list: 0 (rows are sized; no extra gap)
- row vertical padding: 14px (task), 11px (sub-task), 8–10px (activity event)

### Border radius

- Card / panel: `8px`
- Inline tile / chip: `6px`
- Subtask row: `5px`
- Button / chip-row inner: `4–5px`
- Pill / segmented control: `999px`

### Shadows

Used sparingly. Only on the primary CTA and on the "live" indicator's
soft halo:
```css
/* primary CTA */
box-shadow: 0 1px 0 oklch(0.88 0.05 240 / 0.4) inset,
            0 14px 40px -16px oklch(0.50 0.10 250 / 0.65);

/* live dot halo (slice 2.1d variation B; we shipped A but this is here for ref) */
box-shadow: 0 0 0 3px oklch(0.78 0.075 245 / 0.10);
```

### Motion

- All transitions are **180ms ease-out**. No bouncy springs.
- Chevron rotation: `transform: rotate(90deg)` over 180ms ease-out.
- Expand panels animate height via the **`grid-template-rows: 0fr → 1fr`**
  trick (the parent uses `display: grid` + `overflow: hidden` on the
  child). Don't use `max-height` — that flickers when content changes.
- The live marker is **static**. No pulse, no glow animation, no
  shimmer loop. (There's a one-time 600ms `target-shimmer` on a state
  pill during the in-flight PATCH — that's the only animation that runs
  more than once per user action.)

---

## Slice 1.7 — Expand-in-place rows + inline editors

### Files

- `Sprint Helper — Slice 1.7.html` — host page (DesignCanvas wrapper)
- `slice-1.7.css` — all styles for this slice
- `slice-1.7.jsx` — React components: `Variation`, `TaskRow`, `Chip`,
  `StatePicker`, `Stepper`, plus the variant A "Field strip" expand
  layouts (`TaskExpandA`, `ChipExpandA`). Variant B code is still in the
  file but **not used** — A was chosen.

### Selected direction

**Variation A — Field strip.** The expand panel is a single calm horizontal
strip. Top to bottom: parent-context tag → description preview (~3 lines)
→ a horizontal row with **STATE · ESTIMATE · REMAINING** → footnote
("edits push to Azure DevOps when you click away") and a ghost link
"see full description and comments →" that opens the existing side
drawer.

### Task row anatomy

Grid template:
```
grid-template-columns: 78px minmax(0,1fr) 130px 84px 76px 28px;
gap: 18px;
```
Columns: `#id · title · elapsed/estimate · STATE caps · quick-action buttons · chevron`

States:
- `state-waiting` — title `--ink-0`, state caption `--ink-3`
- `state-going` — title `--ink-0`, state caption `--accent`
- `state-done` — title `--ink-3` with `line-through` `--ink-4` underline

Hover: background `oklch(0.20 0.030 256 / 0.6)`. Open rows keep the same
background — they don't "lock" visually beyond the chevron rotation.

Quick-action buttons (▶ start, ⏸ pause, ✓ done): the existing dashboard
already has these as the timer controls. Inline-edit shouldn't replace
them; the chevron sits to their right.

### Chip anatomy

Card with 2px left border at `--accent-hair`, becoming `--accent` on hover
or open. Title `15px ink-0 500`. Counts row uses mono with tabular figures:

```jsx
<span className="c-going">3 going</span>
<span className="sep">·</span>
<span className="c-wait">0 waiting</span>
<span className="sep">·</span>
<span className="c-done">0 done</span>
```

- `c-going` is `--accent`, `c-wait` is `--ink-3`, `c-done` is `--ink-2`.
- Bug-type chips: the `chip-kind` caption shifts to a muted rust
  `oklch(0.78 0.075 28)`. Body still uses the same accent — there is no
  second accent.

### Expand animation (CRITICAL)

```css
.task-expand-wrap {
  display: grid;
  grid-template-rows: 0fr;
  transition: grid-template-rows 180ms ease-out,
              opacity 180ms ease-out;
  opacity: 0;
}
.task-expand-wrap.is-open {
  grid-template-rows: 1fr;
  opacity: 1;
}
.task-expand-wrap > .task-expand { overflow: hidden; min-height: 0; }
```

This animates real height without measuring DOM. Don't use `max-height`.

The chevron rotates with `transform: rotate(90deg)` on the same 180ms
ease-out timing, so they read as one motion.

### Inline editor primitives

#### State pill picker

3-segment segmented control (`waiting` / `going` / `done`). All lowercase
mono. Current segment: filled `--accent` background, dark ink text
`oklch(0.16 0.04 260)`, weight 600. Others: transparent, color `--ink-3`,
weight 500. Hover non-active: color shifts to `--ink-1`.

Click a non-active pill → optimistic transition + brief 600ms one-time
shimmer on the **target** pill (not the whole control) while the PATCH
flies. Define as a keyframe animation that runs once on `.is-target`:

```css
@keyframes target-shimmer {
  0%   { background: var(--accent-soft); color: var(--ink-1); }
  100% { background: var(--accent);      color: oklch(0.16 0.04 260); }
}
.statepick-seg.is-target { animation: target-shimmer 600ms ease-out 1; }
```

If the PATCH fails, the row-level error UI handles it (separate phase).
Assume success in this mock.

#### Stepper (Estimate / Remaining)

`− value +` layout, gap 4px. The buttons are 22×22, transparent border,
color `--ink-3`. On hover the border becomes `--accent-hair`, color
`--accent`, background `--accent-soft`. Disabled (at min): opacity 0.4.

The value itself is a button by default that **becomes a text input on
click**:
- Snap to step: `Math.round(n / step) * step` (step = 0.5).
- Commit on **blur** or **Enter**.
- Cancel on **Escape** — revert to last committed value.
- Display format: `${value}h` (e.g. `4h`, `2.5h`, `1.25h`).
- Input: `inputMode="decimal"`, `autoFocus`, select-all on focus.

Both controls live next to a small uppercase caps label like `ESTIMATE`
`REMAINING` (`10px / 0.16em / --ink-3`).

### "Click away pushes" microcopy

Footer of the expand panel reads exactly:

> edits push to Azure DevOps when you click away

`11px / --ink-4`. Right side of the same row is the ghost link:

> see full description and comments →

`12px / --ink-2`, underline on hover with `--accent`.

### Chips behavior differs from tasks

- **Multiple tasks** can be open simultaneously — collapsing one shouldn't
  collapse others. Store `openTaskIds: Set<string>` (or an object map).
- **Only one chip** can be open at a time — opening another collapses the
  current. Store `openChipId: string | null`.

The chip expand panel sits **below the chip grid** (full-width across the
3-column grid), not inside the chip card. CSS:

```css
.chip-expand-wrap {
  grid-column: 1 / -1;
  /* same height-anim treatment as task expand */
}
```

---

## Slice 2.1d — Activity feed + live markers

### Files

- `Sprint Helper — Slice 2.1d.html` — host page (DesignCanvas wrapper)
- `slice-2.1d.css` — all styles, builds on the same tokens
- `slice-2.1d.jsx` — `Variation`, `LiveMarker`, `ActivityFeed`,
  `EventRow`. Variant A "Inline pill · ruled feed" is the chosen
  direction. Variant B (static dot · journal feed) still exists in code
  but is not rendered.

### Selected direction

**Variation A — Inline pill + ruled feed.** Live marker is a small
lowercase mono `live` pill in the chip header and at the right edge of
the task row. Activity rows are separated by 1px hairlines — feels like
a tidy log.

### Live marker — task row variant

```html
<span class="live-pill">live</span>
```

Background `--accent-soft`, border `--accent-hair`, text color
`--accent`. A 5px round accent dot sits inside the pill at the start,
generated via `::before`. Pill is `2px 8px 2px 7px` padding,
`border-radius: 999px`. Font: Geist Mono, 9.5px, letter-spacing 0.04em.
**Never animate the dot.**

Position: right edge of the task row, before the chevron column. Anchored
via grid (`justify-self: end` inside a dedicated column).

### Live marker — chip header (rolled-up) variant

```html
<span class="live-pill is-rollup">live · 1 task</span>
```

Same shape, but background **transparent**, border `--line-hair`, text
`--ink-2`, internal dot `--ink-3`. The chip is not "the thing that's
live" — its child is — so the marker reads as quieter context, not as a
focal point.

When the chip has multiple live children: `live · N tasks`. When zero:
the pill is absent entirely.

### "Recent activity" section

Slots into the **existing** expand panel from slice 1.7, below the
editor strip, separated by a single hairline divider:

```jsx
<div className="s21-strip"> {/* STATE / ESTIMATE / REMAINING */} </div>
<div className="s21-divider" />
<ActivityFeed events={…} scope="task" max={5} />
```

Header reads exactly `Recent activity` in caps-small letterspaced style
(`10px / 0.16em uppercase / --ink-3`). For the chip's rolled-up version,
add a meta caption `rolled up across N tasks` (`10px / --ink-4`) right-aligned.

### Event row anatomy

Three columns:
```css
grid-template-columns: 64px 88px 1fr;
gap: 14px;
```
- **Timestamp** (column 1): mono, `--ink-3`, `12px`. Format `HH:MM`
  (5 chars). For events from prior days, render `Tue 09:15` — wider
  values are absorbed by the 64px column (which is roomy enough).
- **Type label** (column 2): mono, caps, letterspaced, 10px, weight 600.
  Color depends on type (see token list above). **Text only — no badge
  box, no pill, no icon.**
- **Body** (column 3): Geist 13px, `--ink-1`, line-height 1.45. By
  default `truncate` with ellipsis. If the body must wrap, indent the
  wrap to align with the body column (already handled by grid).

### Variation A's "ruled feed" treatment

```css
.va .s21-ev + .s21-ev { border-top: 1px solid var(--line-hair); }
```

Hairlines between rows. Vertical padding 8px per row. No row hover state —
this is reading material, not a control.

### "Show all" affordance

Default: render `events.slice(0, 5)`. If more exist, show a small
caps-uppercase button:

```
5 of 12 · show all
```

`11px / 0.14em / --ink-2 / weight 500`, padded 8px 0, left-aligned,
border-bottom transparent (becomes `--accent` on hover). When expanded,
button label flips to `Show recent only`. Cap the expanded list at 20
events; beyond that the user uses an existing deep-link path elsewhere.

### Empty state

When a task/chip has no events:

> Nothing yet. Claude Code will log things here as you work.

`13px italic / --ink-3`, no icon, no big illustration. Visible at the
exact spot the list would otherwise be — confirms the slot exists.

### "Live now" sidebar tile

A new tile in the sidebar, above the existing "Up next" tile. Renders
**only when ≥1 session is open** — when zero sessions, hide the tile
entirely (no empty placeholder).

```
LIVE NOW · 2 SESSIONS
Auth refactor           14 min
Branch protection        4 min
```

- Title: caps small letterspaced (`.dim-cap` style, 10px / 0.16em / `--ink-2`).
- A 6px accent dot sits before the title. Static.
- Each row: title (Geist 13px / `--ink-0` / 500) on the left, mono
  elapsed time on the right.
- Below each row: a tiny caps-small parent-name caption (10px / 0.12em /
  `--ink-4`) — the user-story title.
- Clicking a row jumps to that story: focuses the chip, expands the
  panel, scrolls into view if needed. Use whatever your routing/anchor
  pattern is.
- When only 1 session is open: title reads `LIVE NOW` (no "1 session"
  pluralizer); single row is shown.

The tile uses `border-left: 2px solid var(--accent)`, the same visual
language as the live chip and the Active Story card — it reads as
"the thing that's currently happening".

### Where the rolled-up chip activity comes from

The chip's "Recent activity" is the **merged + time-sorted** stream
of all child tasks' events, capped at 5 by default. Each event keeps
its association with its source task internally for navigation, but
the UI shows them as a flat list — no task IDs in the rolled-up view.
(If the user wants per-task detail, they expand that task.)

---

## State management

State the implementation will need to track:

### Slice 1.7

- `openTaskIds: Set<string>` — which task rows are expanded (multiple allowed)
- `openChipId: string | null` — which chip is expanded (max one)
- `editingTask: { id, field } | null` — which Stepper is in input mode
- `inflight: Map<taskId, Set<field>>` — which PATCHes are in flight, so
  the target pill can show its 600ms shimmer

PATCH semantics:
- **On blur** of stepper or **on click** of non-current state pill: fire
  a debounced (250ms) PATCH against ADO.
- On success: leave the optimistic value in place.
- On failure: revert; surface the error at the row level (separate
  phase — not part of this slice).

### Slice 2.1d

- `sessions: Map<taskId, { startedAt: Date }>` — open MCP sessions.
  Derive: `liveTasks = sessions.keySet()`, `liveStories = parentsOf(liveTasks)`.
- `events: { [taskId]: ActivityEvent[] }` — already stored against tasks
  by the MCP plugin per the brief. Sort newest-first for display.
- `activityExpanded: Set<panelId>` — which "show all" buttons are
  toggled open.

`ActivityEvent` shape:
```ts
type ActivityEvent = {
  time: string;        // "HH:MM" or "Day HH:MM"
  type: "focus" | "progress" | "blocker" | "decision" | "note";
  body: string;        // single sentence, plain text
  taskId: string;      // for chip rollup navigation
};
```

Live tile rows:
```ts
type LiveSession = {
  taskId: string;
  title: string;       // task title
  parent: string;      // user-story title
  elapsed: string;     // "14 min", "1h 23m" — same format as task row effort
};
```

---

## Hard constraints (recap — do not violate)

- **Dark warm-dusk background. One accent only.** Never introduce a
  second accent color, even for "blocker" or "success". The event-type
  tints are all within one calm hue family; they read as variation
  inside a single mood, not as a multi-color taxonomy.
- **No emoji.** Unicode arrows / chevrons sparingly (`›`, `→`, `↗`, `▶`,
  `⏸`, `✓`).
- **No pulsing, no rainbow, no celebratory bursts.** Slice 2.1d's
  "live" marker is static. The only animation is the 180ms expand
  reveal and a one-time 600ms target-pill shimmer on PATCH commit.
- **No modal dialogs for editing.** All edits happen in place.
- **No Save / Cancel buttons.** Commit on blur or pill click.
- **The word "session" is never user-facing.** Internally it's a
  session; for the user it's "live" + "Recent activity".
- **No toasts.** No interruption — the user looks when they want to.
- **The side drawer is unchanged.** Its existing behavior (full HTML
  description + comments + parent/children/related links) is what the
  "see full description and comments →" link opens. This slice doesn't
  redesign it.

---

## Files in this bundle

| File | What it is |
| --- | --- |
| `Sprint Helper — Slice 1.7.html` | Host page for slice 1.7 — opens in browser as the design reference |
| `slice-1.7.css` | All styles for slice 1.7 |
| `slice-1.7.jsx` | React components for slice 1.7 (variant B kept for reference but not rendered) |
| `Sprint Helper — Slice 2.1d.html` | Host page for slice 2.1d |
| `slice-2.1d.css` | All styles for slice 2.1d |
| `slice-2.1d.jsx` | React components for slice 2.1d (variant B kept for reference but not rendered) |
| `design-canvas.jsx` | The Figma-ish wrapper used to lay artboards out side-by-side. Not part of the product; just for viewing the mocks. |
| `_reference_dashboard.css` | The existing dashboard's CSS (Dawn + Ember variations). Provided for reference so you can match the visual language of the surrounding page — do not import into the slice files. |

To view the mocks: open either `Sprint Helper — Slice 1.7.html` or
`Sprint Helper — Slice 2.1d.html` directly in a browser. They are
self-contained (React + Babel are loaded from unpkg CDN).

## Open questions to confirm before coding

- **Stepper rounding.** ADO rounds to 0.25h on the server. The mocks
  step by 0.5h. Confirm whether the input should snap to 0.5 or 0.25;
  the brief specified 0.5 but the actual ADO PATCH rounds finer.
- **Failure UI.** Row-level error display for failed PATCHes is
  out-of-scope for this slice. Confirm the existing error surface still
  applies; if not, add a follow-up slice.
- **Live tile click target.** Confirm whether clicking a live tile row
  scrolls + expands the chip + expands the task, or just navigates the
  chip into view. The mock assumes "do all three".
- **Activity event retention.** What's the max history per task — last
  24h? last sprint? The mock assumes "everything", with a 20-row cap on
  the "show all" view.
