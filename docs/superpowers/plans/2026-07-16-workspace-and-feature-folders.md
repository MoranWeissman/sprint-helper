# Workspace + Feature Folders + Managed Features — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give sprint-helper a settable "workspace" folder for non-code work, auto-create a scaffolded per-feature subfolder when Moran names a feature, and show PM-owned features he's managing on the board.

**Architecture:** One new leaf module `server/workspace.ts` owns all workspace state (settings-backed) and folder scaffolding, mirroring the existing `server/planning-home.ts`. Orient gains an "empty folder → offer workspace" signal. The dashboard unions in "managed features" via the existing `getWorkItemsWithParents` by-id fetch. MCP tools are thin glue.

**Tech Stack:** TypeScript, @modelcontextprotocol/sdk (McpServer), node:fs/path/os, better-sqlite3 (settings table via server/timers), Vitest 4, Vite + React front end.

## Global Constraints

- All state persists in the existing `settings` table via `getSetting(key): string | undefined` / `setSetting(key, value): void` from `server/timers`. List-valued settings are stored as `JSON.stringify(array)` and parsed defensively (garbage/unset → `[]`, never throw).
- Everything is LOCAL. The only Azure DevOps access is READING a work item (title/state) via existing `getWorkItem` / `getWorkItemsWithParents`. No ADO writes, no reassignment, no iteration moves.
- New payload fields are OPTIONAL on the client (`field?:`) — version-skew guard: an older client must tolerate their absence (established rule after the 2026-07-05 crash).
- Paths: expand a leading `~` to `homedir()`; `resolve()` before storing or comparing. Sub-path match = `abs === base || abs.startsWith(base + '/')`.
- Plain English in every user-facing string and tool description (no "slack"/"burndown"/"scope"-noun/etc.); reference work items by `**title** (#id)`, never a bare id.
- Never overwrite an existing scaffold file. Scaffolding only fills what's missing and reports what it created.
- The scaffold seed defaults to `~/projects/github-moran/features` (built 2026-07-16), overridable via setting `workspace_seed_path`.
- Test harness: `npm test` (Vitest). Tests live in `server/*.test.ts`. Run the full suite before each commit; it must stay green.

---

## File Structure

- **Create `server/workspace.ts`** — workspace state (paths, declined, managed feature ids), folder-name slug, folder creation, scaffold copy. All the pure/fs logic. One responsibility: the workspace concept.
- **Create `server/workspace.test.ts`** — unit tests for the above (pure logic + fs against temp dirs).
- **Modify `server/orient.ts`** — add `workspaceOffer` to the orient packet via a pure `workspaceOfferFor(...)` helper; expose the full chat cwd.
- **Modify `server/dashboard.ts`** — union managed features into the payload as `managedFeatures`, via pure `selectManagedFeatures(...)`.
- **Modify `src/lib/api.ts`** — `ApiManagedFeature` type + optional `managedFeatures` on the dashboard payload type.
- **Modify `src/components/Dashboard.tsx` + `src/styles/dashboard.css`** — a "Features you're managing" section.
- **Modify `mcp/server.ts`** — five thin tool handlers + a SERVER_INSTRUCTIONS WORKSPACE block.

---

### Task 1: `server/workspace.ts` — settings state (paths, declined, managed ids)

**Files:**
- Create: `server/workspace.ts`
- Test: `server/workspace.test.ts`

**Interfaces:**
- Consumes: `getSetting(key: string): string | undefined`, `setSetting(key: string, value: string): void` from `./timers`.
- Produces:
  - `interface WorkspaceState { paths: string[]; declined: string[] }`
  - `getWorkspaces(): WorkspaceState`
  - `isKnownWorkspace(cwd: string): boolean`
  - `isDeclinedPath(cwd: string): boolean`
  - `declineWorkspace(cwd: string): void`
  - `getManagedFeatureIds(): number[]`
  - `addManagedFeatureId(id: number): void`
  - `removeManagedFeatureId(id: number): void`
  - Constants: `WORKSPACE_PATHS_KEY = 'workspace_paths'`, `WORKSPACE_DECLINED_KEY = 'workspace_declined_paths'`, `MANAGED_FEATURES_KEY = 'managed_feature_ids'`.

- [ ] **Step 1: Write the failing test**

Create `server/workspace.test.ts`. The existing suite mocks the settings store with an in-memory map (see `server/session-cap.test.ts` for the `vi.hoisted`/`vi.mock('./timers')` shape). NOTE: session-cap mocks only `getSetting`; workspace also writes, so the mock below must expose BOTH `getSetting` and `setSetting` over the same map. Use exactly this:

