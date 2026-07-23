# D&D Page Redesign — three-level layout

**Date:** 2026-07-23
**Status:** approved (mockup `layout-v3.html`), ready for implementation plan
**Supersedes the LOOK/LAYOUT of:** `2026-07-22-dnd-page-design.md` (the original discovery-half page). The data, routes, and fetch hooks from that spec stay; this changes how `DnDView` is laid out and styled.

## Why

The first D&D page shipped working but looked plain and read cramped, and its layout didn't match how Moran pictured it. Two concrete problems from live use:

1. **The status was wrong.** A filled-in discovery file was labelled "Finished" while its board story was still open — confusing, since the feature is plainly still in progress. (Already fixed on main, commit `1742fd4`: the board state decides status now, and "Finished" is gone. This spec assumes that fix.)
2. **The layout was a single scroll** — discovery content with the demo/lanes/questions squeezed into a thin side strip. Moran wants a **three-level** shape, and the fonts were set too small (10–13px) versus the dashboard's real 15–16px reading text.

## The three-level layout

The page is a three-column grid: **feature list → inner menu → reading area.** All three visible at once (email-client feel); picking things swaps only the panels to the right, never a full-page reload.

```
┌───────────────┬──────────────┬────────────────────────────┐
│ FEATURE LIST  │ THIS FEATURE │  READING AREA               │
│ (level 1)     │ (level 2)    │  (level 3)                  │
│               │              │                             │
│ In progress   │ ○ Overview   │  Declarative CD  (#426639)  │
│  • CD #426639◄│ ● Discovery ◄│  DISCOVERY                  │
│ Not started   │ ○ Design soon│  problem …                  │
│  • Secret …   │ ○ Demo  none │  flow  1. 2. 3. …           │
│  • Failover…  │              │  groups  [diff][risk]…      │
│ Done          │              │  lanes · open questions     │
│  • Onboard …  │              │                             │
└───────────────┴──────────────┴────────────────────────────┘
```

### Level 1 — feature list rail (left, ~288px)

Unchanged in behavior from the shipped page: features Moran has touched, grouped by status **In progress → Not started → Done** (the three statuses after the `1742fd4` fix — no "Finished"). Each row: feature `displayName`, board-state chip (Active / Blocked / Closed / etc.), the "ready to close" hint when the file is complete but the story's open, and the day-count on the active feature. Selecting a row opens it (levels 2 + 3 populate).

### Level 2 — inner menu (middle, ~184px)

**This is the new piece.** When a feature is open, a menu of that feature's **facets** appears:

- **Overview** — the feature's own details (title, state, description) plus its child stories/tasks from the board. Answers "what is this feature and what work is under it."
- **Discovery** — the discovery doc (the content that used to be the whole page).
- **Design** — a facet reserved for the design phase. Shows a quiet "Design not started / coming later" until that phase exists.
- **Demo** — the demo facet. Shows the demo status (none / scheduled / built) and, later, the built demo. "none" until the demo generator exists.

One facet is selected at a time; the reading area (level 3) shows it. Discovery is the default when a feature opens. Design and Demo render a calm placeholder now — the menu items are always visible so the shape is legible, but they don't pretend to hold content they don't have.

### Level 3 — reading area (right, fills the rest)

Shows the selected facet, full width, sized to the dashboard:

