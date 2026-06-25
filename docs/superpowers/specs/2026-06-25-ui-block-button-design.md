# UI Block / Unblock button — design

**Date:** 2026-06-25
**Status:** approved (design locked with Moran across prior sessions; see memory `feedback-block-is-state`)

## Problem

Moran hit a case where task **#426286** should have been Blocked but the dashboard
offered no way to do it. Blocking only existed through the MCP tools (`workitem_block` /
`workitem_unblock`), which need a chat. He wants a button in the dashboard "just in case
I want to do it from the UI."

## Decision

Add a one-click **Block / Unblock** button to the work item drawer header.

- **Drawer only.** Cards keep their existing blocked stripe; no per-card button (calm board).
- **One click, no reason prompt.** Moran chose this explicitly (after I pushed back twice).
  The UI block is the lightweight twin of the MCP tool: it does NOT write a session log
  entry or an ADO Discussion comment, because those carry the "why" and there is no "why"
  in the no-reason path.
- **No confirmation dialog.** Blocking is fully reversible with the same button, and Moran
  asked for one click. A `window.confirm` would contradict that.

## What the button does

The drawer already has the item's `type`, `state`, and `tags`, so it can decide everything
client-side.

**Visibility:** the button renders only when `type` is `Task` or `User Story`. It is hidden
for `Bug`, `Feature`, and `Epic`.

- Reason: blocking flips the item to its ADO **Blocked** state. Only Task and User Story
  have a Blocked state in Moran's tenant. A Bug has none — `transitionToBlocked` would throw
  for it (verified in `server/writes.ts`: `setStateBucket(id, 'blocked')` exhausts the chain
  and throws). So the button stays hidden where it cannot work. (This corrects an earlier
  note that claimed bugs had a working tag fallback — they do not.)

**Label / mode:** the item is considered blocked when `isBlockedState(state)` is true OR the
`Blocked` tag is present (same rule the cards already use). Blocked → button reads **Unblock**.
Not blocked → button reads **Block**.

**On Block:** `POST /api/workitem/<id>/block`
1. `transitionToBlocked(id)` — flips state to Blocked, saves the prior state.
2. `updateTags(id, { add: ['Blocked'] })` — adds the redundant tag so an item blocked from
   the drawer looks identical on the board to one blocked from chat.
3. `invalidateDashboardCache()`.

**On Unblock:** `POST /api/workitem/<id>/unblock`
1. `transitionFromBlocked(id)` — restores the prior state (falls back to the "going" bucket).
2. `updateTags(id, { remove: ['Blocked'] })`.
3. `invalidateDashboardCache()`.

Both return `{ state: <new ADO state string> }`. After the call the drawer refreshes itself
(its existing `refresh()`), so the State pill and button mode update from fresh ADO data.

## Why no story↔task propagation

Blocking a story does not auto-block its tasks, and vice-versa. Moran didn't ask for it, and
it would be a silent multi-item write. Out of scope.

## Architecture

```
WorkItemDrawer (header)
  └─ Block/Unblock button  ──click──▶  postBlock(id) / postUnblock(id)   [src/lib/api.ts]
                                              │
                                              ▼
                              POST /api/workitem/<id>/block|unblock        [vite.config.ts]
                                              │
                          transitionToBlocked / transitionFromBlocked      [server/writes.ts]
                          + updateTags                                     [server/writes.ts]
                          + invalidateDashboardCache                       [server/dashboard-cache.ts]
                                              │
                                              ▼
                              drawer.refresh()  →  re-reads /api/workitem/<id>
```

The new route slots into the **existing** `/api/workitem/` middleware. The path regex grows
from `/^\/(\d+)(\/edit)?/` to also recognize `block` and `unblock` action segments.

## Files

- `vite.config.ts` — extend the `/api/workitem/` handler: match `block` / `unblock`, POST-only,
  call the writes fns + tag update + cache invalidate, return `{ state }`.
- `src/lib/api.ts` — `postWorkItemBlock(id)` / `postWorkItemUnblock(id)` helpers.
- `src/components/WorkItemDrawer.tsx` — a `BlockButton` in the header (between refresh and
  close), shown only for Task/User Story, with its own pending + error state, calling the
  helper then `refresh()`.
- `src/styles/dashboard.css` — minimal styling reusing existing drawer-header button shapes
  and the blocked color tokens already in `:root`.
- `server/writes.test.ts` — guard test: `transitionToBlocked` throws for a type with no Blocked
  state (documents why the button is Task/Story only). The transition fns themselves are already
  covered.

## Error handling

- Route: per the existing pattern — 405 for non-POST, 400 for a non-numeric id, 500 with the
  error message on a write failure.
- Drawer: the button disables and shows a pending state during the call; on failure it shows a
  short inline message in the header and re-enables, leaving the item unchanged.

## Testing

- Unit: the `writes.test.ts` guard above (Vitest). The route is inline glue in `vite.config.ts`
  (not unit-tested in this repo, by the same convention as `/api/carry-forward`) → covered by
  Moran's live smoke.
- Live smoke (Moran, after dashboard restart): open a Task drawer → click **Block** → State pill
  reads Blocked, button flips to **Unblock**, card shows the blocked stripe. Click **Unblock** →
  returns to the prior state. Repeat on a User Story. Confirm no button appears on a Bug/Feature.
```