```typescript
import { describe, it, expect, beforeEach, vi } from 'vitest';

const { store } = vi.hoisted(() => ({ store: new Map<string, string>() }));
vi.mock('./timers', () => ({
  getSetting: (k: string) => store.get(k),
  setSetting: (k: string, v: string) => { store.set(k, v); },
}));

import {
  getWorkspaces, isKnownWorkspace, isDeclinedPath, declineWorkspace,
  getManagedFeatureIds, addManagedFeatureId, removeManagedFeatureId,
  WORKSPACE_PATHS_KEY, MANAGED_FEATURES_KEY,
} from './workspace';

beforeEach(() => store.clear());

describe('workspace settings state', () => {
  it('getWorkspaces returns empty arrays when unset', () => {
    expect(getWorkspaces()).toEqual({ paths: [], declined: [] });
  });

  it('getWorkspaces parses garbage as empty', () => {
    store.set(WORKSPACE_PATHS_KEY, 'not json');
    expect(getWorkspaces().paths).toEqual([]);
  });

  it('isKnownWorkspace matches exact path and sub-paths', () => {
    store.set(WORKSPACE_PATHS_KEY, JSON.stringify(['/w/space']));
    expect(isKnownWorkspace('/w/space')).toBe(true);
    expect(isKnownWorkspace('/w/space/426639-x')).toBe(true);
    expect(isKnownWorkspace('/w/other')).toBe(false);
  });

  it('declineWorkspace records path; isDeclinedPath matches; dedups', () => {
    declineWorkspace('/w/nope');
    declineWorkspace('/w/nope');
    expect(isDeclinedPath('/w/nope')).toBe(true);
    expect(getWorkspaces().declined).toEqual(['/w/nope']);
  });

  it('managed feature ids: add (dedup number), read, remove', () => {
    addManagedFeatureId(426639);
    addManagedFeatureId(426639);
    addManagedFeatureId(431000);
    expect(getManagedFeatureIds()).toEqual([426639, 431000]);
    removeManagedFeatureId(426639);
    expect(getManagedFeatureIds()).toEqual([431000]);
  });

  it('getManagedFeatureIds parses garbage as empty', () => {
    store.set(MANAGED_FEATURES_KEY, '{oops');
    expect(getManagedFeatureIds()).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run server/workspace.test.ts`
Expected: FAIL — `Cannot find module './workspace'`.

- [ ] **Step 3: Write minimal implementation**

Create `server/workspace.ts` (state portion only — folder/scaffold functions come in Tasks 2–3):

```typescript
/**
 * Workspace state + feature-folder scaffolding.
 *
 * A "workspace" is a visible folder Moran launches Claude Code in for non-code
 * work (discovery, design, small demos). BMAD + the planning CLAUDE.md + the
 * enforcement hook live once at its root; each feature gets a subfolder for its
 * design docs. Generalizes the older planning-home concept (see planning-home.ts).
 *
 * All state lives in the settings table as JSON arrays, parsed defensively.
 * Everything here is LOCAL — no Azure DevOps access.
 */
import { resolve } from 'node:path';
import { getSetting, setSetting } from './timers';

export const WORKSPACE_PATHS_KEY = 'workspace_paths';
export const WORKSPACE_DECLINED_KEY = 'workspace_declined_paths';
export const MANAGED_FEATURES_KEY = 'managed_feature_ids';

export interface WorkspaceState {
  paths: string[];
  declined: string[];
}

/** Parse a settings value expected to be a JSON array; garbage/unset → []. */
function readJsonArray<T>(key: string, guard: (v: unknown) => v is T): T[] {
  const raw = getSetting(key);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(guard) : [];
  } catch {
    return [];
  }
}

const isString = (v: unknown): v is string => typeof v === 'string';
const isNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

function writeJsonArray(key: string, arr: unknown[]): void {
  setSetting(key, JSON.stringify(arr));
}

export function getWorkspaces(): WorkspaceState {
  return {
    paths: readJsonArray(WORKSPACE_PATHS_KEY, isString),
    declined: readJsonArray(WORKSPACE_DECLINED_KEY, isString),
  };
}

function underAny(cwd: string, bases: string[]): boolean {
  const abs = resolve(cwd);
  return bases.some(b => {
    const base = resolve(b);
    return abs === base || abs.startsWith(base + '/');
  });
}

export function isKnownWorkspace(cwd: string): boolean {
  return underAny(cwd, getWorkspaces().paths);
}

export function isDeclinedPath(cwd: string): boolean {
  const abs = resolve(cwd);
  return getWorkspaces().declined.some(d => resolve(d) === abs);
}

export function declineWorkspace(cwd: string): void {
  const abs = resolve(cwd);
  const declined = getWorkspaces().declined.map(d => resolve(d));
  if (!declined.includes(abs)) {
    declined.push(abs);
    writeJsonArray(WORKSPACE_DECLINED_KEY, declined);
  }
}

export function getManagedFeatureIds(): number[] {
  return readJsonArray(MANAGED_FEATURES_KEY, isNumber);
}

export function addManagedFeatureId(id: number): void {
  const ids = getManagedFeatureIds();
  if (!ids.includes(id)) {
    ids.push(id);
    writeJsonArray(MANAGED_FEATURES_KEY, ids);
  }
}

export function removeManagedFeatureId(id: number): void {
  const ids = getManagedFeatureIds().filter(x => x !== id);
  writeJsonArray(MANAGED_FEATURES_KEY, ids);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run server/workspace.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add server/workspace.ts server/workspace.test.ts
git commit -m "feat(workspace): settings-backed workspace + managed-feature state"
```

---

### Task 2: `server/workspace.ts` — feature-folder name + creation

**Files:**
- Modify: `server/workspace.ts`
- Test: `server/workspace.test.ts`

**Interfaces:**
- Consumes: nothing new (adds `node:fs`, `node:os` imports).
- Produces:
  - `featureFolderName(id: number, title: string): string`
  - `expandHome(p: string): string`
  - `createFeatureFolder(workspacePath: string, id: number, title: string): { path: string; created: boolean }`

- [ ] **Step 1: Write the failing test**

Append to `server/workspace.test.ts`. For fs tests, use a temp dir under `os.tmpdir()`; import `mkdtempSync`, `rmSync`, `existsSync`, `writeFileSync` from `node:fs`, `tmpdir` from `node:os`, `join` from `node:path`:

