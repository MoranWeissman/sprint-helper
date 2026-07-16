# Active feature — one session, many feature folders

**Date:** 2026-07-16
**Status:** design, awaiting Moran's review

## The problem

Moran gets Azure DevOps **Features** handed to him that have no code repo — the
work is thinking: understand the feature, break it into stories, estimate,
design, discovery. He wants to do all of it from **one Claude Code session**
opened at his workspace root (`features/`), naming features as he goes:

> "let's work feature #426639" … later … "switch to feature #431000"

From that single session Claude must write each feature's design/discovery docs
into that feature's own subfolder, run BMAD's planning skills against it, and —
when Moran approves — push the agreed stories to Azure DevOps under the feature.

The risk this design exists to kill: in a long session (especially across a
`/compact`) Claude **loses track of which feature is active** and writes
feature A's work into feature B's folder, or pushes stories under the wrong
parent. The fix is to move that "which feature am I on" fact out of Claude's
fragile memory and into **sprint-helper state**, surfaced back to Claude on
every orient (including post-compact).

## What already exists (do NOT rebuild)

Verified in the current `main`:

- **`workspace_feature_folder`** (mcp/server.ts) — given a feature id + cwd,
  creates the feature's subfolder inside the workspace and records the feature
  as managed (so it shows on the board). Returns the folder path.
- **`createFeatureFolder` / `featureFolderName`** (server/workspace.ts) — the
  `<id>-<slug>` folder maker, idempotent.
- **Workspace registration + scaffold** (`workspace_set`, `ensureWorkspaceScaffold`)
  — BMAD + planning `CLAUDE.md` + enforcement hook land once at the workspace
  root, shared down the tree.
- **`story_create` with `parentFeatureId`** — the bridge to ADO already nests a
  new story under a Feature/Epic. `task_create`, `estimate_anchor`,
  `workitem_edit` round out board writes.
- **Seed workspace `CLAUDE.md`** — already mandates the BMAD flow, "board is
  ADO, go through sprint-helper", stories-under-the-feature, estimate-first.
So the feature→folder→ADO pipe is built. **The only missing piece is the
active-feature pointer and its survival across compaction.**

### Board visibility of managed features — DECISION 2026-07-16

A managed feature (PM-owned, not assigned to Moran) shows on the **Daily**
board ONLY when it has stories in the current sprint. An empty managed feature
(no sprint stories yet) does NOT appear on Daily — it's planning work, not
today's execution, and lives in the workspace (folder + active pointer) instead.

This means:
- The `managed-features-as-headers` branch (empty headers ON Daily) is
  **abandoned** — it does the opposite of this decision. Never merged; delete it.
- **No new board code is needed.** Once Moran pushes stories under a managed
  feature (`story_create` with `parentFeatureId`), those stories carry the
  feature as their parent, so the existing `groupByParent` shows the feature as
  a normal feature group automatically. The feature earns its Daily spot by
  having real sprint work, through code that already exists.
