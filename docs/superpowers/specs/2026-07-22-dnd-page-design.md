# D&D (Discovery & Design) Page — Design

**Date:** 2026-07-22
**Status:** approved, ready for implementation plan
**Relates to:** the discovery-phase feature (`2026-07-22-discovery-phase-design.md`), which built the server-side discovery model this page reads.

## What this is

A new dashboard page — its own mode, `dnd`, sitting next to Day / Plan / Demo /
Retro in the left rail — where Moran browses every feature he's done discovery
work on, and reads any one feature's discovery in full. It is the "show it in
the meeting" surface: a calm, readable view of the discovery the AI wrote during
a session.

It is a **separate thing from Focus**. Focus answers "what am I doing right
now" (live session, timer, activity notes). D&D answers "let me look at the
discovery for a feature." Two doors, two purposes — no shared state, no
auto-jump between them.

**This spec covers the DISCOVERY half only.** The page is built to grow a Design
half later (see "Growing into Design"), but nothing design-related is built now.

## Who it's for and why

Moran, before or during a discovery meeting with his tech lead or the platform
team. The page has to be easy to walk into cold (ADHD): one clear focal point per
screen, the flow readable top-to-bottom, everything else quiet and to the side.

## The two screens

### Screen 1 — the feature list

Every feature Moran has **touched** (has a workspace feature folder), grouped
into sections by **D&D status**, in this order:

1. **In progress** — a discovery is started but not finished. Top of the page:
   this is "what needs me."
2. **Not started** — the feature folder exists but no discovery is written yet.
3. **Finished** — the discovery is complete (a flow plus at least one complete
   context group).
4. **Closed** — the discovery story on the board is closed.

Each row shows:

- The feature's **displayName** — `**<title>** (#<id>)`, echoed verbatim from
  the API (bold title, id in parens, never a bare id).
- A **board-state chip** — the Azure DevOps state of the discovery story:
  `new` / `active` / `blocked` / `closed`. Blocked is visually distinct so it
  never hides.
- If a discovery is running, a **day-count** ("day 2 of 2"), from the existing
  `discoveryDayStage`.

Clicking a row opens Screen 2 for that feature.

**Which features appear:** only touched ones. The source is a scan of the
registered workspace paths for `<id>-<slug>` feature subfolders. A feature with
no folder never appears here — Moran starts it via `/sprint-helper:discovery`
first, which is what creates the folder.

### Screen 2 — the feature detail page

A **back control** ("← all features") is always present and returns to Screen 1.

**Main column** (the thing you read, in this order):

1. **Problem** — the 2–3 line problem statement, as a short header.
2. **The end-to-end flow** — the star of the page. The numbered story of how the
   feature works, start to finish. It's what a demo would show.
3. **Context groups** — directly below the flow. Each group is a titled block;
   inside it, the one-liners, each with a colored **tag** (diff / risk / fact /
   option). Diffs and their risks read as visually adjacent pairs.