```typescript
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { featureFolderName, createFeatureFolder } from './workspace';

describe('featureFolderName', () => {
  it('slugs the title: lowercase, punctuation to dashes, capped', () => {
    const name = featureFolderName(
      426639,
      'Declarative Continuous Deployment (CD) and Automated Testing Pipeline',
    );
    expect(name.startsWith('426639-')).toBe(true);
    expect(name).toMatch(/^426639-[a-z0-9-]+$/);
    expect(name.length).toBeLessThanOrEqual(48); // id + '-' + <=40 slug
    expect(name).not.toContain('(');
    expect(name).not.toMatch(/--/);       // collapsed
    expect(name.endsWith('-')).toBe(false); // trimmed
  });

  it('handles an empty/symbol-only title with just the id', () => {
    expect(featureFolderName(12, '!!!')).toBe('12');
  });
});

describe('createFeatureFolder', () => {
  it('creates the folder and reports created, then false on repeat', () => {
    const root = mkdtempSync(join(tmpdir(), 'sh-ws-'));
    try {
      const first = createFeatureFolder(root, 426639, 'Declarative CD');
      expect(existsSync(first.path)).toBe(true);
      expect(first.created).toBe(true);
      const second = createFeatureFolder(root, 426639, 'Declarative CD');
      expect(second.path).toBe(first.path);
      expect(second.created).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run server/workspace.test.ts`
Expected: FAIL — `featureFolderName`/`createFeatureFolder` not exported.

- [ ] **Step 3: Write minimal implementation**

Add to `server/workspace.ts` (update imports at top to include fs + os + `homedir`, `join`):

```typescript
// add to existing imports
import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path'; // resolve already imported; add join

export function expandHome(p: string): string {
  if (p === '~' || p.startsWith('~/')) return join(homedir(), p.slice(2));
  return p;
}

const SLUG_MAX = 40;

/** `<id>-<slug>` where slug = lowercased title, non-alphanumerics → '-',
 *  collapsed, trimmed, capped. Symbol-only title → just the id. */
export function featureFolderName(id: number, title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, SLUG_MAX)
    .replace(/-+$/g, ''); // re-trim after slice may leave a trailing dash
  return slug ? `${id}-${slug}` : `${id}`;
}

export function createFeatureFolder(
  workspacePath: string,
  id: number,
  title: string,
): { path: string; created: boolean } {
  const abs = join(resolve(expandHome(workspacePath)), featureFolderName(id, title));
  const existed = existsSync(abs);
  mkdirSync(abs, { recursive: true });
  return { path: abs, created: !existed };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run server/workspace.test.ts`
Expected: PASS (all Task 1 + Task 2 tests).

- [ ] **Step 5: Commit**

```bash
git add server/workspace.ts server/workspace.test.ts
git commit -m "feat(workspace): feature-folder name slug + idempotent creation"
```

---

### Task 3: `server/workspace.ts` — scaffold copy + `registerWorkspace`

**Files:**
- Modify: `server/workspace.ts`
- Test: `server/workspace.test.ts`

**Interfaces:**
- Consumes: `getSetting`/`setSetting`, the state fns from Task 1, `expandHome` from Task 2.
- Produces:
  - `SEED_KEY = 'workspace_seed_path'`, `DEFAULT_SEED = join(homedir(), 'projects/github-moran/features')`
  - `getSeedPath(): string`
  - `ensureWorkspaceScaffold(workspacePath: string): { created: string[]; seedMissing: boolean }`
  - `registerWorkspace(path: string): { path: string; scaffolded: string[]; seedMissing: boolean }`

- [ ] **Step 1: Write the failing test**

Append to `server/workspace.test.ts`. Build a fake seed dir with the three pieces, then scaffold into an empty workspace and assert the pieces copied:

```typescript
import { mkdirSync, writeFileSync, cpSync } from 'node:fs';
import { registerWorkspace, ensureWorkspaceScaffold, SEED_KEY, getWorkspaces } from './workspace';

function makeSeed(): string {
  const seed = mkdtempSync(join(tmpdir(), 'sh-seed-'));
  mkdirSync(join(seed, '_bmad'), { recursive: true });
  writeFileSync(join(seed, '_bmad', 'config.yaml'), 'x');
  mkdirSync(join(seed, '.claude', 'skills', 'bmad-x'), { recursive: true });
  writeFileSync(join(seed, '.claude', 'skills', 'bmad-x', 'SKILL.md'), 'x');
  mkdirSync(join(seed, '.claude', 'hooks'), { recursive: true });
  writeFileSync(join(seed, '.claude', 'hooks', 'user-prompt-submit.sh'), '#!/bin/bash\n');
  writeFileSync(join(seed, 'CLAUDE.md'), '# rules');
  return seed;
}

describe('ensureWorkspaceScaffold', () => {
  it('copies bmad, claude-md, hook into an empty workspace; skips on repeat', () => {
    const seed = makeSeed();
    const ws = mkdtempSync(join(tmpdir(), 'sh-ws2-'));
    try {
      store.set(SEED_KEY, seed);
      const first = ensureWorkspaceScaffold(ws);
      expect(first.seedMissing).toBe(false);
      expect(first.created.sort()).toEqual(['bmad', 'claude-md', 'hook'].sort());
      expect(existsSync(join(ws, '_bmad', 'config.yaml'))).toBe(true);
      expect(existsSync(join(ws, 'CLAUDE.md'))).toBe(true);
      expect(existsSync(join(ws, '.claude', 'hooks', 'user-prompt-submit.sh'))).toBe(true);
      expect(existsSync(join(ws, '.claude', 'settings.json'))).toBe(true);
      const second = ensureWorkspaceScaffold(ws);
      expect(second.created).toEqual([]); // nothing re-copied
    } finally {
      rmSync(seed, { recursive: true, force: true });
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('reports seedMissing when the seed has no _bmad', () => {
    const emptySeed = mkdtempSync(join(tmpdir(), 'sh-noseed-'));
    const ws = mkdtempSync(join(tmpdir(), 'sh-ws3-'));
    try {
      store.set(SEED_KEY, emptySeed);
      const r = ensureWorkspaceScaffold(ws);
      expect(r.seedMissing).toBe(true);
      expect(r.created).toEqual([]);
    } finally {
      rmSync(emptySeed, { recursive: true, force: true });
      rmSync(ws, { recursive: true, force: true });
    }
  });
});

describe('registerWorkspace', () => {
  it('adds the path, dedups, and scaffolds', () => {
    const seed = makeSeed();
    const ws = mkdtempSync(join(tmpdir(), 'sh-ws4-'));
    try {
      store.set(SEED_KEY, seed);
      const r = registerWorkspace(ws);
      expect(r.path).toBe(resolve(ws));
      expect(r.scaffolded.length).toBe(3);
      expect(getWorkspaces().paths).toContain(resolve(ws));
      registerWorkspace(ws); // dedup
      expect(getWorkspaces().paths.filter(p => p === resolve(ws)).length).toBe(1);
    } finally {
      rmSync(seed, { recursive: true, force: true });
      rmSync(ws, { recursive: true, force: true });
    }
  });
});
```