- The `managedFeatures` payload field + the `selectManagedFeatures` server code
  become unused for Daily rendering. Leave the state (`managed_feature_ids`,
  `getManagedFeatureIds`) — it still marks "features Moran is driving" for the
  workspace/active-feature layer — but the Daily board no longer reads it.
  (Cleanup of the now-dead payload field is a separate small pass, not this
  spec's job.)

## What's new

### 1. Active-feature state (the heart of it)

A single stored value per workspace: **which feature is currently active.**
Lives in the settings table, same pattern as `managed_feature_ids`. Not a
stack, not history — one active feature at a time (KISS; Moran works one thing
at a time and switches explicitly).

New in `server/workspace.ts`:

```ts
export const ACTIVE_FEATURE_KEY = 'active_feature';

export interface ActiveFeature {
  id: number;
  title: string;      // ADO title at the time it was set (for display + reminder)
  folderPath: string; // absolute path to the feature's folder
  setAt: string;      // ISO
}

export function getActiveFeature(): ActiveFeature | null;
export function setActiveFeature(f: ActiveFeature): void;   // overwrites
export function clearActiveFeature(): void;
```

Stored as a JSON object (not array), parsed defensively — garbage/unset →
`null`, never throws (mirrors `readJsonArray`). A malformed record must not
break orient.

### 2. `workspace_feature_folder` also sets the active feature

The tool that already makes the folder is exactly where "start work on this
feature" happens. Extend it: after creating the folder + marking managed, also
call `setActiveFeature({ id, title, folderPath, setAt })`. Its return value
gains `active: true` so Claude can confirm plainly ("You're now on **X** — its
folder is …").

No new "switch feature" tool needed: naming a different feature calls
`workspace_feature_folder` again, which overwrites the active pointer. That is
the switch. (A feature named a second time is idempotent on the folder and just
re-points active — fine.)

### 3. Clearing the active feature — derived, not declared

DECISION (Moran, 2026-07-16): there is **no manual "I'm done" tool.** The
active feature is a pointer that gets overwritten when Moran names the next
feature (via `workspace_feature_folder`). The only explicit clear is the safety
one: `clearActiveFeature()` exists as a primitive, but Claude only calls it if
Moran says something unambiguous like "nothing active right now." Normal
switching is overwrite, not clear-then-set.

The folder on disk is ALWAYS left alone, in every case.

### 4. Orient surfaces the active feature (compact survival)

`OrientPacket` gains:

```ts
/** The feature Moran is actively working in the workspace, or null. Lets a
 *  resumed/compacted session re-anchor on the right folder without guessing. */
activeFeature: {
  id: number;
  displayName: string;   // **title** (#id), pre-formatted — echo verbatim
  folderPath: string;
} | null;
```

`buildOrientPacket` reads `getActiveFeature()` and shapes this. When present,
the greeting reminds Claude which feature + folder it's on — the same way
`lastSession` reminds it of the last task. This is what makes "one long session"
safe: after a compact, orient re-establishes the anchor.

SERVER_INSTRUCTIONS gains a short block: when `activeFeature` is set, write
feature work into `folderPath`; when Moran names a different feature, call
`workspace_feature_folder` to move the anchor; never write feature docs to a
folder that isn't the active feature's without Moran saying so.

### 5. Workspace `CLAUDE.md` — teach the many-folders discipline

The seed `CLAUDE.md` already covers BMAD-first + ADO-through-sprint-helper. Add
one section: **"You work many features from one session."**

- The active feature is whatever sprint-helper's orient reports (or the last
  `workspace_feature_folder` call). Write design/discovery docs into THAT
  feature's folder, nowhere else.
- To switch features, Moran names one; you call `workspace_feature_folder`.
  Don't infer a switch from context — wait for him to name it.
- Stories are drafted as BMAD markdown in the feature folder FIRST. They become
  real ADO stories only when Moran says push/create — then `story_create` with
  `parentFeatureId = <the feature id>`.
- After creating each ADO story, write its new id back into the story's
  markdown (a `> ADO: #<id>` line) so folder and board stay linked.

## The end-to-end flow

1. Moran opens Claude once at `features/` (the workspace). Orient greets; if a
   feature was active before, it says so.
2. "let's work feature #426639" → `workspace_feature_folder`:
   folder `features/426639-declarative-cd/` created, feature marked managed +
   set active, board shows it. Claude confirms the folder.
3. Claude runs BMAD planning skills, writing brief/PRD/epics into that folder's
   `.bmad/output`. Discovery/design notes live there too.
4. Stories get drafted as markdown, with Moran in the loop (BMAD's interactive
   flow).
5. "push these to the board" → `story_create` per story, `parentFeatureId =
   426639`, each estimated (Moran confirms hours). New ADO ids written back into
   the markdown.
6. "switch to feature #431000" → `workspace_feature_folder` again; active
   pointer moves; step 3 repeats for the new folder.
7. `/compact` at any point → next orient re-reports the active feature; Claude
   re-anchors, no drift.

## Boundaries (what stays true)

- **ADO owns the truth.** Stories/estimates/state live in Azure DevOps.
  sprint-helper holds only context: which feature is active, where its folder
  is. The active-feature record is a pointer, not a second source of truth for
  the feature itself — its title is a display convenience, re-fetchable from ADO.
- **BMAD does the thinking.** We don't reimplement feature→story breakdown;
  BMAD's `bmad-create-epics-and-stories` / `bmad-sprint-planning` do it,
  interactively.
- **sprint-helper is the bridge.** It knows ADO (writes stories under the
  feature) and knows the workspace (folders, active pointer). That's its lane.

## Honest limitation

This leans on Claude following the workspace `CLAUDE.md` + orient reminder every
turn. The active-feature state makes drift *hard* (there's always a correct
answer to "which folder?"), but it's guidance, not a hard-locked gate — Claude
could still ignore it. A hard lock (e.g. refusing `story_create` unless a
feature is active) would be heavier than a solo workflow needs. The trade
chosen: strong state + strong instructions, no lock. If drift shows up in real
use, we revisit — same speed-bump-not-sign philosophy as the rest of the tool.

## Test coverage (unit, pure functions)

- `getActiveFeature` / `setActiveFeature` / `clearActiveFeature`: set→get
  round-trips; overwrite replaces; clear→null; malformed JSON → null (no throw);
  unset → null.
- `workspace_feature_folder` sets active as a side effect (handler-level or via
  extracting the state write into a pure helper the test can call).
- Orient: `activeFeature` present when set, null when cleared, `displayName`
  formatted `**title** (#id)`.
- `workspace_feature_folder` named twice with different ids: active pointer ends
  on the SECOND (overwrite is the switch).

MCP handler glue stays smoke-tested by Moran (per the project's testing note).
