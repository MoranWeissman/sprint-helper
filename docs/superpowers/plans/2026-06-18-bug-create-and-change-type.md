# Bug creation + work-item type change — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let sprint-helper create Bug work items and flip an existing item between User Story and Bug, so sessions never need the Azure CLI for these.

**Architecture:** Two new functions in `server/writes.ts` reusing the existing Azure write path (`getAdoClient().rest` with json-patch). `createStory`/`createBug` share one internal helper that differs only by the POST type segment. `changeWorkItemType` reads the current type, enforces Story↔Bug-only guards, then PATCHes `System.WorkItemType`. Two thin MCP tools wire them up. Unit-tested against the in-memory fake-Azure harness in `server/writes.test.ts`.

**Tech Stack:** TypeScript, @modelcontextprotocol/sdk, zod, Vitest 4. Azure DevOps REST 7.1 via the project's `getAdoClient()` abstraction.

**Spec:** `docs/superpowers/specs/2026-06-18-bug-create-and-change-type-design.md`

---

### Task 1: Teach the fake-Azure harness to create work items (POST)

The fake `handleAz` in `server/writes.test.ts` only answers GET and PATCH (by numeric id). Creation POSTs to `…/workitems/$Bug` (no numeric id), so it isn't handled. Add POST support and lock it down with the first-ever test of `createStory`.

**Files:**
- Modify: `server/writes.test.ts` (the `handleAz` fn ~lines 45-75; the imports block ~lines 110-119)

- [ ] **Step 1: Write the failing test**

Add to the import block at `server/writes.test.ts:110-119` (alongside the existing names):

```ts
import {
  pushCompletedWork,
  setStateBucket,
  transitionToBlocked,
  transitionFromBlocked,
  setEffortWithDerivedPoints,
  setIterationPath,
  setTitle,
  backfillEstimateIfBlank,
  createStory,
} from './writes';
```

Append a new describe block at the end of `server/writes.test.ts`:

```ts
describe('createStory — posts a User Story with planning fields', () => {
  it('creates with title, assignee, sprint, Effort and derived StoryPoints', async () => {
    const created = await createStory({ title: 'A story', effortHours: 9 });
    expect(created.type).toBe('User Story');
    const f = fieldsOf(created.id);
    expect(f[F.title]).toBe('A story');
    expect(f[F.effort]).toBe(9);
    expect(f[F.points]).toBe(1); // 9h / 9h workday = 1 point
    expect(f['System.AssignedTo']).toBe('moran@example.com');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run server/writes.test.ts -t "createStory — posts"`