**Side panel** (glance, don't read):

- **Demo** — status (`none` / `scheduled` / `built`) + date. Holds the one
  write-back action (below).
- **Lanes** — ours vs the tech lead's, one line each.
- **Open questions** — the list for the platform-team talk.
- **Design** — a quiet, clearly-labelled "Design not started" slot now. When the
  design phase exists, its content fills here.

**Light actions** (no free-text editing of the discovery):

- **Open folder** — reveal the feature's `discovery/` folder locally.
- **Mark demo** — set demo status + date. This is the only thing the page writes.

Free-text editing of problem/flow/groups is **out of scope**. That work stays in
the Claude session, where the discovery method and its guardrails live. Splitting
authoring across two places would risk drift for no clear gain.

## Architecture

Follows the existing dashboard patterns exactly — no new libraries, no router.

### Front end

- **New mode `dnd`.** Add `'dnd'` to `MODES` in `src/lib/useMode.ts` and to the
  `ModeId` type in `src/lib/api.ts`. Add a rail tile in `R21_MODES`
  (`Dashboard.tsx`). Add a branch in the mode ternary (`Dashboard.tsx` ~306-346)
  rendering a new `<DnDView>`.
- **New component `src/components/DnDView.tsx`** — self-contained, mirrors
  `PlanView.tsx` as the template for a full mode-page. It owns one piece of
  local state: `selectedFeatureId | null`. `null` → render the list (Screen 1);
  set → render the detail (Screen 2). "Back" sets it to `null`. This is the same
  list↔detail pattern `FocusTaskDrill` already uses; no URL routing for the
  sub-view (consistent with how Focus drill-in works).
- **Styles** live in the single `src/styles/dashboard.css` under a fresh `dnd-*`
  namespace prefix (the convention Plan set with `plan2-*`). Section/state
  variants use `is-*` modifier classes.
- **Data** comes from a new fetch hook in `src/lib/api.ts` (below). The list and
  the detail are two calls, matching the app's REST-over-Vite-middleware style.

### Back end (Vite dev-server middleware + pure builders)

The dashboard's API is Vite middleware in `vite.config.ts` that lazily imports
`./server/*`. Add:

- **`GET /api/discovery`** → the list. Returns one entry per touched feature:
  `{ id, displayName, folderPath, dndStatus, boardState, dayStage }`.
  - `dndStatus` is one of `in-progress` / `not-started` / `finished` / `closed`,
    derived from `discoveryStatus(folderPath)` plus the board state (closed wins).
  - `boardState` is the discovery story's ADO state, fetched via the existing ADO
    client. When the story can't be resolved, `boardState` is `null` and the row
    still renders (folder truth is enough to list it).
- **`GET /api/discovery/:id`** → the full detail for one feature: the parsed
  `DiscoveryDoc` (problem, flow, groups, lanes, demo, openQuestions) plus the
  `displayName` and `folderPath`. 404 if the feature isn't a touched feature.
- **`POST /api/discovery/:id/demo`** → the mark-demo action. Body
  `{ status, date }`; validates status ∈ `none|scheduled|built`; reads the doc,
  sets `doc.demo`, writes via `writeDiscoveryDoc` (which regenerates the md too).
- **`POST /api/discovery/:id/open-folder`** → opens the feature's `discovery/`
  folder in the OS file browser. There is no existing reveal-folder route, so
  this is new: the handler (local Node) runs the platform reveal command
  (`open` on macOS) via `child_process` on the folder path. It's a local
  single-user tool, so shelling out to `open` is acceptable. The response is
  just ok/failed; on failure the front end falls back to showing the path as
  copyable text.

### New pure server module: `server/discovery-list.ts`

The one genuinely new piece of logic: turning workspace paths into a list of
touched features. Kept pure and unit-tested, separate from the fs/ADO glue.

- `parseFeatureFolder(name: string): { id: number; slug: string } | null` —
  parse a `<id>-<slug>` folder name; return `null` for non-matching names
  (mirrors `featureFolderName` in `workspace.ts`, the inverse of it).
- `listTouchedFeatureFolders(workspacePaths, readdir): { id, folderPath }[]` —
  scan each workspace path's immediate children, keep the ones that parse as a
  feature folder. `readdir` injected so it's testable without the fs.
- `deriveDndStatus(args: { finished; hasDiscovery; boardClosed }): DndStatus` —
  the small precedence rule (closed > finished > in-progress > not-started).

The route glue in `vite.config.ts` composes these with `discoveryStatus`,
`readDiscoveryDoc`, `getWorkspaces`, and the ADO client. The glue stays thin; the
decisions live in the tested pure functions.

## Data flow

1. Moran clicks the D&D rail tile → `mode` becomes `dnd` → `<DnDView>` mounts.
2. `DnDView` fetches `GET /api/discovery` → renders the grouped list.
3. Moran clicks a feature → `selectedFeatureId` set → `DnDView` fetches
   `GET /api/discovery/:id` → renders the detail (main column + side panel).
4. Moran clicks "Mark demo" → `POST /api/discovery/:id/demo` → on success,
   re-fetch the detail so the side panel reflects the new demo status.
5. "← all features" clears `selectedFeatureId` → back to the list (re-fetch to
   pick up any board-state changes).

## Error and empty states

- **No workspace registered / no touched features** → the list shows a calm empty
  state: one line explaining discoveries appear here once started, and that
  `/sprint-helper:discovery` starts one. Not an error.
- **Detail fetch 404 / doc unreadable** → an inline "couldn't read this
  discovery" message with a working back button; never a blank screen or a crash
  (matches how the app guards version skew today).
- **ADO unreachable** → the list still renders from folder truth with
  `boardState: null` (chips just omitted). The page must not depend on ADO being
  up to be useful — the discovery content is local.
- **Version skew** (dashboard newer/older than server) → `DnDView` renders
  nothing rather than throwing if the `/api/discovery` shape is missing, the same
  guard `RailDiscovery` uses.

## Testing

- **`server/discovery-list.ts`** — unit tests for `parseFeatureFolder` (valid,
  symbol-only-id folder, non-feature folder, junk), `listTouchedFeatureFolders`
  (injected readdir, multiple workspaces, mixed folders), and `deriveDndStatus`
  (each precedence case). This is the new logic, so it carries the real coverage.
- **Route handlers** — thin glue; smoke-tested by Moran on a real reload, in line
  with how the other `/api/*` routes are treated (MCP/glue handlers aren't
  unit-tested in this repo). No new invariants live in the glue.
- **Front end** — `DnDView`'s list↔detail toggle is plain state; if a focused
  unit test is cheap (grouping features into sections given a list payload), add
  it, mirroring `focusPicks.test.ts`. No heavy component-render harness.

## Growing into Design (later, not now)

The page is shaped so the Design half slots in without a rebuild:

- The detail page's side panel already reserves a **Design** slot.
- The list's status derivation can gain design states later without changing the
  row shape.
- When the design phase and its file exist, a `design/` subfolder sits beside
  `discovery/` (the split is already in place), and a parallel
  `readDesignDoc` / `designStatus` fills the reserved slot.

Nothing in this spec builds any of that. It's noted only so the discovery-half
choices don't paint us into a corner.

## Explicitly out of scope

- Free-text editing of discovery content from the page.
- The demo **generator** (reading a discovery and building a simulated HTML) —
  that's its own spec, next after this.
- The sealed-iframe demo **viewer** — arrives with the demo generator work.
- Any Design-phase content, files, or gates.
- A focus variant of D&D — decided against; Focus stays as-is and separate.