Add `import { resolve } from 'node:path';` to the test imports if not already present.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run server/workspace.test.ts`
Expected: FAIL — `registerWorkspace`/`ensureWorkspaceScaffold`/`SEED_KEY` not exported.

- [ ] **Step 3: Write minimal implementation**

Add to `server/workspace.ts` (add `cpSync`, `writeFileSync` to the fs import):

```typescript
// extend fs import: existsSync, mkdirSync, cpSync, writeFileSync
export const SEED_KEY = 'workspace_seed_path';
const DEFAULT_SEED = join(homedir(), 'projects', 'github-moran', 'features');

export function getSeedPath(): string {
  return getSetting(SEED_KEY) ?? DEFAULT_SEED;
}

const SETTINGS_JSON = JSON.stringify(
  {
    hooks: {
      UserPromptSubmit: [
        { hooks: [{ type: 'command', command: '"$CLAUDE_PROJECT_DIR"/.claude/hooks/user-prompt-submit.sh' }] },
      ],
    },
  },
  null,
  2,
) + '\n';

export function ensureWorkspaceScaffold(
  workspacePath: string,
): { created: string[]; seedMissing: boolean } {
  const ws = resolve(expandHome(workspacePath));
  mkdirSync(ws, { recursive: true });
  const seed = resolve(getSeedPath());
  const created: string[] = [];

  // Seed must have _bmad to be usable.
  if (!existsSync(join(seed, '_bmad'))) {
    return { created, seedMissing: true };
  }

  if (!existsSync(join(ws, '_bmad'))) {
    cpSync(join(seed, '_bmad'), join(ws, '_bmad'), { recursive: true });
    cpSync(join(seed, '.claude', 'skills'), join(ws, '.claude', 'skills'), { recursive: true });
    created.push('bmad');
  }
  if (!existsSync(join(ws, 'CLAUDE.md')) && existsSync(join(seed, 'CLAUDE.md'))) {
    cpSync(join(seed, 'CLAUDE.md'), join(ws, 'CLAUDE.md'));
    created.push('claude-md');
  }
  if (!existsSync(join(ws, '.claude', 'hooks', 'user-prompt-submit.sh'))) {
    mkdirSync(join(ws, '.claude', 'hooks'), { recursive: true });
    cpSync(
      join(seed, '.claude', 'hooks', 'user-prompt-submit.sh'),
      join(ws, '.claude', 'hooks', 'user-prompt-submit.sh'),
    );
    if (!existsSync(join(ws, '.claude', 'settings.json'))) {
      writeFileSync(join(ws, '.claude', 'settings.json'), SETTINGS_JSON);
    }
    created.push('hook');
  }
  return { created, seedMissing: false };
}