Expected: FAIL — the fake throws `fake az: unexpected method POST` (POST isn't handled yet).

- [ ] **Step 3: Add POST handling to the fake**

In `server/writes.test.ts`, add a module-level id counter just below `const ACCEPTED_STATES = …` (~line 43):

```ts
let nextCreatedId = 1000;
```

Then, inside `handleAz`, add a POST branch as the FIRST method check (before the `GET` block at ~line 50), because a create URI has no numeric id to parse:

```ts
  if (method === 'POST') {
    const patch = JSON.parse(body) as Array<{ op: string; path: string; value?: unknown }>;
    const typeSeg = uri.match(/\/workitems\/\$([^?]+)/i)?.[1] ?? 'Unknown';
    const witType = decodeURIComponent(typeSeg); // '$User%20Story' -> 'User Story'
    const newId = ++nextCreatedId;
    const fields: Record<string, unknown> = {
      'System.WorkItemType': witType,
      'System.State': 'New',
    };
    for (const p of patch) {
      if (p.path.startsWith('/fields/')) fields[p.path.replace('/fields/', '')] = p.value;
      // '/relations/-' (parent links) are not asserted by these tests — ignore.
    }
    h.store.set(newId, { rev: 1, fields });
    return JSON.stringify({
      id: newId,
      fields,
      url: `https://dev.azure.com/org/_apis/wit/workItems/${newId}`,
      _links: { html: { href: `https://dev.azure.com/org/_workitems/edit/${newId}` } },
    });
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run server/writes.test.ts -t "createStory — posts"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/writes.test.ts
git commit -m "test: fake-Azure harness handles work-item creation (POST)"
```

---

### Task 2: Extract a shared create helper and add `createBug`

`createStory` and a new `createBug` differ only by the POST type segment. Extract one internal helper; both become thin wrappers. Keep `createStory`'s public signature and return shape identical (the Task 1 test guards against regressions).

**Files:**
- Modify: `server/writes.ts` (`createStory` at lines 668-730)
- Test: `server/writes.test.ts`

- [ ] **Step 1: Write the failing test**

Add `createBug` to the import block in `server/writes.test.ts`:

```ts
import {
  pushCompletedWork,
  setStateBucket,
  transitionToBlocked,
  transitionFromBlocked,
  setEffortWithDerivedPoints,
  setIterationPath,
  setTitle,
  backfillEstimateIfBlank,
  createStory,
  createBug,
} from './writes';
```

Append:

```ts
describe('createBug — posts a Bug with the same planning fields as a story', () => {
  it('creates a Bug carrying Effort + derived StoryPoints', async () => {
    const created = await createBug({ title: 'A bug', effortHours: 18 });
    expect(created.type).toBe('Bug');
    const f = fieldsOf(created.id);
    expect(f[F.type]).toBe('Bug');
    expect(f[F.title]).toBe('A bug');
    expect(f[F.effort]).toBe(18);
    expect(f[F.points]).toBe(2); // 18h / 9h = 2 points
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run server/writes.test.ts -t "createBug"`
Expected: FAIL — `createBug is not a function` (not exported yet).

- [ ] **Step 3: Refactor `createStory` to a shared helper and add `createBug`**

In `server/writes.ts`, replace the whole `createStory` function body (lines 668-730) with the helper plus two wrappers:

```ts
/**
 * Shared creator for the two story-level item types sprint-helper makes:
 * User Story and Bug. They differ only by the POST type segment and the noun
 * in the "no active sprint" error — everything else (assignee, current sprint,
 * Effort + derived StoryPoints, optional description / tags / parent link) is
 * identical. `createTask` stays separate: tasks carry OriginalEstimate /
 * RemainingWork, not Effort / StoryPoints.
 */
async function createStoryLevel(
  typeSegment: string,
  noun: string,
  input: CreateStoryInput,
): Promise<CreatedStory> {
  const cfg = await loadAdoConfig();
  const iteration = await getCurrentIterationPath();
  if (!iteration) throw new Error(`No active sprint found — cannot place new ${noun}.`);

  const workday = getWorkdayHours();
  const derivedPoints = deriveStoryPoints(input.effortHours, workday);
  const patch: Array<Record<string, unknown>> = [
    { op: 'add', path: '/fields/System.Title', value: input.title },
    { op: 'add', path: '/fields/System.AssignedTo', value: cfg.user },
    { op: 'add', path: '/fields/System.IterationPath', value: iteration },
    { op: 'add', path: '/fields/Microsoft.VSTS.Scheduling.Effort', value: round2(input.effortHours) },
    { op: 'add', path: '/fields/Microsoft.VSTS.Scheduling.StoryPoints', value: round2(derivedPoints) },
  ];
  if (input.description) {
    patch.push({ op: 'add', path: '/fields/System.Description', value: escapeHtml(input.description) });
  }
  if (input.tags && input.tags.length > 0) {
    patch.push({ op: 'add', path: '/fields/System.Tags', value: input.tags.join('; ') });
  }
  if (input.parentFeatureId) {
    patch.push({
      op: 'add',
      path: '/relations/-',
      value: {
        rel: 'System.LinkTypes.Hierarchy-Reverse',
        url: `${cfg.organization}/_apis/wit/workItems/${input.parentFeatureId}`,
      },
    });
  }

  const uri = `${cfg.organization}/${encodeURIComponent(cfg.project)}/_apis/wit/workitems/${typeSegment}?api-version=7.1`;
  const created = await getAdoClient().rest<{
    id: number;
    fields: { 'System.Title': string; 'System.WorkItemType': string; 'System.State': string };
    url: string;
    _links?: { html?: { href?: string } };
  }>({ method: 'POST', uri, body: patch, contentKind: 'json-patch' });

  return {
    id: created.id,
    title: created.fields['System.Title'],
    type: created.fields['System.WorkItemType'],
    state: created.fields['System.State'],
    url: created.url,
    webUrl:
      created._links?.html?.href ??
      `${cfg.organization}/${encodeURIComponent(cfg.project)}/_workitems/edit/${created.id}`,
    parentId: input.parentFeatureId,
  };
}

/**
 * Create a new User Story in ADO. Defaults: assignee = current user, iteration =
 * current sprint. Always sets StoryPoints + Effort so the delivery manager
 * never sees blank planning fields.
 */
export async function createStory(input: CreateStoryInput): Promise<CreatedStory> {
  return createStoryLevel('$User%20Story', 'story', input);
}

/**
 * Create a new Bug in ADO. Same defaults and planning fields as a story (a Bug
 * is a story-level item here). NOTE: this tenant's Bug type has no Blocked
 * state — blocking a bug falls back to a tag elsewhere in this file.
 */
export async function createBug(input: CreateStoryInput): Promise<CreatedStory> {
  return createStoryLevel('$Bug', 'bug', input);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run server/writes.test.ts -t "createBug"` then `npx vitest run server/writes.test.ts -t "createStory — posts"`
Expected: BOTH PASS (createBug works; createStory regression still green).

- [ ] **Step 5: Commit**

```bash
git add server/writes.ts server/writes.test.ts
git commit -m "feat: createBug + shared createStoryLevel helper"
```

---

### Task 3: Add `changeWorkItemType` with Story↔Bug guards

A pure write-path function that reads the current type, refuses anything outside Story↔Bug and refuses no-ops, then PATCHes the type. Guards live here (not in the MCP glue) so they're unit-tested.

**Files:**
- Modify: `server/writes.ts` (add near `createBug`; reuses the private `readFields` at line 388)
- Test: `server/writes.test.ts`

- [ ] **Step 1: Write the failing tests**

Add `changeWorkItemType` to the import block in `server/writes.test.ts`, then append:

```ts
describe('changeWorkItemType — Story <-> Bug only', () => {
  it('flips a User Story to a Bug', async () => {
    seed(10, { [F.type]: 'User Story', [F.state]: 'Active' });
    const r = await changeWorkItemType(10, 'bug');
    expect(r.type).toBe('Bug');
    expect(fieldsOf(10)[F.type]).toBe('Bug');
    expect(fieldsOf(10)[F.state]).toBe('Active'); // state carried across
  });

  it('flips a Bug back to a User Story', async () => {
    seed(11, { [F.type]: 'Bug', [F.state]: 'New' });
    const r = await changeWorkItemType(11, 'story');
    expect(r.type).toBe('User Story');
  });

  it('refuses a Task source', async () => {
    seed(12, { [F.type]: 'Task', [F.state]: 'Active' });
    await expect(changeWorkItemType(12, 'bug')).rejects.toThrow(/only works between User Story and Bug/);
  });

  it('refuses a no-op (already that type)', async () => {
    seed(13, { [F.type]: 'Bug', [F.state]: 'Active' });
    await expect(changeWorkItemType(13, 'bug')).rejects.toThrow(/already a Bug/);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run server/writes.test.ts -t "changeWorkItemType"`
Expected: FAIL — `changeWorkItemType is not a function`.

- [ ] **Step 3: Implement `changeWorkItemType`**

In `server/writes.ts`, add right after `createBug`:

```ts
const TYPE_NAME: Record<'story' | 'bug', string> = {
  story: 'User Story',
  bug: 'Bug',
};

export interface ChangedType {
  id: number;
  title: string;
  type: string;
  state: string;
}

/**
 * Change a work item's type between User Story and Bug. Reads the current type
 * first: refuses anything that isn't a Story↔Bug flip (Task / Feature / Epic
 * carry hierarchy meaning a type swap would corrupt) and refuses a no-op.
 * Azure carries the State across because Story and Bug share the states this
 * tenant uses (New / Active / Closed).
 */
export async function changeWorkItemType(
  workItemId: number,
  toType: 'story' | 'bug',
): Promise<ChangedType> {
  const target = TYPE_NAME[toType];
  const current = await readFields(workItemId, [
    'System.WorkItemType',
    'System.State',
    'System.Title',
  ]);
  const currentType = String(current['System.WorkItemType'] ?? '');

  if (currentType !== 'User Story' && currentType !== 'Bug') {
    throw new Error(
      `#${workItemId} is a ${currentType || 'unknown type'} — changing type only works between User Story and Bug.`,
    );
  }
  if (currentType === target) {
    throw new Error(`#${workItemId} is already a ${target}.`);
  }

  const cfg = await loadAdoConfig();
  const uri = `${cfg.organization}/${encodeURIComponent(cfg.project)}/_apis/wit/workitems/${workItemId}?api-version=7.1`;
  const updated = await getAdoClient().rest<{
    id: number;
    fields: { 'System.WorkItemType': string; 'System.State': string; 'System.Title': string };
  }>({
    method: 'PATCH',
    uri,
    body: [{ op: 'add', path: '/fields/System.WorkItemType', value: target }],
    contentKind: 'json-patch',
  });

  return {
    id: updated.id,
    title: String(updated.fields['System.Title'] ?? current['System.Title'] ?? ''),
    type: updated.fields['System.WorkItemType'],
    state: updated.fields['System.State'],
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run server/writes.test.ts -t "changeWorkItemType"`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add server/writes.ts server/writes.test.ts
git commit -m "feat: changeWorkItemType (Story<->Bug) with guards"
```

---

### Task 4: Register the two MCP tools

Wire `createBug` and `changeWorkItemType` as MCP tools. Thin glue: parse args, call the writes function, refresh the dashboard cache, return a plain result. Not unit-tested (the user smoke-tests after reload).

**Files:**
- Modify: `mcp/server.ts` (writes import block ~lines 57-74; register a `bug_create` tool near `story_create` ~line 1712; register `workitem_change_type` near `workitem_edit`)

- [ ] **Step 1: Add the imports**

In `mcp/server.ts`, extend the `from '../server/writes.js'` import block (lines 57-74) to include the two new functions:

```ts
  createStory,
  createBug,
  createTask,
  changeWorkItemType,
```

(Keep the other existing names in that block unchanged — just add `createBug` and `changeWorkItemType`.)

- [ ] **Step 2: Register `bug_create`**

In `mcp/server.ts`, immediately after the `story_create` registration block (ends ~line 1746), add:

```ts
server.registerTool(
  'bug_create',
  {
    title: 'Create an ADO bug in the current sprint',
    description:
      "Create a new Bug in Azure DevOps, placed in Moran's current sprint and assigned to him. The twin of story_create — same flow: ALWAYS ask Moran for effortHours before calling (never guess, never skip). Story Points are derived from it automatically (1 point = 1 workday). Pass `parentFeatureId` to nest under a Feature/Epic. Use this when the work is a defect rather than new scope. Note: Bugs have no 'Blocked' state in this tenant — workitem_block falls back to a tag for bugs. Returns the new bug's id and URL.",
    inputSchema: {
      title: z.string().min(1).describe('Bug title — short and specific.'),
      description: z.string().optional().describe('Optional details. Plain text or simple HTML.'),
      effortHours: z
        .number()
        .min(0)
        .describe('REQUIRED. Total hours Moran thinks this bug is. Ask him for it before calling. StoryPoints is derived from this automatically — do not pass points separately.'),
      parentFeatureId: z
        .number()
        .int()
        .positive()
        .optional()
        .describe('Optional Feature/Epic id to link this bug under.'),
    },
  },
  async ({ title, description, effortHours, parentFeatureId }) => {
    try {
      const created = await createBug({ title, description, effortHours, parentFeatureId });
      markSHCreated(created.id, 'story');
      invalidateDashboardCache();
      return jsonResult(created);
    } catch (e) {
      return errorResult(e instanceof Error ? e.message : String(e));
    }
  },
);
```

- [ ] **Step 3: Register `workitem_change_type`**

In `mcp/server.ts`, add this right after the `story_close` registration block (ends ~line 1474), keeping it near the other edit/lifecycle tools:

```ts
server.registerTool(
  'workitem_change_type',
  {
    title: 'Change a work item between User Story and Bug',
    description:
      "Flip an existing work item's type between User Story and Bug. ONLY these two types — refuses Tasks, Features and Epics (changing those would corrupt the hierarchy). Refuses a no-op if the item is already the requested type. The type is visible to Moran's delivery manager, so CONFIRM with Moran before calling — don't flip a type on your own. The item's state carries across (Story and Bug share New/Active/Closed here). Returns the item's new type and state.",
    inputSchema: {
      workItemId: workItemIdSchema,
      toType: z.enum(['story', 'bug']).describe("Target type: 'story' (User Story) or 'bug' (Bug)."),
    },
  },
  async ({ workItemId, toType }) => {
    try {
      const changed = await changeWorkItemType(workItemId, toType);
      invalidateDashboardCache();
      return jsonResult({
        changed: {
          id: changed.id,
          displayName: displayNameFor(changed.id, changed.title),
          toType: changed.type,
          state: changed.state,
        },
      });
    } catch (e) {
      return errorResult(e instanceof Error ? e.message : String(e));
    }
  },
);
```

- [ ] **Step 4: Typecheck**

Run: `npx tsc -b`
Expected: exits 0, no errors. (Confirms the imports resolve, `workItemIdSchema`, `displayNameFor`, `jsonResult`, `errorResult`, `markSHCreated`, `invalidateDashboardCache` are all in scope — they are already used by neighboring tools in this file.)

- [ ] **Step 5: Commit**

```bash
git add mcp/server.ts
git commit -m "feat: bug_create + workitem_change_type MCP tools"
```

---

### Task 5: Full verification

**Files:** none (verification only)

- [ ] **Step 1: Run the whole suite**

Run: `npm test`
Expected: all test files pass, including the new createStory / createBug / changeWorkItemType cases.

- [ ] **Step 2: Typecheck the whole build**

Run: `npx tsc -b`
Expected: exits 0.

- [ ] **Step 3: Flag the manual smoke test for the user**

The MCP tool wiring is not unit-tested by design. Tell Moran: after he reloads the MCP (`/exit` + `claude --resume`), smoke-test on his real board —
  1. Ask a session to create a bug (give it hours) → confirm a Bug appears in the sprint with Effort + Story Points filled. **This is where the one open question gets answered:** if Azure rejects the `Effort` field on a Bug, the fix is to drop that one line from the bug patch in `createStoryLevel`.
  2. Ask a session to convert that bug to a story and back → confirm the type flips and the state survives.
  3. Confirm converting a Task is refused with a plain message.

---

## Notes for the implementer

- **Do not** add `invalidateDashboardCache()` to `createStory` in this work — it doesn't call it today, and changing that is out of scope. The new tools call it themselves.
- `escapeHtml`, `round2`, `getWorkdayHours`, `deriveStoryPoints`, `getCurrentIterationPath`, `getAdoClient`, `loadAdoConfig`, and the private `readFields` are all already defined/imported in `server/writes.ts` (the current `createStory`/`createTask` use them). No new imports needed in that file.
- `CreateStoryInput` and `CreatedStory` (lines 638-660) are reused as-is for `createBug` — a Bug nests under a Feature via `parentFeatureId`, same as a story.
