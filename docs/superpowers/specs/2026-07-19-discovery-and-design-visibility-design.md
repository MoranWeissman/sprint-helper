# Discovery & Design — dashboard visibility

**Date:** 2026-07-19
**Status:** design approved by Moran (verbal: "just start working already"), spec written for the record

## The problem

Moran does non-code work (brainstorm / discovery / design) on PM-owned
**features** from a workspace folder, driven by sprint-helper. Two gaps:

1. **A live session on a managed feature is INVISIBLE to the dashboard.** Focus
   is fed only from current-sprint work items (`getMyWorkItems(iteration.path)`
   → inProgress/upNext/done). A managed feature (e.g. #426639) isn't assigned to
   Moran and has no sprint stories, so it never enters that list. A
   `session_start` on it shows nowhere — not Focus, not "Needs you". This
   violates Moran's hard rule: **"a session is a session, I need to see it"**
   (ADHD anchor — every live session must be visible in one place). This is the
   same structural blind spot noted 2026-06-23 for previous-sprint sessions.

2. **No map of the design/discovery work.** Nothing shows which feature is
   active, its folder, or which features Moran is managing.

## The fix (two cohesive pieces)

### Piece 1 — out-of-sprint live sessions become visible (the important one)

Any live session whose work item is NOT in the current sprint is pulled into
the dashboard payload so Focus can show it beside sprint work.

- Server (`buildDashboard`): after building the sprint `items` list, collect
  live-session work-item ids (`listActiveSessions()`) that are NOT among the
  sprint items. Fetch those items best-effort (`getWorkItemsWithParents(ids,
  {errorPolicy:'omit'})` — same pattern the standup recap already uses), project
  each through the existing `projectWorkItem` (so it carries `activeSession`,
  `recentActivity`, etc. exactly like a sprint item), and expose them in a NEW
  payload field `liveOutsideSprint: DashboardWorkItem[]`.
- Client: merge `liveOutsideSprint` into the array Focus draws from
  (`allItems`). A live D&D session on #426639 now renders as a Focus panel.
- **Isolation:** these items reach Focus ONLY. They are NOT added to
  inProgress/upNext/done, NOT counted in sprint capacity/counts, NOT grouped
  into the Daily story list. Sprint math is untouched — this fixes visibility
  without polluting the sprint picture.

This generalizes cleanly: it fixes ALL out-of-sprint live sessions (managed
features AND the old previous-sprint blind spot), not just D&D. One honest fix.

### Piece 2 — the "Discovery & Design" rail card (the map)

A compact card on the Daily right rail (mirrors `RailNeedsYou`), shown only
when at least one workspace is registered.

```
DISCOVERY & DESIGN
 On now: **Declarative CD** (#426639)
 📁 426639-declarative-cd
 Managing (1): **Declarative CD** (#426639)
```

- **Active feature:** from the `active_feature` pointer (already in orient; here
  it needs to reach the dashboard payload — see below). `displayName` verbatim.
  When no active feature: "No feature open yet."
- **Folder:** the active feature's `folderPath` basename.
- **Managing:** the managed features (`managed_feature_ids`), fetched
  best-effort for titles, each as `**title** (#id)`. This card is the LEGITIMATE
  home for managed features — consistent with the earlier decision that empty
  managed features don't belong on the execution **board**. The board is for
  execution; this card is for the thinking work.

Payload additions for the card:
- `discovery: { activeFeature: { id, displayName, folderPath } | null;
  managed: { id, displayName }[]; hasWorkspace: boolean }`

## Naming

User-facing label is **"Discovery & Design"**. The folder concept and the MCP
tools (`workspace_*`) keep their existing internal names — only UI copy changes.
(Chosen over "Workspace" because that word already labels the mode-tab bar in
the code, and it doesn't say what the place is FOR.)

## Boundaries (what this is NOT)

- **Discovery & Design is thinking only — never implementation.** The label
  means exactly that.
- **NOT in this spec:** the future idea where pulling a story into a code repo
  makes sprint-helper surface the matching design notes from these folders.
  That's a separate feature. Noted, not built.
- **NO drafted-story scanning** in v1 (Moran chose the DB-only content). No
  reading feature folders from disk on dashboard refresh.
- **NOT its own mode/tab** in v1 — a rail card. It graduates to a mode later if
  it grows (folder browsing, drafted stories, implementation-matching).

## Version-skew safety

Both new payload fields (`liveOutsideSprint`, `discovery`) are OPTIONAL on the
client (`field?:`). A long-running dev server serving an old payload → the card
renders nothing and Focus behaves exactly as today. No crash. (Same rule that
saved the `needsYou` incident 2026-07-05.)

## Test coverage (pure functions, unit)

- Server: a pure helper `selectLiveOutsideSprint({ activeSessions,
  sprintItemIds, fetched })` → returns the out-of-sprint live items (skips ids
  already in the sprint, skips done-state, dedups). Unit-tested.
- Server: a pure helper `buildDiscoveryBlock({ activeFeature, managedIds,
  fetched, hasWorkspace })` → the card payload; displayName formatting,
  null-active, empty-managed. Unit-tested.
- MCP handler glue stays smoke-tested by Moran.