export function registerWorkspace(
  path: string,
): { path: string; scaffolded: string[]; seedMissing: boolean } {
  const abs = resolve(expandHome(path));
  const state = getWorkspaces();
  if (!state.paths.map(p => resolve(p)).includes(abs)) {
    writeJsonArray(WORKSPACE_PATHS_KEY, [...state.paths, abs]);
  }
  // Un-decline if it was previously declined.
  const declined = state.declined.map(d => resolve(d)).filter(d => d !== abs);
  if (declined.length !== state.declined.length) writeJsonArray(WORKSPACE_DECLINED_KEY, declined);
  const scaffold = ensureWorkspaceScaffold(abs);
  return { path: abs, scaffolded: scaffold.created, seedMissing: scaffold.seedMissing };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run server/workspace.test.ts`
Expected: PASS (all workspace tests).

- [ ] **Step 5: Commit**

```bash
git add server/workspace.ts server/workspace.test.ts
git commit -m "feat(workspace): scaffold copy from seed + registerWorkspace"
```

---

### Task 4: orient — `workspaceOffer` (empty-folder detection)

**Files:**
- Modify: `server/orient.ts`
- Test: `server/orient.test.ts` (existing file — append)

**Interfaces:**
- Consumes: `isKnownWorkspace`, `isDeclinedPath` from `./workspace`.
- Produces:
  - `interface OrientWorkspaceOffer { shouldOffer: boolean; cwd: string | null; reason: 'empty-unknown' | null }`
  - pure `workspaceOfferFor(args: { cwd: string | null; entries: string[]; known: boolean; declined: boolean }): OrientWorkspaceOffer`
  - `OrientPacket.workspaceOffer: OrientWorkspaceOffer`

- [ ] **Step 1: Write the failing test**

Append to `server/orient.test.ts`:

```typescript
import { workspaceOfferFor } from './orient';

describe('workspaceOfferFor', () => {
  const ALLOWED = ['.git', '.DS_Store', '.sprint-helper-home'];
  it('offers for an empty, unknown, non-declined folder', () => {
    const r = workspaceOfferFor({ cwd: '/tmp/new', entries: [], known: false, declined: false });
    expect(r.shouldOffer).toBe(true);
    expect(r.reason).toBe('empty-unknown');
  });
  it('treats allowlisted dotfiles as still-empty', () => {
    const r = workspaceOfferFor({ cwd: '/tmp/new', entries: ALLOWED, known: false, declined: false });
    expect(r.shouldOffer).toBe(true);
  });
  it('does NOT offer when the folder has real content', () => {
    const r = workspaceOfferFor({ cwd: '/tmp/x', entries: ['README.md'], known: false, declined: false });
    expect(r.shouldOffer).toBe(false);
  });
  it('does NOT offer a known workspace', () => {
    expect(workspaceOfferFor({ cwd: '/w', entries: [], known: true, declined: false }).shouldOffer).toBe(false);
  });
  it('does NOT offer a declined path', () => {
    expect(workspaceOfferFor({ cwd: '/w', entries: [], known: false, declined: true }).shouldOffer).toBe(false);
  });
  it('does NOT offer when cwd is null', () => {
    expect(workspaceOfferFor({ cwd: null, entries: [], known: false, declined: false }).shouldOffer).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run server/orient.test.ts`
Expected: FAIL — `workspaceOfferFor` not exported.

- [ ] **Step 3: Write minimal implementation**

In `server/orient.ts`: add the import, the interface, the pure helper, the packet field, and wire it in `buildOrientPacket`.

```typescript
// near other imports
import { isKnownWorkspace, isDeclinedPath } from './workspace';
import { readdirSync } from 'node:fs';

export interface OrientWorkspaceOffer {
  shouldOffer: boolean;
  cwd: string | null;
  reason: 'empty-unknown' | null;
}

const WORKSPACE_EMPTY_ALLOWLIST = new Set(['.git', '.DS_Store', '.sprint-helper-home']);

/** Pure: decide whether to offer making this cwd a workspace. Offer when the
 *  folder is empty (ignoring harmless dotfiles), unknown, and not declined. */
export function workspaceOfferFor(args: {
  cwd: string | null;
  entries: string[];
  known: boolean;
  declined: boolean;
}): OrientWorkspaceOffer {
  const { cwd, entries, known, declined } = args;
  if (!cwd || known || declined) return { shouldOffer: false, cwd, reason: null };
  const realEntries = entries.filter(e => !WORKSPACE_EMPTY_ALLOWLIST.has(e));
  if (realEntries.length > 0) return { shouldOffer: false, cwd, reason: null };
  return { shouldOffer: true, cwd, reason: 'empty-unknown' };
}
```

Add `workspaceOffer: OrientWorkspaceOffer;` to the `OrientPacket` interface (next to `planningHome`). In `buildOrientPacket`, after the `planningHome` block, compute it from the FULL cwd (`process.cwd()` — this MCP process runs in the chat's folder):

```typescript
  // Empty-folder → offer-workspace signal (rides on orient).
  const fullCwd = process.cwd();
  let workspaceOffer: OrientWorkspaceOffer;
  try {
    const entries = readdirSync(fullCwd);
    workspaceOffer = workspaceOfferFor({
      cwd: fullCwd,
      entries,
      known: isKnownWorkspace(fullCwd),
      declined: isDeclinedPath(fullCwd),
    });
  } catch {
    workspaceOffer = { shouldOffer: false, cwd: fullCwd, reason: null };
  }
```

Add `workspaceOffer` to the returned packet object (next to `planningHome`).

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run server/orient.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/orient.ts server/orient.test.ts
git commit -m "feat(workspace): orient offers workspace in an empty unknown folder"
```

---

### Task 5: dashboard — union managed features into the payload

**Files:**
- Modify: `server/dashboard.ts`
- Modify: `src/lib/api.ts`
- Test: `server/dashboard-managed.test.ts` (new — there is no `server/dashboard.test.ts`; the dashboard suite is split into `dashboard-cache/group/taskmeta.test.ts`, so add a focused new file for the pure `selectManagedFeatures` helper)

**Interfaces:**
- Consumes: `getManagedFeatureIds` from `./workspace`; `getWorkItemsWithParents(ids: number[]): Promise<WorkItem[]>` from `./ado` (already imported in dashboard.ts). `WorkItem` fields used: `id: number`, `title: string`, `type: string`, `state: string`, `assignedTo?: string`, `url: string`.
- Produces:
  - `interface ManagedFeature { id: number; title: string; displayName: string; state: string; url: string; assignedTo: string | null }`
  - pure `selectManagedFeatures(args: { managedIds: number[]; alreadyShownIds: Set<number>; fetched: WorkItem[] }): ManagedFeature[]`
  - `DashboardPayload.managedFeatures: ManagedFeature[]`

- [ ] **Step 1: Write the failing test**

Create `server/dashboard-managed.test.ts` (import the pure helper — no ADO needed):

```typescript
import { selectManagedFeatures } from './dashboard';

const CLOSED = new Set(['Closed', 'Removed', 'Done']);

describe('selectManagedFeatures', () => {
  const fetched = [
    { id: 426639, title: 'Declarative CD', type: 'Feature', state: 'New', assignedTo: 'Rom, Guy', url: 'u1' },
    { id: 500, title: 'Closed one', type: 'Feature', state: 'Closed', assignedTo: 'X', url: 'u2' },
  ] as any[];

  it('keeps open managed features not already shown; formats displayName', () => {
    const out = selectManagedFeatures({
      managedIds: [426639, 500],
      alreadyShownIds: new Set<number>(),
      fetched,
    });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ id: 426639, displayName: '**Declarative CD** (#426639)', assignedTo: 'Rom, Guy' });
  });

  it('skips a feature already shown in the sprint payload', () => {
    const out = selectManagedFeatures({
      managedIds: [426639],
      alreadyShownIds: new Set<number>([426639]),
      fetched,
    });
    expect(out).toEqual([]);
  });

  it('dedups repeated managed ids', () => {
    const out = selectManagedFeatures({
      managedIds: [426639, 426639],
      alreadyShownIds: new Set<number>(),
      fetched,
    });
    expect(out).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run server/dashboard-managed.test.ts`
Expected: FAIL — `selectManagedFeatures` not exported.

- [ ] **Step 3: Write minimal implementation**

In `server/dashboard.ts`, add the type, the pure helper, and the fetch/wire-in. Add `getManagedFeatureIds` to the `./workspace` import.

```typescript
import { getManagedFeatureIds } from './workspace';

export interface ManagedFeature {
  id: number;
  title: string;
  displayName: string;
  state: string;
  url: string;
  assignedTo: string | null;
}

const MANAGED_CLOSED_STATES = new Set(['Closed', 'Removed', 'Done']);

/** Pure: pick open, not-already-shown, deduped managed features. */
export function selectManagedFeatures(args: {
  managedIds: number[];
  alreadyShownIds: Set<number>;
  fetched: { id: number; title: string; type: string; state: string; assignedTo?: string; url: string }[];
}): ManagedFeature[] {
  const { managedIds, alreadyShownIds, fetched } = args;
  const wanted = new Set(managedIds.filter(id => !alreadyShownIds.has(id)));
  const seen = new Set<number>();
  const out: ManagedFeature[] = [];
  for (const w of fetched) {
    if (!wanted.has(w.id) || seen.has(w.id)) continue;
    if (MANAGED_CLOSED_STATES.has(w.state)) continue;
    seen.add(w.id);
    out.push({
      id: w.id,
      title: w.title,
      displayName: `**${w.title}** (#${w.id})`,
      state: w.state,
      url: w.url,
      assignedTo: w.assignedTo ?? null,
    });
  }
  return out;
}
```

Add `managedFeatures: ManagedFeature[];` to `DashboardPayload`. In `buildDashboard`, after the work items are assembled and you know which ids are already shown, add (best-effort — a fetch failure must not crash the dashboard):

```typescript
  // Managed features (PM-owned features Moran chose to manage). Best-effort.
  let managedFeatures: ManagedFeature[] = [];
  try {
    const managedIds = getManagedFeatureIds();
    if (managedIds.length > 0) {
      const alreadyShown = new Set<number>(/* collect numeric ids already in the payload */);
      const fetched = await getWorkItemsWithParents(managedIds);
      managedFeatures = selectManagedFeatures({ managedIds, alreadyShownIds: alreadyShown, fetched });
    }
  } catch {
    managedFeatures = [];
  }
```

For `alreadyShown`, collect the numeric ids present in `workItems.inProgress/upNext/done` (the `DashboardWorkItem.id` is a string — wrap `Number(...)`). Add `managedFeatures` to the returned payload object.

In `src/lib/api.ts`, add:

```typescript
export interface ApiManagedFeature {
  id: number;
  title: string;
  displayName: string;
  state: string;
  url: string;
  assignedTo: string | null;
}
// on the dashboard payload interface:
  managedFeatures?: ApiManagedFeature[];
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run server/dashboard-managed.test.ts && npx tsc -b`
Expected: PASS + typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add server/dashboard.ts src/lib/api.ts server/dashboard-managed.test.ts
git commit -m "feat(workspace): union managed features into the dashboard payload"
```

---

### Task 6: UI — "Features you're managing" section

**Files:**
- Modify: `src/components/Dashboard.tsx`
- Modify: `src/styles/dashboard.css`

**Interfaces:**
- Consumes: `ApiManagedFeature`, `data.managedFeatures` (optional) from the payload; the existing `WorkItemDrawer` open handler (find the existing `onOpenItem`/drawer-open prop the board already uses for rows).

- [ ] **Step 1: Write the failing test**

This is a presentational addition; the repo does not unit-test Dashboard.tsx rendering. Verification is a Moran smoke (Step 4). Skip an automated test here — matches the existing pattern for board sections (documented in memory: final review can't catch reachability; Moran smokes UI).

- [ ] **Step 2: (no automated test to fail)**

- [ ] **Step 3: Write minimal implementation**

Add a section to the board render, guarded on presence + non-empty (version-skew safe):

```tsx
{data.managedFeatures && data.managedFeatures.length > 0 && (
  <section className="r21-managed">
    <h3 className="r21-managed-head">Features you're managing</h3>
    <p className="r21-managed-sub">Not assigned to you — you're driving the stories under them.</p>
    <ul className="r21-managed-list">
      {data.managedFeatures.map(f => (
        <li key={f.id} className="r21-managed-row" role="button" tabIndex={0}
            onClick={() => onOpenItem(f.id)}
            onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') onOpenItem(f.id); }}>
          <span className="r21-managed-title">{f.title}</span>
          <span className="r21-managed-meta">#{f.id} · {f.state} · {f.assignedTo ?? 'unassigned'}</span>
        </li>
      ))}
    </ul>
  </section>
)}
```

(Use the board's actual drawer-open function name in place of `onOpenItem` — confirm it from the existing row click handlers in Dashboard.tsx.)

Add CSS to `src/styles/dashboard.css` following the existing token palette (dark/warm, one accent, no ≤11px with `--ink-4`):

```css
.r21-managed { margin-top: 24px; }
.r21-managed-head { font-size: 15px; color: var(--ink-2); margin: 0 0 2px; }
.r21-managed-sub { font-size: 13px; color: var(--ink-3); margin: 0 0 10px; }
.r21-managed-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
.r21-managed-row { display: flex; justify-content: space-between; align-items: baseline; gap: 12px;
  padding: 10px 12px; border: 1px solid var(--line-1); border-radius: 8px; cursor: pointer; }
.r21-managed-row:hover { border-color: var(--accent); }
.r21-managed-title { font-size: 14px; color: var(--ink-1); }
.r21-managed-meta { font-size: 12px; color: var(--ink-3); white-space: nowrap; }
```

(Confirm the actual token variable names in dashboard.css — use whatever the file already defines for ink/line/accent; do not invent new ones.)

- [ ] **Step 4: Verify (Moran smoke)**

Run: `npx tsc -b` (must be clean). Then: dashboard restart + hard refresh; with a managed feature id in settings, confirm the "Features you're managing" section shows #426639, its click opens the drawer, and it's visually separate from the sprint rows. (Requires Task 8's tool to have added the id, or a manual settings insert.)
Expected: section renders; click opens drawer; no console error when `managedFeatures` is absent.

- [ ] **Step 5: Commit**

```bash
git add src/components/Dashboard.tsx src/styles/dashboard.css
git commit -m "feat(workspace): 'Features you're managing' board section"
```

---

### Task 7: MCP tools — workspace_set / decline / status

**Files:**
- Modify: `mcp/server.ts`

**Interfaces:**
- Consumes: `registerWorkspace`, `declineWorkspace`, `getWorkspaces`, `isKnownWorkspace`, `isDeclinedPath` from `../server/workspace.js` (mcp/server.ts imports server modules WITH the `.js` extension — e.g. `../server/ado.js` at line 62; match that); `jsonResult`/`errorResult` (already in file); `z` (zod, already imported).

- [ ] **Step 1: Write the failing test**

MCP handlers are thin glue and are not unit-tested in this repo (documented convention — Moran smokes them). No automated test. Proceed to implementation.

- [ ] **Step 2: (no automated test)**

- [ ] **Step 3: Write minimal implementation**

Add the import and three `server.registerTool(...)` blocks near the existing `planning_home_set` tool. Use `process.cwd()` as the default cwd for decline/status.

```typescript
import {
  registerWorkspace, declineWorkspace, getWorkspaces, isKnownWorkspace, isDeclinedPath,
} from '../server/workspace.js';

server.registerTool(
  'workspace_set',
  {
    title: "Set a sprint-helper workspace folder",
    description:
      "Register the folder Moran launches Claude Code in for non-code work (discovery, design, small demos) as a WORKSPACE. Creates the folder if needed and fills it once with BMAD, a planning CLAUDE.md, and the enforcement hook (copied from the seed). Fire when Moran says 'this is my workspace' or accepts the empty-folder offer from orient. Returns which scaffold pieces were created; if the seed is missing, says so plainly.",
    inputSchema: {
      path: z.string().min(1).describe('Absolute path to the workspace folder. `~` expands to home.'),
    },
  },
  async ({ path }) => {
    try {
      const r = registerWorkspace(path);
      return jsonResult(r);
    } catch (e) {
      return errorResult(e instanceof Error ? e.message : String(e));
    }
  },
);

server.registerTool(
  'workspace_decline',
  {
    title: 'Remember that a folder is not a workspace',
    description:
      "Record that Moran said NO to making the current folder a workspace, so orient never offers it again. Fire when he declines the empty-folder workspace offer.",
    inputSchema: {
      cwd: z.string().optional().describe('Folder to remember as declined. Defaults to the current working directory.'),
    },
  },
  async ({ cwd }) => {
    try {
      const target = cwd ?? process.cwd();
      declineWorkspace(target);
      return jsonResult({ declined: target });
    } catch (e) {
      return errorResult(e instanceof Error ? e.message : String(e));
    }
  },
);

server.registerTool(
  'workspace_status',
  {
    title: 'List sprint-helper workspaces',
    description:
      "Return Moran's registered workspaces and whether the current folder is a known or declined workspace. Use to answer 'where are my workspaces?' or to check state before offering.",
    inputSchema: {},
  },
  async () => {
    try {
      const cwd = process.cwd();
      return jsonResult({ ...getWorkspaces(), current: { cwd, known: isKnownWorkspace(cwd), declined: isDeclinedPath(cwd) } });
    } catch (e) {
      return errorResult(e instanceof Error ? e.message : String(e));
    }
  },
);
```

- [ ] **Step 4: Verify**

Run: `npx tsc -b`
Expected: clean. (Live tool behavior is a Moran smoke after MCP reload.)

- [ ] **Step 5: Commit**

```bash
git add mcp/server.ts
git commit -m "feat(workspace): workspace_set / workspace_decline / workspace_status tools"
```

---

### Task 8: MCP tools — workspace_feature_folder / feature_unmanage + SERVER_INSTRUCTIONS

**Files:**
- Modify: `mcp/server.ts`

**Interfaces:**
- Consumes: `createFeatureFolder`, `getWorkspaces`, `isKnownWorkspace`, `addManagedFeatureId`, `removeManagedFeatureId` from `../server/workspace`; `getWorkItem` from `../server/ado.js` (ALREADY imported at mcp/server.ts:62 — do not re-import). `getWorkItem` returns an object with `title: string` and `type: string`.

- [ ] **Step 1: Write the failing test**

Thin glue — no unit test (convention). Proceed.

- [ ] **Step 2: (no automated test)**

- [ ] **Step 3: Write minimal implementation**

Add to the `../server/workspace.js` import: `createFeatureFolder, addManagedFeatureId, removeManagedFeatureId`. Add two tools.

`workspace_feature_folder` resolves the active workspace: prefer the current cwd if it's a known workspace; else if exactly one workspace is registered, use it; else error asking Moran to open/set a workspace.

```typescript
server.registerTool(
  'workspace_feature_folder',
  {
    title: 'Start work on a feature (folder + board visibility)',
    description:
      "Fire when Moran names a feature to start non-code work on ('let's work on feature #NNNNNN'). Reads the feature title, creates a subfolder for it inside his workspace, AND records the feature as managed so it shows on his board (needed when the feature is the PM's, not assigned to him). Returns the folder path — write discovery/design docs there. Moran stays in the workspace root chat.",
    inputSchema: {
      workItemId: z.number().int().positive().describe('The Azure DevOps feature id.'),
    },
  },
  async ({ workItemId }) => {
    try {
      const cwd = process.cwd();
      const { paths } = getWorkspaces();
      let workspacePath: string | null = null;
      if (isKnownWorkspace(cwd)) workspacePath = cwd;
      else if (paths.length === 1) workspacePath = paths[0];
      if (!workspacePath) {
        return errorResult(
          paths.length === 0
            ? 'No workspace is set. Ask Moran to open his workspace folder (or set one with workspace_set) first.'
            : 'More than one workspace is registered and this chat is not inside one. Ask Moran which workspace to use.',
        );
      }
      let title = '';
      try {
        const item = await getWorkItem(workItemId);
        title = item.title ?? '';
      } catch {
        title = ''; // fall back to id-only folder name
      }
      const folder = createFeatureFolder(workspacePath, workItemId, title);
      addManagedFeatureId(workItemId);
      return jsonResult({ ...folder, featureTitle: title || null });
    } catch (e) {
      return errorResult(e instanceof Error ? e.message : String(e));
    }
  },
);

server.registerTool(
  'feature_unmanage',
  {
    title: 'Stop showing a feature on the board',
    description:
      "Drop a feature from Moran's 'Features you're managing' board section. The folder on disk is left alone; only the board mark is removed. Fire when he says he's done managing feature #NNNNNN.",
    inputSchema: {
      workItemId: z.number().int().positive().describe('The Azure DevOps feature id to stop managing.'),
    },
  },
  async ({ workItemId }) => {
    try {
      removeManagedFeatureId(workItemId);
      return jsonResult({ unmanaged: workItemId });
    } catch (e) {
      return errorResult(e instanceof Error ? e.message : String(e));
    }
  },
);
```

Then add a SERVER_INSTRUCTIONS WORKSPACE block (find the PLANNING HOME block and add after it). Plain English, names-not-numbers:

```
WORKSPACE — Moran's home for non-code work (discovery, design, small demos):

  A "workspace" is a visible folder Moran opens Claude Code in for work that
  isn't writing code. BMAD, a planning CLAUDE.md, and an enforcement hook live
  once at its root. Each feature he works gets its own subfolder inside it for
  design docs.

  - OFFER on an empty folder: when `orient.workspaceOffer.shouldOffer` is true,
    this chat opened in an empty folder that isn't a known workspace. Ask him
    once: "This is an empty folder and it's not one of your workspaces — want
    to make it your sprint-helper workspace?" On yes → call `workspace_set`
    with this folder's path. On no → call `workspace_decline` (it won't ask
    about this folder again).
  - START A FEATURE: when Moran names a feature to work on ("let's work on
    feature #NNNNNN"), call `workspace_feature_folder` with its id. That one
    call makes the feature's folder AND makes the feature show on his board
    (his "Features you're managing" section) — this is how a PM-owned feature
    he doesn't own becomes manageable. Then write his discovery/design docs
    into the returned folder path. He stays in the workspace root chat.
  - Stories he breaks out go on the board through the usual sprint-helper tools,
    parented under the feature, and pulled into his sprint.
  - This generalizes PLANNING HOME above — a workspace is a planning home he can
    grow feature folders inside.
```

- [ ] **Step 4: Verify**

Run: `npx tsc -b`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add mcp/server.ts
git commit -m "feat(workspace): feature-folder tool + feature_unmanage + WORKSPACE instructions"
```

---

### Task 9: Full-suite green + tsc, final wiring check

**Files:** none (verification task)

- [ ] **Step 1: Run the whole suite**

Run: `npm test`
Expected: all green (existing 195 + the new workspace/orient/dashboard tests).

- [ ] **Step 2: Typecheck**

Run: `npx tsc -b`
Expected: clean.

- [ ] **Step 3: Confirm the seed exists**

Run: `ls ~/projects/github-moran/features/_bmad >/dev/null && echo SEED-OK || echo SEED-MISSING`
Expected: `SEED-OK` (built 2026-07-16). If missing, the workspace_set path still works but reports `seedMissing` — note it for Moran.

- [ ] **Step 4: Commit any final fixups**

```bash
git add -A
git commit -m "chore(workspace): full-suite green + tsc clean" --allow-empty
```

---

## Notes for the implementer

- **Confirm `alreadyShown` id collection in Task 5:** `DashboardWorkItem.id` is a string; wrap in `Number(...)` when building the `Set<number>`. Collect from `inProgress`, `upNext`, and `done`.
- **Confirm the drawer-open handler name in Task 6** from the existing row click handlers in `Dashboard.tsx` — do not invent `onOpenItem` if the real prop is named differently.
- **Confirm token variable names in Task 6 CSS** against what `dashboard.css` already defines (`--ink-1/2/3/4`, `--line-1`, `--accent` are used elsewhere but verify).
- **Import path style:** mcp/server.ts imports server modules as `../server/<mod>` while server modules import siblings as `./<mod>`. Match the file you're editing.
- After the whole plan: MCP tools take effect only after `/exit` + `claude --resume` in a chat; the dashboard changes need a dev-server restart + hard refresh. These are Moran smokes, not automated.