- **Discovery facet:** problem (a short callout block) → **the end-to-end flow as the focal point** (numbered, roomy, biggest reading text) → context groups (each group name + its items with diff/risk/fact/option tag chips) → lanes (two cards: ours / tech lead's) → open questions. This is the same content the shipped page had, but laid out full-width instead of crammed beside a side strip — the demo/lanes/questions are no longer a thin rail, they're part of the discovery read (lanes + questions) or moved to their own facet (demo).
- **Overview facet:** the feature's details + a list of its child stories/tasks (names before numbers, board state each).
- **Design facet:** "Design not started" placeholder.
- **Demo facet:** demo status + the mark-demo action (the one write); later, the built demo in a sealed iframe (that arrives with the demo-generator work, not here).

## Sizing (the fix that made it "look right")

Match the dashboard, do not invent a smaller scale. Concrete floors, verified against `src/styles/dashboard.css`:

- **Reading text** (problem, flow items, group items, open questions): **15–16px** — the dashboard's reading size (`.r21-ev-body` is 15px, `.note-body` 14px, headlines 15px).
- **Rail rows + menu tabs:** 14–15px.
- **Section labels / caps:** 12–13px uppercase (like `.r21-headline-cap`).
- **Chips + tag chips:** **11–12px** — never the 10px-and-below the first version used. The "never ≤11px with the faintest ink" rule holds; chips use strong semantic colors, not `--ink-4`.
- **Feature title in the reading area:** ~24px (a real page title).

## Architecture

No new data, no new routes. This is a **rewrite of `DnDView.tsx`'s layout + the `dnd-*` CSS**, reusing everything already built.

- **Reuses:** `fetchDiscoveryList`, `fetchDiscoveryDetail`, `markDiscoveryDemo`, `openDiscoveryFolder` (all in `src/lib/api.ts`); the `/api/discovery` route; `server/discovery-list.ts`; the `dnd` mode wiring in `useMode`/`Dashboard`.
- **`DnDView` state grows by one field:** the selected **facet** (`'overview' | 'discovery' | 'design' | 'demo'`, default `'discovery'`) alongside the existing selected-feature id. Both are plain React state — no router.
- **Overview facet needs the feature's children.** The detail route (`GET /api/discovery/:id`) already calls `getWorkItem(id)`, which returns `children` (the stories/tasks). Extend the detail payload to include a small `children` array (`{ id, title, type, state }`) and the feature's own `state`/`description` so Overview has what it needs — a additive change to the existing route and `DiscoveryDetailPayload`, not a new endpoint.
- **CSS:** the existing `dnd-*` block is replaced with the three-column grid + the sized-to-app rules. Same namespace, same palette vars, same responsive discipline (collapse the reading area's internal columns on narrow widths; the three-column shell can drop the inner menu into a top row of pills under ~900px).

### Component shape

`DnDView` splits into small pieces (the current single-file component is fine to grow into a folder or a few local components):
- `DnDView` — owns state (selectedFeatureId, facet), fetches list + detail.
- `FeatureListRail` — level 1 (grouped rows). Pure, takes sections + onSelect.
- `FeatureFacetMenu` — level 2 (the inner menu). Takes the current facet + demo status + onPick.
- `FacetReadingArea` — level 3, switches on facet → `DiscoveryFacet` / `OverviewFacet` / `DesignFacet` (placeholder) / `DemoFacet`.

Keep each focused; they're presentational, fed by the two fetches.

## Error / empty / skew states (unchanged intent)

- No touched features → the calm empty state on the list ("Discoveries show up here once you start one…").
- A feature with no discovery → the Discovery facet shows "no discovery yet"; Overview still works (it's board data).
- ADO down → list renders from folder truth; Overview shows what it can, degrades without crashing.
- Version skew → render nothing rather than throw if a payload field is missing (same guard as today).

## Testing

- The pure logic (`server/discovery-list.ts`) is already unit-tested and unchanged — status derivation stays green.
- The detail-route payload extension (children + feature state) is thin glue → user smoke-tested, per repo convention.
- `DnDView`'s facet/selection is plain state; if a cheap unit test helps (e.g. default facet is discovery, picking a feature resets facet to discovery), add it, but no heavy render harness.
- Gates: `npm run typecheck`, `npm run build`, `npm test` all green; then Moran's visual smoke of `?mode=dnd`.

## Out of scope (unchanged)

- The demo **generator** (reads a finished discovery, builds a simulated HTML) — its own spec, next.
- The Design phase content and the DR gate.
- Free-text editing of discovery content from the page (still read-only except the demo mark).
- Any board writes beyond the existing mark-demo.
