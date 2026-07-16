# Active Feature — One Session, Many Feature Folders — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let Moran work many ADO features from one workspace session, with sprint-helper holding an "active feature" pointer that survives compaction (surfaced via orient) so the session always knows which feature folder to write into.

**Architecture:** A single settings-backed record (`active_feature`, JSON object) in `server/workspace.ts`, set as a side effect of the existing `workspace_feature_folder` MCP tool and read by `buildOrientPacket`. The Daily board stops rendering the separate "managed features" box (dead per the spec decision); empty managed features no longer appear, and features earn a Daily spot only through the existing `groupByParent` once they have real sprint stories. The workspace `CLAUDE.md` seed gains a "many features, one session" section. No new persistence layer, no new dependency.

**Tech Stack:** TypeScript, @modelcontextprotocol/sdk, better-sqlite3 (settings table via `./timers`), Vitest, React/Vite front end.

## Global Constraints

- **Plain English to Moran, always.** Any user-facing string (tool descriptions returned to the model, orient fields, CLAUDE.md copy) avoids the banned words: "slack" (spare hours), "cleanup moves", "pending decisions", "outstanding items", "open threads", "burndown", "scope" (noun), "velocity", "throughput", "WIP", "in-flight items", "work item", "blockers" (collective).
- **Names before numbers.** Any pre-formatted work item reference is `**<title>** (#<id>)` — bold title first, id in parens after. Orient's `activeFeature.displayName` MUST be built this way.
- **ADO owns the truth.** The active-feature record is a POINTER (id, title-for-display, folderPath, setAt) — not a second source of truth for the feature. Its title is a display convenience, re-fetchable from ADO. Never treat it as authoritative over ADO state.
- **Settings state parsed defensively.** Every read of a settings JSON value must survive garbage/unset/malformed input by returning a safe empty value (`null` for the object), never throwing — mirror the existing `readJsonArray` pattern in `server/workspace.ts`.
- **Overwrite is the switch.** There is no manual "done with a feature" flow in normal use. Naming a new feature overwrites the active pointer. `clearActiveFeature()` exists only as a primitive for an explicit "nothing active" request.
- **Folders are never deleted.** Nothing in this work removes a feature folder from disk, ever.
- **KISS / DRY / YAGNI.** One active feature at a time (not a stack/history). Reuse existing helpers (`readJsonArray` sibling, `expandHome`, `createFeatureFolder`, `addManagedFeatureId`). No speculative fields.
- **MCP handler glue is smoke-tested by Moran**, not unit-tested — put real logic in pure functions in `server/workspace.ts` and test those. (Per the project's testing note.)

---

### Task 1: Active-feature state in `server/workspace.ts`

**Files:**
- Modify: `server/workspace.ts` (add after the managed-feature-id block, ~line 93)
- Test: `server/workspace.test.ts` (add a new `describe('active feature')` block)

**Interfaces:**
- Consumes: `getSetting`, `setSetting` from `./timers` (already imported).
- Produces:
  - `export const ACTIVE_FEATURE_KEY = 'active_feature'`
  - `export interface ActiveFeature { id: number; title: string; folderPath: string; setAt: string }`
  - `export function getActiveFeature(): ActiveFeature | null`
  - `export function setActiveFeature(f: ActiveFeature): void`
  - `export function clearActiveFeature(): void`

- [ ] **Step 1: Write the failing tests**

Add to `server/workspace.test.ts`. First extend the import from `./workspace` to include the new symbols:

```ts
import {
  getWorkspaces, isKnownWorkspace, isDeclinedPath, declineWorkspace,
  getManagedFeatureIds, addManagedFeatureId, removeManagedFeatureId,
  WORKSPACE_PATHS_KEY, MANAGED_FEATURES_KEY,
  featureFolderName, createFeatureFolder,
  registerWorkspace, ensureWorkspaceScaffold, SEED_KEY,
  getActiveFeature, setActiveFeature, clearActiveFeature, ACTIVE_FEATURE_KEY,
} from './workspace';
```

Then add the block:

```ts
describe('active feature', () => {
  const sample = {
    id: 426639,
    title: 'Declarative CD',
    folderPath: '/w/space/426639-declarative-cd',
    setAt: '2026-07-16T10:00:00.000Z',
  };

  it('returns null when unset', () => {
    expect(getActiveFeature()).toBeNull();
  });

  it('set then get round-trips the record', () => {
    setActiveFeature(sample);
    expect(getActiveFeature()).toEqual(sample);
  });

  it('set overwrites the previous active feature (overwrite is the switch)', () => {
    setActiveFeature(sample);
    const next = { id: 431000, title: 'Other', folderPath: '/w/space/431000-other', setAt: '2026-07-16T11:00:00.000Z' };
    setActiveFeature(next);
    expect(getActiveFeature()).toEqual(next);
  });

  it('clear resets to null', () => {
    setActiveFeature(sample);
    clearActiveFeature();
    expect(getActiveFeature()).toBeNull();
  });

  it('parses garbage as null (never throws)', () => {
    store.set(ACTIVE_FEATURE_KEY, '{not json');
    expect(getActiveFeature()).toBeNull();
  });

  it('parses a non-object / wrong-shape value as null', () => {
    store.set(ACTIVE_FEATURE_KEY, JSON.stringify([1, 2, 3]));
    expect(getActiveFeature()).toBeNull();
    store.set(ACTIVE_FEATURE_KEY, JSON.stringify({ id: 'nope', title: 5 }));
    expect(getActiveFeature()).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run server/workspace.test.ts`
Expected: FAIL — `getActiveFeature`/`setActiveFeature`/`clearActiveFeature`/`ACTIVE_FEATURE_KEY` are not exported.

- [ ] **Step 3: Implement the state functions**

In `server/workspace.ts`, add after the `removeManagedFeatureId` function (~line 93):

```ts
export const ACTIVE_FEATURE_KEY = 'active_feature';

/** The feature Moran is actively working in the workspace right now. A pointer,
 *  not a source of truth — the title is a display convenience (ADO owns the
 *  real feature). Overwritten when he names the next feature; that's the switch. */
export interface ActiveFeature {
  id: number;
  title: string;
  folderPath: string;
  setAt: string;
}

function isActiveFeature(v: unknown): v is ActiveFeature {
  if (v == null || typeof v !== 'object' || Array.isArray(v)) return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.id === 'number' && Number.isFinite(o.id) &&
    typeof o.title === 'string' &&
    typeof o.folderPath === 'string' &&
    typeof o.setAt === 'string'
  );
}

/** The active feature, or null when unset/malformed. Never throws. */
export function getActiveFeature(): ActiveFeature | null {
  const raw = getSetting(ACTIVE_FEATURE_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return isActiveFeature(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function setActiveFeature(f: ActiveFeature): void {
  setSetting(ACTIVE_FEATURE_KEY, JSON.stringify(f));
}

export function clearActiveFeature(): void {
  setSetting(ACTIVE_FEATURE_KEY, JSON.stringify(null));
}
```

Note: `clearActiveFeature` writes the JSON string `"null"`; `getActiveFeature` then parses `null`, which `isActiveFeature` rejects → returns `null`. (Writing a literal empty removes ambiguity vs an unset key, and `getSetting` returning that string is falsy-safe because `JSON.parse('null')` is `null`.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run server/workspace.test.ts`
Expected: PASS (all existing + 6 new).

- [ ] **Step 5: Commit**

```bash
git add server/workspace.ts server/workspace.test.ts
git commit -m "feat(workspace): active-feature pointer state (get/set/clear)"
```

---

### Task 2: `workspace_feature_folder` sets the active feature

**Files:**
- Modify: `mcp/server.ts` (the `workspace_feature_folder` handler, ~line 2710–2736; and its import block ~line 65–73)

**Interfaces:**
- Consumes: `setActiveFeature`, `ActiveFeature` from `../server/workspace.js`; existing `createFeatureFolder`, `addManagedFeatureId`, `getWorkspaces`, `isKnownWorkspace`, `getWorkItem`.
- Produces: the tool's JSON result gains `active: true` and echoes `featureTitle`. No signature change (still `{ workItemId, cwd }`).

This is MCP glue (smoke-tested by Moran), so no unit test — but keep the state write to the pure `setActiveFeature` already covered by Task 1.

- [ ] **Step 1: Add the import**

In `mcp/server.ts`, the existing import from `../server/workspace.js` includes `createFeatureFolder, addManagedFeatureId` (~lines 71–72). Add `setActiveFeature` to that same import list.

- [ ] **Step 2: Set active feature in the handler**

In the `workspace_feature_folder` handler, after `addManagedFeatureId(workItemId);` and before the `return`, add:

```ts
      setActiveFeature({
        id: workItemId,
        title: title || `#${workItemId}`,
        folderPath: folder.path,
        setAt: new Date().toISOString(),
      });
```

Change the return to signal it's now active:

```ts
      return jsonResult({ ...folder, featureTitle: title || null, active: true });
```

- [ ] **Step 3: Update the tool description**

Update the `workspace_feature_folder` description string so the model knows this call also sets the active feature (drives orient re-anchoring). Replace the existing description with:

```
"Fire when Moran names a feature to start non-code work on ('let's work on feature #NNNNNN'). Reads the feature title, creates a subfolder for it inside his workspace, records the feature as one he's driving, AND marks it the ACTIVE feature (so a resumed or compacted session re-anchors on the right folder via orient). Naming a different feature later just calls this again — that overwrites the active feature; that's how he switches. Returns the folder path — write discovery/design docs there. Moran stays in the workspace root chat."
```

- [ ] **Step 4: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add mcp/server.ts
git commit -m "feat(workspace): starting a feature marks it the active feature"
```

---

### Task 3: Orient surfaces the active feature

**Files:**
- Modify: `server/orient.ts` (add a pure `activeFeatureField` helper; extend `OrientPacket` ~line 89–141; wire it into `buildOrientPacket`'s return ~line 340)
- Test: `server/orient.test.ts` (unit-test the pure helper — the file tests pure functions only, e.g. `repoHintFor`; it does NOT call `buildOrientPacket` and does NOT mock the DB/ADO layer. Match that: test the helper, not the whole builder.)

**Interfaces:**
- Consumes: `getActiveFeature`, `type ActiveFeature` from `./workspace`; the existing `displayNameFor` in orient.ts.
- Produces:
  - `export function activeFeatureField(af: ActiveFeature | null): { id: number; displayName: string; folderPath: string } | null`
  - `OrientPacket.activeFeature: { id: number; displayName: string; folderPath: string } | null`

WHY a helper: `buildOrientPacket` touches the DB, ADO, and sessions; unit-testing the full packet would mean mocking the whole world, which this test file deliberately avoids. A pure mapping helper keeps the testable logic (names-before-numbers formatting, null handling) out of the un-tested glue — same split as `repoHintFor`/`sessionReminderFor`.

- [ ] **Step 1: Write the failing test**

Add to `server/orient.test.ts`. Extend the import to include `activeFeatureField`:

```ts
import { repoHintFor, sessionReminderFor, activeFeatureField } from './orient';
```

Then add:

```ts
describe('activeFeatureField', () => {
  it('maps a record to a names-before-numbers displayName', () => {
    expect(activeFeatureField({
      id: 426639,
      title: 'Declarative CD',
      folderPath: '/w/space/426639-declarative-cd',
      setAt: '2026-07-16T10:00:00.000Z',
    })).toEqual({
      id: 426639,
      displayName: '**Declarative CD** (#426639)',
      folderPath: '/w/space/426639-declarative-cd',
    });
  });

  it('returns null when there is no active feature', () => {
    expect(activeFeatureField(null)).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run server/orient.test.ts`
Expected: FAIL — `activeFeatureField` is not exported.

- [ ] **Step 3: Add the field to the interface**

In `server/orient.ts`, add to `OrientPacket` (after `planningHome`, ~line 140):

```ts
  /**
   * The feature Moran is actively working in his workspace, or null. Lets a
   * resumed/compacted session re-anchor on the right feature folder without
   * guessing. displayName is pre-formatted `**title** (#id)` — echo verbatim.
   */
  activeFeature: {
    id: number;
    displayName: string;
    folderPath: string;
  } | null;
```

- [ ] **Step 4: Implement the pure helper**

Add the import at the top of `server/orient.ts`:

```ts
import { getActiveFeature, type ActiveFeature } from './workspace';
```

Add the helper near `repoHintFor` (~line 178):

```ts
/** Map the stored active feature to orient's packet field. Pure so it's unit
 *  tested; buildOrientPacket just calls getActiveFeature() and passes it here. */
export function activeFeatureField(
  af: ActiveFeature | null,
): { id: number; displayName: string; folderPath: string } | null {
  if (!af) return null;
  return { id: af.id, displayName: displayNameFor(af.id, af.title), folderPath: af.folderPath };
}
```

- [ ] **Step 5: Wire it into `buildOrientPacket`**

Before the return object in `buildOrientPacket`, compute:

```ts
  const activeFeature = activeFeatureField(getActiveFeature());
```

Add `activeFeature,` to the returned object (alongside `planningHome`).

- [ ] **Step 6: Run tests + typecheck**

Run: `npx vitest run server/orient.test.ts && npx tsc --noEmit`
Expected: PASS; tsc clean.

- [ ] **Step 7: Commit**

```bash
git add server/orient.ts server/orient.test.ts
git commit -m "feat(orient): report the active feature so a resumed session re-anchors"
```

---

### Task 4: Teach orient's greeting to use the active feature (SERVER_INSTRUCTIONS)

**Files:**
- Modify: `mcp/server.ts` (the WORKSPACE block of SERVER_INSTRUCTIONS, ~line 353–378)

Prose only — no code, no test. This is the instruction layer that tells the model how to use `orient.activeFeature`.

- [ ] **Step 1: Add active-feature guidance to the WORKSPACE block**

In the WORKSPACE section of SERVER_INSTRUCTIONS, after the "START A FEATURE" bullet, add these bullets (keep the backtick-escaping style of the surrounding template literal, plain English, no banned words):

```
  - ACTIVE FEATURE: orient returns \`activeFeature\` — the feature Moran is
    working in his workspace right now (or null). When it's set, write his
    discovery/design docs into that feature's \`folderPath\`, and nowhere else.
    After a compact or on resume, this is how you know which folder you're in —
    trust it over your own memory. In your greeting, if \`activeFeature\` is set,
    tell him which feature he's on (echo its \`displayName\` verbatim).
  - SWITCHING: only Moran decides to switch features. When he names a different
    feature, call \`workspace_feature_folder\` for it — that moves the active
    feature. Never infer a switch from context; wait for him to name one.
  - DON'T write feature docs into a folder that isn't the active feature's
    unless Moran explicitly says so.
```

- [ ] **Step 2: Verify the template literal still compiles**

Run: `npx tsc --noEmit`
Expected: no errors (watch for an unescaped backtick or `${` breaking the literal).

- [ ] **Step 3: Commit**

```bash
git add mcp/server.ts
git commit -m "docs(server-instructions): use orient.activeFeature to anchor feature work"
```

---

### Task 5: Workspace CLAUDE.md — "many features, one session"

**Files:**
- Modify: `/Users/weissmmo/projects/github-moran/features/CLAUDE.md` (the seed workspace CLAUDE.md — the one copied into every workspace)

This is the standing instruction any workspace session reads. Not a repo file, not covered by tests — verify by reading it back.

- [ ] **Step 1: Add the section**

Append to `/Users/weissmmo/projects/github-moran/features/CLAUDE.md`, after the "Where the thinking is kept" section, a new section (plain English, no banned words, no code):

```markdown
## You work many features from one session

You are opened once, at the workspace root. From this one session you work
whichever feature the user names — you do not restart Claude per feature.

- **The active feature comes from sprint-helper, not your memory.** When you
  orient, sprint-helper tells you the active feature and its folder. Write all
  discovery and design docs for that feature into that folder. After a compact,
  re-check orient — it re-establishes which feature you're on.
- **Switching features is the user's call.** When the user names a different
  feature, that's the switch: sprint-helper records the new active feature and
  its folder. Don't guess a switch from the conversation — wait for the user to
  name one.
- **Stories are drafted here first, then pushed to the board.** Break the
  feature into stories as BMAD markdown in the feature's folder. They become
  real Azure DevOps stories only when the user says to push them — created under
  the feature through sprint-helper. After each story is created on the board,
  write its new id back into the story's markdown (a `> ADO: #<id>` line) so the
  folder and the board stay linked.
```

- [ ] **Step 2: Verify**

Read the file back; confirm the section is present, reads plainly, and contains no banned words.

- [ ] **Step 3: (No commit — this file is outside the sprint-helper repo.)**

Note for the implementer: `/Users/weissmmo/projects/github-moran/features/` is the seed folder, NOT part of the sprint-helper git repo. Do not attempt to `git add` it. Just edit and verify. (If the workspace was already scaffolded before this change, the copied CLAUDE.md in an existing workspace won't auto-update — that's acceptable; note it in the task report so Moran knows a re-scaffold or manual copy refreshes it.)

---

### Task 6: Daily board stops rendering the managed-features box

**Files:**
- Modify: `src/components/Dashboard.tsx` (remove the `<section className="r21-managed">` block, ~line 1445–1472)
- Modify: `src/styles/dashboard.css` (remove the `.r21-managed*` CSS block, ~line 4924–4986)
- Modify: `src/lib/api.ts` (remove `ApiManagedFeature` and the `managedFeatures?` payload field)
- Modify: `server/dashboard.ts` (remove `ManagedFeature`, `selectManagedFeatures`, `MANAGED_CLOSED_STATES`, the `managedFeatures` payload field + its build block + the empty-payload `managedFeatures: []`, and the now-unused `getManagedFeatureIds` import)
- Delete: `server/dashboard-managed.test.ts` (tests only `selectManagedFeatures`, which is being removed)
- Keep untouched: `getManagedFeatureIds` / `addManagedFeatureId` / `removeManagedFeatureId` in `server/workspace.ts` (still used by the workspace layer)

**Interfaces:**
- Consumes: nothing new.
- Produces: `DashboardPayload` and `ApiPayload` no longer carry `managedFeatures`. The Daily board renders features only via the existing `featureGroups` (from `userStories`).

Rationale (from the spec): an empty managed feature must NOT appear on Daily. Once a managed feature has real sprint stories, `groupByParent` already surfaces it as a normal feature group (the stories carry it as their parent via `story_create`'s `parentFeatureId`). So the box + payload field are dead code.

- [ ] **Step 1: Remove the client render + CSS**

In `src/components/Dashboard.tsx`, delete the entire `{data.managedFeatures && data.managedFeatures.length > 0 && ( ... )}` section (the `<section className="r21-managed">…</section>` block). Leave the surrounding standup/carry-forward JSX and the `stories.length === 0 ? …` block exactly as they were BEFORE the abandoned branch (i.e. the empty check is `stories.length === 0`, not `stories.length === 0 && featureGroups.length === 0` — that variant was part of the abandoned branch and is not on main).

In `src/styles/dashboard.css`, delete the `/* === Managed features section === */` comment and all `.r21-managed*` rules (`.r21-managed`, `-head`, `-sub`, `-list`, `-row`, `-row:hover`, `-row:focus-visible`, `-title`, `-meta`).

- [ ] **Step 2: Remove the client type**

In `src/lib/api.ts`, delete the `ApiManagedFeature` interface and the `managedFeatures?: ApiManagedFeature[];` line from `ApiPayload`.

- [ ] **Step 3: Remove the server production**

In `server/dashboard.ts`:
- Delete `import { getManagedFeatureIds } from './workspace';` (the ONLY use of it here is being removed — verify with a grep first; if anything else in the file uses it, keep the import).
- Delete the `ManagedFeature` interface, the `MANAGED_CLOSED_STATES` const, and the `selectManagedFeatures` function.
- Delete `managedFeatures: ManagedFeature[];` from `DashboardPayload`.
- Delete the `managedFeatures: [],` line from the no-sprint early-return payload.
- Delete the "Managed features (PM-owned…)" best-effort build block (`let managedFeatures … try { … } catch { … }`) and the `managedFeatures,` line in the final return object.

- [ ] **Step 4: Delete the dead test**

```bash
git rm server/dashboard-managed.test.ts
```

- [ ] **Step 5: Typecheck + full suite**

Run: `npx tsc --noEmit && npm test`
Expected: tsc clean; all tests pass (the removed test's 3 cases drop from the count; everything else green).

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "refactor(daily): drop managed-features box; features surface via sprint stories

An empty managed feature must not clutter Daily. Once a managed feature has
real sprint stories they carry it as their parent, so groupByParent shows it
as a normal feature group — no dedicated box needed. Removes the now-dead
payload field, server selector, client type, and CSS. Workspace-layer
managed-id state is kept (used by the active-feature flow)."
```

---

### Task 7: Update project memory

**Files:**
- Modify: `/Users/weissmmo/.claude/projects/-Users-weissmmo-projects-github-moran-sprint-helper/memory/project_build_state.md`
- Modify (if present): a workspace/feature memory file, or add a note under build state

Not code — keep the durable record honest for the next session.

- [ ] **Step 1: Record what shipped**

Update `project_build_state.md`: the active-feature pointer + orient re-anchoring shipped; the managed-features Daily box was removed (empty features stay off Daily; they surface via sprint stories through existing grouping); the abandoned `managed-features-as-headers` branch was deleted. Note the pending Moran smoke: MCP reload, then name a feature in a workspace chat, compact, and confirm orient's greeting re-states the active feature + folder.

- [ ] **Step 2: (No commit — memory lives outside the repo.)**

---

## Notes for the executor

- **Task ordering:** Tasks 1→2→3→4 are the core and build on each other. Task 5 (CLAUDE.md) and Task 6 (Daily cleanup) are independent of 1–4 and of each other — either can go in any order. Task 7 is last.
- **Branch:** do this on a feature branch off `main` (e.g. `active-feature-single-session`), not on `main` directly. `main` is never pushed (Moran's standing call) — merge locally when done, same as prior work.
- **Do NOT** re-introduce the empty-feature-header behavior from the abandoned branch. If you find `featureGroups` injecting managed features, or `stories.length === 0 && featureGroups.length === 0`, that's the abandoned branch's code — it is not supposed to be on main; stop and check `git log`.
- **Verification before completion:** `npx tsc --noEmit` and `npm test` both clean before finishing the branch.
