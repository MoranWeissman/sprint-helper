# Bug creation + work-item type change — design

**Date:** 2026-06-18
**Status:** approved (the user, 2026-06-18)

## Problem

Two gaps a working session hit and could not resolve through sprint-helper:

1. **No way to create a Bug.** `createStory` is hardwired to the `User Story`
   type and `createTask` to `Task`. There is no path to create a Bug.
2. **No way to change a work item's type.** `workitem_edit` covers title,
   state, hours, effort, tags, and iteration — but not `System.WorkItemType`.
   Converting an existing item (e.g. a User Story that should be a Bug) is
   impossible from here.

The session worked around (1)/(2) by reaching for the Azure CLI, which the
project's rules forbid ("if a tool is missing, stop and tell the user"). The
fix is to close the gaps so no session is tempted to shell out.

## Scope

Two small, independent capabilities. Both reuse the existing Azure write path
(`getAdoClient().rest` with json-patch) — no new credentials, no `az`.

### Capability A — create a Bug

A new MCP tool `bug_create`, a twin of `story_create`.

- Same inputs as `story_create`: `title` (required), `effortHours` (required —
  the AI asks the user before calling), optional `description`, optional
  `parentFeatureId` (nest under a Feature/Epic), optional `tags`.
- Same defaults: assigned to the current user, placed in the current sprint.
- Same planning fields: writes `Microsoft.VSTS.Scheduling.Effort` and the
  derived `Microsoft.VSTS.Scheduling.StoryPoints` (1 point = 1 workday via
  `deriveStoryPoints`), exactly like a story.
- POSTs to the `$Bug` type endpoint instead of `$User%20Story`.
- Marked SH-created via `markSHCreated(id, 'story')` (the existing
  story-level marker; a Bug is a story-level item for grouping).

**Why a separate tool, not a `kind` switch on `story_create`:** clearer for the
model to select the right one, and the bug tool's description can carry
bug-specific guidance (e.g. Bugs have no Blocked state in this tenant — block
falls back to a tag). Cost accepted: a near-duplicate input schema.

**Implementation note (DRY):** the body of `createStory` and the new
`createBug` differ only in the POST type segment (`$User%20Story` vs `$Bug`).
Extract one shared internal helper that takes the type segment + a label for
the "no active sprint" error; `createStory` and `createBug` become thin
wrappers. `createTask` stays separate (different fields — OriginalEstimate /
RemainingWork, not Effort / StoryPoints).

### Capability B — change a work item's type

A new MCP tool `workitem_change_type`.

- Inputs: `workItemId` (required), `toType: 'story' | 'bug'` (required, enum).
- Flips an existing item between **User Story and Bug only**.
- PATCHes `/fields/System.WorkItemType` to `User Story` or `Bug`.

**Guards (server-side):**
- Read the item first. If its current type is neither `User Story` nor `Bug`
  (i.e. it's a Task / Feature / Epic), **refuse** with a plain message — those
  conversions change the item's meaning in the hierarchy and are out of scope.
- If the item is already the requested type, **refuse** as a no-op with a clear
  message (don't issue a pointless PATCH).
- On success, return the item's id, displayName, the new type, and its state
  after the change.

**Confirm-before:** type changes are visible to the delivery manager. The
tool's description instructs the AI to confirm with the user before calling —
the same convention `workitem_edit`'s title-rename already uses. (Enforced by
prose/tool-description, not code, consistent with how rename is handled.)

**State after conversion:** Story ↔ Bug share the common states this tenant
needs (New / Active / Closed), so Azure carries the state across. We do not
attempt to remap state ourselves in this first pass; if Azure rejects a
conversion because of a state mismatch, the error is surfaced verbatim.

## Data flow

```
bug_create (MCP)
  -> createBug(input)                [server/writes.ts]
       -> shared create helper, POST $Bug, json-patch
       -> returns { id, type, state, url, webUrl, parentId }
  -> markSHCreated(id, 'story'); invalidateDashboardCache()

workitem_change_type (MCP)
  -> read current type (getWorkItem)
  -> guard: type in {User Story, Bug}; not already toType
  -> changeWorkItemType(id, targetTypeName)   [server/writes.ts]
       -> PATCH /fields/System.WorkItemType, json-patch
       -> returns new { type, state }
  -> invalidateDashboardCache()
```

## Error handling

- `bug_create`: same failure surface as `story_create` — no active sprint
  throws a plain error; Azure field rejections bubble up via `errorResult`.
- `workitem_change_type`: refusals (wrong source type, no-op) return
  `errorResult` with a plain sentence. Azure rejections bubble up verbatim.

## Testing

Unit tests against the existing fake-Azure harness in `server/writes.test.ts`
(extend the fake to accept a `$Bug` create and a `System.WorkItemType` PATCH):

- `createBug` posts to the Bug type and writes Effort + derived StoryPoints +
  title + assignee + iteration; nests under a parent when given.
- `createStory` still behaves exactly as before (regression — proves the shared
  helper refactor didn't change story creation).
- `changeWorkItemType` updates the stored type for a User Story → Bug and the
  reverse.
- `workitem_change_type` guards: refuses a Task/Feature source; refuses a
  no-op (already the target type).

MCP handler wiring (`bug_create`, `workitem_change_type` registrations) is thin
glue and is **not** unit-tested — the user smoke-tests both after reloading the
MCP, per the project's testing convention. The smoke test is also where the one
open question gets answered.

## Open question (honest unknown)

Creating a Bug writes the same planning fields a story gets. Story Points are
safe. Whether this tenant's **Bug** type accepts `Microsoft.VSTS.Scheduling.Effort`
the same way a User Story does is process-dependent and unverified (the MCP was
disconnected at design time, so the live tenant could not be probed). If the
Bug type rejects Effort, the first real `bug_create` after reload surfaces it,
and the fix is to drop that one field from the bug patch. Recorded so it isn't
a surprise.

## Out of scope (YAGNI)

- Converting to/from Task, Feature, Epic.
- A "bug or story?" switch on `story_create`.
- Changing planning fields as part of a type conversion.
- Bug-specific state handling beyond what already exists (the Blocked-tag
  fallback for bugs is already in `server/writes.ts`).
