# D&D (Discovery & Design) Page — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the D&D dashboard page (discovery half): a new `dnd` mode showing a status-grouped list of touched features, each opening a read-only detail page with two light actions.

**Architecture:** One new pure server module (`server/discovery-list.ts`) turns workspace folders into a status-grouped feature list; one new `/api/discovery` Vite-middleware route internally routes list / detail / demo / open-folder (the same one-mount-internal-router pattern `/api/workitem/` uses); one new front-end component (`DnDView.tsx`) renders list↔detail with plain state; the `dnd` mode is wired into the existing `useMode` / rail / mode-ternary machinery. Styles use a fresh `dnd-*` namespace in the single `dashboard.css`.

**Tech Stack:** TypeScript (ESM, project references), React 18 + Vite 5, Vitest 4, Node `child_process` for the reveal action. No new dependencies.

## Global Constraints

- **Type-check with `npm run typecheck`** (= `tsc -b --noEmit`). Bare `tsc --noEmit` checks nothing here (root tsconfig has `files: []`). Vitest does not type-check.
- **Run tests with `npm test`** (= `vitest run`).
- **Pure logic never throws on bad input** — parsers/readers return a safe empty state, matching `server/discovery.ts` and `server/workspace.ts` discipline.
- **Names before numbers** — any feature reference shown to the user is the pre-formatted `displayName` string `**<title>** (#<id>)`; never a bare id, never id-first. `#<id>` alone is allowed ONLY as an ADO-unreachable fallback (no title available).
- **One Vite middleware mount per resource, internal routing** — do NOT register two overlapping `/api/discovery` mounts; Connect matches by prefix and the first would swallow the second. Follow `/api/workitem/`: one handler, parse `req.url`.
- **Route handlers are thin glue** — they compose tested pure functions; smoke-tested by the user on reload, not unit-tested (repo convention: MCP/`/api` glue is not unit-tested).
- **No editing of discovery content from the page** — only the `demo` field is writable, via the mark-demo action.
- **Design half is out of scope** — build only a reserved, labelled "Design not started" slot.
- **Discovery doc shape** (from `server/discovery.ts`, do not redefine): `DiscoveryDoc = { problem: string; flow: string[]; groups: { name: string; items: { text: string; tags: ('diff'|'risk'|'fact'|'option')[] }[] }[]; lanes: { ours: string; techLead: string }; demo: { status: 'none'|'scheduled'|'built'; shape: string; date: string }; openQuestions: string[] }`.
- **UI rules:** dark/warm palette, one accent, no pulsing, one focal point, generous whitespace; never combine ≤11px text with the faintest ink; plain English, no agile jargon.

---

### Task 1: `server/discovery-list.ts` — the pure list logic

**Files:**
- Create: `server/discovery-list.ts`
- Test: `server/discovery-list.test.ts`

**Interfaces:**
- Consumes: nothing from other tasks. Mirrors (does NOT import) the `<id>-<slug>` naming from `featureFolderName` in `server/workspace.ts` — this module is its inverse.
- Produces (later tasks rely on these exact signatures):
  - `type DndStatus = 'in-progress' | 'not-started' | 'finished' | 'closed'`
  - `interface TouchedFeature { id: number; folderPath: string }`
  - `interface FeatureListEntry { id: number; displayName: string; folderPath: string; dndStatus: DndStatus; boardState: string | null; dayLabel: string | null }`
  - `interface FeatureSection { status: DndStatus; features: FeatureListEntry[] }`
  - `parseFeatureFolder(name: string): { id: number } | null`
  - `listTouchedFeatureFolders(workspacePaths: string[], readdir: (dir: string) => string[]): TouchedFeature[]`
  - `deriveDndStatus(args: { hasDiscovery: boolean; finished: boolean; boardClosed: boolean }): DndStatus`
  - `groupByDndStatus(entries: FeatureListEntry[]): FeatureSection[]`

**Notes for the implementer:**
- A feature folder is named `<id>-<slug>` or bare `<id>` (a symbol-only title yields just the id, per `featureFolderName`). `parseFeatureFolder` accepts a leading run of digits that is either the whole name or immediately followed by `-`. `"426639-declarative-cd"` → `{ id: 426639 }`; `"426639"` → `{ id: 426639 }`; `"notes"` → `null`; `"12ab"` → `null`.
- `listTouchedFeatureFolders` reads each workspace path's immediate child names via the injected `readdir` (no fs in tests), keeps those `parseFeatureFolder` accepts, returns `{ id, folderPath: join(workspacePath, name) }`. A `readdir` that throws for one path is caught and skipped, never aborts the scan. De-duplicate by `id`, first occurrence wins.
- `deriveDndStatus` precedence: `boardClosed` → `'closed'`; else `finished` → `'finished'`; else `hasDiscovery` → `'in-progress'`; else `'not-started'`.
- `groupByDndStatus` returns sections in FIXED order `['in-progress', 'not-started', 'finished', 'closed']`, each with its matching entries in input order; omit a section with no features.

- [ ] **Step 1: Write the failing tests**

Create `server/discovery-list.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
  parseFeatureFolder,
  listTouchedFeatureFolders,
  deriveDndStatus,
  groupByDndStatus,
  type FeatureListEntry,
} from './discovery-list';

describe('parseFeatureFolder', () => {
  it('parses <id>-<slug>', () => {
    expect(parseFeatureFolder('426639-declarative-cd')).toEqual({ id: 426639 });
  });
  it('parses a bare <id> (symbol-only title case)', () => {
    expect(parseFeatureFolder('426639')).toEqual({ id: 426639 });
  });
  it('rejects a non-feature folder', () => {
    expect(parseFeatureFolder('notes')).toBeNull();
  });
  it('rejects digits glued to letters', () => {
    expect(parseFeatureFolder('12ab')).toBeNull();
  });
});

describe('listTouchedFeatureFolders', () => {
  const readdir = (dir: string): string[] => {
    if (dir === '/ws') return ['426639-declarative-cd', 'notes', '999'];
    if (dir === '/ws2') return ['426639-declarative-cd', 'design-system-500'];
    if (dir === '/missing') throw new Error('ENOENT');
    return [];
  };
  it('keeps only feature folders, joins the path', () => {
    expect(listTouchedFeatureFolders(['/ws'], readdir)).toEqual([
      { id: 426639, folderPath: '/ws/426639-declarative-cd' },
      { id: 999, folderPath: '/ws/999' },
    ]);
  });
  it('skips a workspace whose readdir throws', () => {
    expect(listTouchedFeatureFolders(['/missing', '/ws'], readdir)).toEqual([
      { id: 426639, folderPath: '/ws/426639-declarative-cd' },
      { id: 999, folderPath: '/ws/999' },
    ]);
  });
  it('de-dupes by id across workspaces (first wins)', () => {
    const out = listTouchedFeatureFolders(['/ws', '/ws2'], readdir);
    expect(out.filter(f => f.id === 426639)).toEqual([
      { id: 426639, folderPath: '/ws/426639-declarative-cd' },
    ]);
  });
});

describe('deriveDndStatus', () => {
  it('closed wins over everything', () => {
    expect(deriveDndStatus({ hasDiscovery: true, finished: true, boardClosed: true })).toBe('closed');
  });
  it('finished when done and not closed', () => {
    expect(deriveDndStatus({ hasDiscovery: true, finished: true, boardClosed: false })).toBe('finished');
  });
  it('in-progress when a doc exists but is unfinished', () => {
    expect(deriveDndStatus({ hasDiscovery: true, finished: false, boardClosed: false })).toBe('in-progress');
  });
  it('not-started when no doc', () => {
    expect(deriveDndStatus({ hasDiscovery: false, finished: false, boardClosed: false })).toBe('not-started');
  });
});

describe('groupByDndStatus', () => {
  const mk = (id: number, dndStatus: FeatureListEntry['dndStatus']): FeatureListEntry => ({
    id, displayName: `**F${id}** (#${id})`, folderPath: `/ws/${id}`, dndStatus, boardState: null, dayLabel: null,
  });
  it('orders sections and omits empty ones', () => {
    const out = groupByDndStatus([mk(1, 'finished'), mk(2, 'in-progress'), mk(3, 'finished')]);
    expect(out.map(s => s.status)).toEqual(['in-progress', 'finished']);
    expect(out[0].features.map(f => f.id)).toEqual([2]);
    expect(out[1].features.map(f => f.id)).toEqual([1, 3]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- discovery-list`
Expected: FAIL — `Cannot find module './discovery-list'`.

- [ ] **Step 3: Implement `server/discovery-list.ts`**

```ts
// server/discovery-list.ts
/**
 * Pure logic for the D&D page's feature list: turn workspace folders into a
 * status-grouped list of the features Moran has touched. No fs/ADO here — the
 * route glue injects readdir and supplies discovery/board status. Never throws.
 */
import { join } from 'node:path';

export type DndStatus = 'in-progress' | 'not-started' | 'finished' | 'closed';

export interface TouchedFeature { id: number; folderPath: string }

export interface FeatureListEntry {
  id: number;
  displayName: string;       // **<title>** (#<id>) — names before numbers
  folderPath: string;
  dndStatus: DndStatus;
  boardState: string | null; // ADO state of the discovery story, null if unresolved
  dayLabel: string | null;   // e.g. "day 2 of 2", only for the active feature
}

export interface FeatureSection { status: DndStatus; features: FeatureListEntry[] }

const SECTION_ORDER: DndStatus[] = ['in-progress', 'not-started', 'finished', 'closed'];

/** Parse a `<id>-<slug>` or bare `<id>` feature-folder name. Non-feature → null. */
export function parseFeatureFolder(name: string): { id: number } | null {
  const m = name.match(/^(\d+)(?:-.*)?$/);
  if (!m) return null;
  return { id: Number(m[1]) };
}

/** Scan each workspace's immediate children for feature folders. readdir is
 *  injected (testable, no fs). A path whose readdir throws is skipped. Deduped
 *  by id, first occurrence wins. */
export function listTouchedFeatureFolders(
  workspacePaths: string[],
  readdir: (dir: string) => string[],
): TouchedFeature[] {
  const seen = new Set<number>();
  const out: TouchedFeature[] = [];
  for (const ws of workspacePaths) {
    let names: string[];
    try { names = readdir(ws); } catch { continue; }
    for (const name of names) {
      const parsed = parseFeatureFolder(name);
      if (!parsed || seen.has(parsed.id)) continue;
      seen.add(parsed.id);
      out.push({ id: parsed.id, folderPath: join(ws, name) });
    }
  }
  return out;
}

export function deriveDndStatus(args: {
  hasDiscovery: boolean; finished: boolean; boardClosed: boolean;
}): DndStatus {
  if (args.boardClosed) return 'closed';
  if (args.finished) return 'finished';
  if (args.hasDiscovery) return 'in-progress';
  return 'not-started';
}

/** Group entries into fixed-order sections, omitting empty ones. */
export function groupByDndStatus(entries: FeatureListEntry[]): FeatureSection[] {
  return SECTION_ORDER
    .map(status => ({ status, features: entries.filter(e => e.dndStatus === status) }))
    .filter(s => s.features.length > 0);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- discovery-list`
Expected: PASS (all cases green).

- [ ] **Step 5: Type-check**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add server/discovery-list.ts server/discovery-list.test.ts
git commit -m "feat(dnd): pure feature-list logic for the D&D page"
```

---

### Task 2: `/api/discovery` route (list + detail + demo + open-folder) and front-end fetches

**Files:**
- Modify: `vite.config.ts` (add ONE `server.middlewares.use('/api/discovery', …)` block after the `/api/preplan` block, ~line 422, inside `configureServer`)
- Modify: `src/lib/api.ts` (add `'dnd'` to `ModeId`; add list/detail/demo/open-folder types + fetch functions)

**Interfaces:**
- Consumes (Task 1): `listTouchedFeatureFolders`, `deriveDndStatus`, `groupByDndStatus`, types `FeatureListEntry`/`DndStatus`.
- Consumes (existing): `getWorkspaces` + `getActiveFeature` (`server/workspace.ts`); `discoveryStatus`, `readDiscoveryDoc`, `writeDiscoveryDoc` (`server/discovery-store.ts`); `getWorkItem` (`server/ado.ts`) → `WorkItemDetail { title; state; children: { id; title; type; state }[] }`; `isDiscoveryStoryTitle` + `discoveryDayStage` (`server/discovery.ts`).
- Produces (front end): `fetchDiscoveryList()`, `fetchDiscoveryDetail(id)`, `markDiscoveryDemo(id, body)`, `openDiscoveryFolder(id)`, and the types below.

**Single-mount internal routing (critical — see Global Constraints).** Mounted at `/api/discovery`, Connect strips the mount, so `req.url` is `/` (or empty) for the list, `/426639` for detail, `/426639/demo`, `/426639/open-folder`. One handler parses this and branches. Do NOT add a second `/api/discovery/` mount.

**Per-branch behavior:**
- **List** (path `/` or empty, GET): build the touched list from `getWorkspaces().paths` + injected `readdirSync` (directories only). For each feature, `discoveryStatus(folderPath)` for `hasDiscovery`/`finished`; `getWorkItem(id)` (try/catch) for the feature `title` and the discovery-story child (`type === 'User Story'` and `isDiscoveryStoryTitle(child.title)`) whose `state` → `boardState`, `boardClosed = state === 'Closed'`. `displayName = title ? \`**${title}** (#${id})\` : \`#${id}\``. `dayLabel`: only when the entry is the active feature (`getActiveFeature().id === id`) AND `dndStatus === 'in-progress'` → `\`day ${discoveryDayStage({firstSessionAt: active.setAt, now}).workday} of 2\``, else `null`. Respond `{ sections: groupByDndStatus(entries) }`.
- **Detail** (path `/<id>`, GET): resolve the folder by id from the touched list; 404 if not touched. `{ displayName, folderPath, doc: readDiscoveryDoc(folderPath) }` (doc may be `null`).
- **Demo** (path `/<id>/demo`, POST): validate `status ∈ {none,scheduled,built}` (400 else); `date` string default `''`. Read doc; 409 `{ error: 'no discovery to mark' }` if null; set `doc.demo = { status, shape: doc.demo.shape, date }`; `writeDiscoveryDoc(folderPath, doc, displayName)`; respond `{ demo: doc.demo }`.
- **Open-folder** (path `/<id>/open-folder`, POST): `spawn('open', [join(folderPath, 'discovery')], { detached: true, stdio: 'ignore' }).unref()` in try/catch; respond `{ ok: true|false }` (never 500 — a failed reveal isn't a server error).
- Wrong method per branch → 405. Unmatched path → 400. Never trust a client-supplied folder path — always resolve from the id.

- [ ] **Step 1: Add the route to `vite.config.ts`**

Insert after the `/api/preplan` block (after ~line 422):

```ts
      server.middlewares.use('/api/discovery', async (req, res) => {
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Cache-Control', 'no-store');
        try {
          const url = new URL(req.url ?? '/', 'http://localhost');
          const path = url.pathname; // '/' | '' for list, '/426639', '/426639/demo', '/426639/open-folder'
          const method = req.method ?? 'GET';

          const { getWorkspaces, getActiveFeature } = await import('./server/workspace');
          const { listTouchedFeatureFolders, deriveDndStatus, groupByDndStatus } = await import('./server/discovery-list');
          const { discoveryStatus, readDiscoveryDoc, writeDiscoveryDoc } = await import('./server/discovery-store');
          const { getWorkItem } = await import('./server/ado');
          const { isDiscoveryStoryTitle, discoveryDayStage } = await import('./server/discovery');
          const { readdirSync } = await import('node:fs');

          const touched = listTouchedFeatureFolders(
            getWorkspaces().paths,
            (dir) => readdirSync(dir, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name),
          );

          // ---- LIST ----
          if (path === '/' || path === '') {
            if (method !== 'GET') { res.statusCode = 405; res.end(JSON.stringify({ error: 'GET only' })); return; }
            const active = getActiveFeature();
            const now = new Date();
            const entries = await Promise.all(touched.map(async (f) => {
              const status = discoveryStatus(f.folderPath);
              let title: string | null = null;
              let boardState: string | null = null;
              let boardClosed = false;
              try {
                const wi = await getWorkItem(f.id);
                title = wi.title;
                const story = wi.children.find(c => c.type === 'User Story' && isDiscoveryStoryTitle(c.title));
                if (story) { boardState = story.state; boardClosed = story.state === 'Closed'; }
              } catch { /* ADO down — list from folder truth */ }
              const dndStatus = deriveDndStatus({ hasDiscovery: status.hasDiscovery, finished: status.finished, boardClosed });
              let dayLabel: string | null = null;
              if (active && active.id === f.id && dndStatus === 'in-progress') {
                const { workday } = discoveryDayStage({ firstSessionAt: active.setAt, now });
                dayLabel = `day ${workday} of 2`;
              }
              return {
                id: f.id,
                displayName: title ? `**${title}** (#${f.id})` : `#${f.id}`,
                folderPath: f.folderPath,
                dndStatus, boardState, dayLabel,
              };
            }));
            res.end(JSON.stringify({ sections: groupByDndStatus(entries) }));
            return;
          }

          // ---- DETAIL / ACTIONS (/<id>[/demo|/open-folder]) ----
          const m = path.match(/^\/(\d+)(?:\/(demo|open-folder))?\/?$/);
          if (!m) { res.statusCode = 400; res.end(JSON.stringify({ error: 'Expected /api/discovery/<id>[/demo|/open-folder]' })); return; }
          const id = Number(m[1]);
          const action = m[2]; // 'demo' | 'open-folder' | undefined
          const feature = touched.find(f => f.id === id);
          if (!feature) { res.statusCode = 404; res.end(JSON.stringify({ error: 'Not a touched feature' })); return; }
          const folderPath = feature.folderPath;

          let displayName = `#${id}`;
          try { const wi = await getWorkItem(id); displayName = `**${wi.title}** (#${id})`; } catch { /* ADO down */ }

          if (!action) {
            if (method !== 'GET') { res.statusCode = 405; res.end(JSON.stringify({ error: 'GET only' })); return; }
            res.end(JSON.stringify({ displayName, folderPath, doc: readDiscoveryDoc(folderPath) }));
            return;
          }

          if (action === 'demo') {
            if (method !== 'POST') { res.statusCode = 405; res.end(JSON.stringify({ error: 'POST only' })); return; }
            const body = (await readJsonBody(req)) as { status?: unknown; date?: unknown };
            const status = body.status;
            if (status !== 'none' && status !== 'scheduled' && status !== 'built') {
              res.statusCode = 400; res.end(JSON.stringify({ error: 'status must be none | scheduled | built' })); return;
            }
            const date = typeof body.date === 'string' ? body.date : '';
            const doc = readDiscoveryDoc(folderPath);
            if (!doc) { res.statusCode = 409; res.end(JSON.stringify({ error: 'no discovery to mark' })); return; }
            doc.demo = { status, shape: doc.demo.shape, date };
            writeDiscoveryDoc(folderPath, doc, displayName);
            res.end(JSON.stringify({ demo: doc.demo }));
            return;
          }

          // action === 'open-folder'
          if (method !== 'POST') { res.statusCode = 405; res.end(JSON.stringify({ error: 'POST only' })); return; }
          const { spawn } = await import('node:child_process');
          const { join } = await import('node:path');
          let ok = true;
          try { spawn('open', [join(folderPath, 'discovery')], { detached: true, stdio: 'ignore' }).unref(); }
          catch { ok = false; }
          res.end(JSON.stringify({ ok }));
        } catch (err) {
          const message = err instanceof Error ? err.message : 'unknown error';
          res.statusCode = 500;
          res.end(JSON.stringify({ error: message }));
        }
      });
```

- [ ] **Step 2: Add front-end types + fetches to `src/lib/api.ts`**

Add `'dnd'` to `ModeId` (line 193):

```ts
export type ModeId = 'day' | 'preplan' | 'plan' | 'demo' | 'retro' | 'dnd';
```

Add after `ApiDiscovery` (~line 235):

```ts
export type DndStatus = 'in-progress' | 'not-started' | 'finished' | 'closed';

export interface ApiFeatureListEntry {
  id: number;
  displayName: string;
  folderPath: string;
  dndStatus: DndStatus;
  boardState: string | null;
  dayLabel: string | null;
}
export interface ApiFeatureSection { status: DndStatus; features: ApiFeatureListEntry[] }
export interface DiscoveryListPayload { sections: ApiFeatureSection[] }

export interface ApiDiscoveryItem { text: string; tags: ('diff'|'risk'|'fact'|'option')[] }
export interface ApiDiscoveryGroup { name: string; items: ApiDiscoveryItem[] }
export interface ApiDiscoveryDoc {
  problem: string;
  flow: string[];
  groups: ApiDiscoveryGroup[];
  lanes: { ours: string; techLead: string };
  demo: { status: 'none'|'scheduled'|'built'; shape: string; date: string };
  openQuestions: string[];
}
export interface DiscoveryDetailPayload {
  displayName: string;
  folderPath: string;
  doc: ApiDiscoveryDoc | null;
}

export async function fetchDiscoveryList(): Promise<DiscoveryListPayload> {
  const r = await fetch('/api/discovery', { cache: 'no-store' });
  if (!r.ok) throw new Error(`discovery list failed: ${r.status}`);
  return r.json() as Promise<DiscoveryListPayload>;
}

export async function fetchDiscoveryDetail(id: number): Promise<DiscoveryDetailPayload> {
  const r = await fetch(`/api/discovery/${encodeURIComponent(id)}`, { cache: 'no-store' });
  if (!r.ok) throw new Error(`discovery detail failed: ${r.status}`);
  return r.json() as Promise<DiscoveryDetailPayload>;
}

export async function markDiscoveryDemo(
  id: number, body: { status: 'none'|'scheduled'|'built'; date: string },
): Promise<{ demo: ApiDiscoveryDoc['demo'] }> {
  const r = await fetch(`/api/discovery/${encodeURIComponent(id)}/demo`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`mark demo failed: ${r.status}`);
  return r.json() as Promise<{ demo: ApiDiscoveryDoc['demo'] }>;
}

export async function openDiscoveryFolder(id: number): Promise<{ ok: boolean }> {
  const r = await fetch(`/api/discovery/${encodeURIComponent(id)}/open-folder`, { method: 'POST' });
  if (!r.ok) throw new Error(`open folder failed: ${r.status}`);
  return r.json() as Promise<{ ok: boolean }>;
}
```

- [ ] **Step 3: Type-check**

Run: `npm run typecheck`
Expected: no errors. Adding `'dnd'` to `ModeId` does not break `useMode.ts` (its `MODES` is a runtime subset check; Task 3 adds `'dnd'` there) — the `mode !== 'day'` fallback in `Dashboard.tsx` already handles any unknown mode via `ModePlaceholder`.

- [ ] **Step 4: Run the existing suite**

Run: `npm test`
Expected: all previously-green tests still pass (no behavior change to existing modules).

- [ ] **Step 5: Commit**

```bash
git add vite.config.ts src/lib/api.ts
git commit -m "feat(dnd): /api/discovery route (list/detail/demo/open-folder) + fetches"
```

---

### Task 3: `DnDView` component + wire the `dnd` mode

**Files:**
- Create: `src/components/DnDView.tsx`
- Modify: `src/lib/useMode.ts:4` (add `'dnd'` to `MODES`)
- Modify: `src/components/Dashboard.tsx` (import `DnDView`; add a rail tile in `R21_MODES` ~500; add a `mode === 'dnd'` branch in the mode ternary ~306-311)

**Interfaces:**
- Consumes (Task 2): `fetchDiscoveryList`, `fetchDiscoveryDetail`, `markDiscoveryDemo`, `openDiscoveryFolder`, types `ApiFeatureSection`, `DiscoveryDetailPayload`, `DndStatus`.
- Produces: `export function DnDView(): JSX.Element`.

**Notes for the implementer:**
- State: `selectedId: number | null` (null → list, set → detail); list payload; detail payload; error. On mount fetch the list. On `selectedId` set, fetch that detail. "Back" → `null` + re-fetch the list.
- **Version-skew guard:** if the list fetch resolves without a `sections` array, render the empty state, not a crash (mirror `RailDiscovery`).
- **Empty state** (no sections): a calm line — "Discoveries show up here once you start one. Run `/sprint-helper:discovery` in a workspace to begin."
- **displayName rendering:** render the `**bold**` span as bold; never show raw `**`. A minimal inline parse (below) is fine.
- **List:** each section = a plain-label heading (`in-progress`→"In progress", `not-started`→"Not started", `finished`→"Finished", `closed`→"Closed") + rows. Each row is a button showing the displayName, the `boardState` chip when non-null, the `dayLabel` when non-null.
- **Detail:** back button; main column = problem (header) → flow (numbered) → groups (name + items, each item's tags as small chips); side panel = demo (status + date + Save), lanes, open questions, and a "Design not started" slot; plus an "Open folder" button (on `{ok:false}` reveal the path as selectable text). If `doc` is null: main shows "This feature has no discovery yet.", back still works.
- All classes under `dnd-*` (styled in Task 4). Structural markup only here.

- [ ] **Step 1: Create `src/components/DnDView.tsx`**

```tsx
import { useCallback, useEffect, useState } from 'react';
import {
  fetchDiscoveryList, fetchDiscoveryDetail, markDiscoveryDemo, openDiscoveryFolder,
  type ApiFeatureSection, type DiscoveryDetailPayload, type DndStatus,
} from '../lib/api';

const STATUS_LABEL: Record<DndStatus, string> = {
  'in-progress': 'In progress',
  'not-started': 'Not started',
  'finished': 'Finished',
  'closed': 'Closed',
};

/** Render a displayName's **bold** span without showing raw asterisks. */
function renderDisplayName(s: string): JSX.Element {
  const m = s.match(/^\*\*(.+?)\*\*\s*(.*)$/);
  if (!m) return <span>{s}</span>;
  return <span><strong>{m[1]}</strong> {m[2]}</span>;
}

export function DnDView(): JSX.Element {
  const [sections, setSections] = useState<ApiFeatureSection[] | null>(null);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [detail, setDetail] = useState<DiscoveryDetailPayload | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadList = useCallback(() => {
    setError(null);
    fetchDiscoveryList()
      .then(p => setSections(Array.isArray(p?.sections) ? p.sections : []))
      .catch(e => setError(String(e)));
  }, []);

  useEffect(() => { loadList(); }, [loadList]);

  useEffect(() => {
    if (selectedId == null) { setDetail(null); return; }
    setError(null);
    fetchDiscoveryDetail(selectedId).then(setDetail).catch(e => setError(String(e)));
  }, [selectedId]);

  if (selectedId != null) {
    return <DnDDetail
      payload={detail}
      error={error}
      onBack={() => { setSelectedId(null); loadList(); }}
      onReload={() => fetchDiscoveryDetail(selectedId).then(setDetail).catch(e => setError(String(e)))}
    />;
  }

  return (
    <div className="dnd-list">
      <h1 className="dnd-title">Discovery &amp; Design</h1>
      {error && <div className="dnd-error">Couldn’t load discoveries: {error}</div>}
      {sections && sections.length === 0 && (
        <div className="dnd-empty">
          Discoveries show up here once you start one. Run <code>/sprint-helper:discovery</code> in a workspace to begin.
        </div>
      )}
      {sections?.map(sec => (
        <section key={sec.status} className={`dnd-section is-${sec.status}`}>
          <h2 className="dnd-section-head">{STATUS_LABEL[sec.status]}</h2>
          <ul className="dnd-rows">
            {sec.features.map(f => (
              <li key={f.id}>
                <button className="dnd-row" onClick={() => setSelectedId(f.id)}>
                  <span className="dnd-row-name">{renderDisplayName(f.displayName)}</span>
                  {f.boardState && <span className={`dnd-chip is-${f.boardState.toLowerCase()}`}>{f.boardState}</span>}
                  {f.dayLabel && <span className="dnd-day">{f.dayLabel}</span>}
                </button>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

function DnDDetail(props: {
  payload: DiscoveryDetailPayload | null;
  error: string | null;
  onBack: () => void;
  onReload: () => void;
}): JSX.Element {
  const { payload, error, onBack, onReload } = props;
  const [demoStatus, setDemoStatus] = useState<'none'|'scheduled'|'built'>('none');
  const [demoDate, setDemoDate] = useState('');
  const [folderMsg, setFolderMsg] = useState<string | null>(null);

  useEffect(() => {
    if (payload?.doc) { setDemoStatus(payload.doc.demo.status); setDemoDate(payload.doc.demo.date); }
  }, [payload]);

  const back = <button className="dnd-back" onClick={onBack}>← all features</button>;

  if (error) return <div className="dnd-detail">{back}<div className="dnd-error">Couldn’t read this discovery: {error}</div></div>;
  if (!payload) return <div className="dnd-detail">{back}<div className="dnd-loading">Loading…</div></div>;

  const { doc, displayName, folderPath } = payload;
  const id = Number(displayName.match(/#(\d+)/)?.[1] ?? 0);

  return (
    <div className="dnd-detail">
      {back}
      <h1 className="dnd-detail-title">{renderDisplayName(displayName)}</h1>
      {!doc ? (
        <div className="dnd-empty">This feature has no discovery yet.</div>
      ) : (
        <div className="dnd-detail-body">
          <div className="dnd-main">
            <p className="dnd-problem">{doc.problem || '—'}</p>
            <h2 className="dnd-h2">The feature end-to-end</h2>
            <ol className="dnd-flow">{doc.flow.map((s, i) => <li key={i}>{s}</li>)}</ol>
            <h2 className="dnd-h2">Context groups</h2>
            {doc.groups.map((g, gi) => (
              <div key={gi} className="dnd-group">
                <h3 className="dnd-group-name">{g.name}</h3>
                <ul className="dnd-items">
                  {g.items.map((it, ii) => (
                    <li key={ii} className="dnd-item">
                      <span className="dnd-item-text">{it.text}</span>
                      {it.tags.map(t => <span key={t} className={`dnd-tag is-${t}`}>{t}</span>)}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
          <aside className="dnd-side">
            <section className="dnd-side-block">
              <h3 className="dnd-side-head">Demo</h3>
              <select value={demoStatus} onChange={e => setDemoStatus(e.target.value as 'none'|'scheduled'|'built')}>
                <option value="none">none</option>
                <option value="scheduled">scheduled</option>
                <option value="built">built</option>
              </select>
              <input type="date" value={demoDate} onChange={e => setDemoDate(e.target.value)} />
              <button onClick={() => markDiscoveryDemo(id, { status: demoStatus, date: demoDate }).then(onReload)}>Save</button>
            </section>
            <section className="dnd-side-block">
              <h3 className="dnd-side-head">Lanes</h3>
              <p>Ours: {doc.lanes.ours || '—'}</p>
              <p>Tech lead’s: {doc.lanes.techLead || '—'}</p>
            </section>
            <section className="dnd-side-block">
              <h3 className="dnd-side-head">Open questions</h3>
              <ul>{doc.openQuestions.map((q, i) => <li key={i}>{q}</li>)}</ul>
            </section>
            <section className="dnd-side-block is-design">
              <h3 className="dnd-side-head">Design</h3>
              <p className="dnd-muted">Design not started</p>
            </section>
            <section className="dnd-side-block">
              <button onClick={() => openDiscoveryFolder(id).then(r => { if (!r.ok) setFolderMsg(folderPath); })}>Open folder</button>
              {folderMsg && <code className="dnd-path">{folderMsg}</code>}
            </section>
          </aside>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Add `'dnd'` to `MODES` in `src/lib/useMode.ts` (line 4)**

```ts
const MODES: ModeId[] = ['day', 'preplan', 'plan', 'demo', 'retro', 'dnd'];
```

- [ ] **Step 3: Wire the rail tile + mode branch in `src/components/Dashboard.tsx`**

Add near the PlanView/PrePlanView imports (~line 43-44):

```tsx
import { DnDView } from './DnDView';
```

Add an entry to `R21_MODES` (~line 500), copying a sibling entry's shape and swapping the glyph path:

```tsx
  { id: 'dnd', label: 'D&D', glyph: (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8">
      <circle cx="12" cy="12" r="9" /><path d="M12 3v3M12 18v3M3 12h3M18 12h3" />
    </svg>
  ) },
```

In the mode ternary, add a `dnd` branch **immediately before** the `mode !== 'day'` (`ModePlaceholder`) branch, so `dnd` renders `DnDView` instead of the placeholder. The existing branch order is: `plan` → `preplan` → (`mode !== 'day'` → placeholder) → `isFocus` → DailyView. Insert `: mode === 'dnd' ? (<DnDView />)` between the `preplan` branch and the `mode !== 'day'` branch. Leave every other branch exactly as-is:

```tsx
          ) : mode === 'preplan' ? (
            <PrePlanView onOpenItem={openItem} />
          ) : mode === 'dnd' ? (
            <DnDView />
          ) : mode !== 'day' ? (
            <ModePlaceholder mode={mode} />
```

- [ ] **Step 4: Type-check + build**

Run: `npm run typecheck`
Expected: no errors.
Run: `npm run build`
Expected: build succeeds (compiles the front end; catches JSX/type mistakes the dev server hides).

- [ ] **Step 5: Run the suite**

Run: `npm test`
Expected: all existing tests still green (this task adds no unit tests; the tested logic is Task 1, the component is plain state).

- [ ] **Step 6: Commit**

```bash
git add src/components/DnDView.tsx src/lib/useMode.ts src/components/Dashboard.tsx
git commit -m "feat(dnd): DnDView list+detail and dnd mode wiring"
```

---

### Task 4: `dnd-*` styles

**Files:**
- Modify: `src/styles/dashboard.css` (append a `dnd-*` section at the end)

**Interfaces:**
- Consumes: the class names `DnDView` emits (Task 3): `dnd-list`, `dnd-title`, `dnd-section`, `dnd-section-head`, `dnd-rows`, `dnd-row`, `dnd-row-name`, `dnd-chip`, `dnd-day`, `dnd-empty`, `dnd-error`, `dnd-loading`, `dnd-detail`, `dnd-back`, `dnd-detail-title`, `dnd-detail-body`, `dnd-main`, `dnd-side`, `dnd-problem`, `dnd-h2`, `dnd-flow`, `dnd-group`, `dnd-group-name`, `dnd-items`, `dnd-item`, `dnd-item-text`, `dnd-tag`, `dnd-side-block`, `dnd-side-head`, `dnd-muted`, `dnd-path`, plus modifiers `is-diff`/`is-risk`/`is-fact`/`is-option` (tags), `is-active`/`is-closed`/`is-blocked`/`is-new` (board chips), `is-in-progress`/`is-not-started`/`is-finished`/`is-closed` (sections), `is-design`.
- Produces: no code interface.

**Notes for the implementer:**
- Reuse the existing CSS custom properties in `dashboard.css` (`--ink-*`, surface, the single accent). Do NOT add colors outside the existing palette.
- Detail body two-column: `.dnd-detail-body { display: grid; grid-template-columns: minmax(0, 1fr) 320px; gap: … }`. `@media (max-width: 900px)` → one column, side panel below main. Follow the Plan view's responsive approach.
- Tag chips: distinct-but-calm per tag; give `risk` the most weight. Never combine ≤11px text with the faintest ink.
- `In progress` section may get a subtle accent so it reads as "what needs me" — no pulsing, no animation beyond existing transition tokens.
- The flow is the visual focal point of the detail page: it gets the most vertical space and the clearest type; groups read as supporting detail below it.

- [ ] **Step 1: Append the `dnd-*` block to `src/styles/dashboard.css`**

Write complete rules for every class above, based on the existing `plan2-*`/`r21-*` rules for spacing and type so it sits consistently. (Concrete CSS is written here, verified visually in Step 2 — presentation, not a unit test.)

- [ ] **Step 2: Visual check (user smoke)**

Run: `npm run dev`, open `http://localhost:7777/?mode=dnd`.
Expected: features grouped by status; clicking one opens the detail (flow + groups in the main column; demo/lanes/questions/design in the side panel); back returns to the list; Mark demo saves; Open folder opens the `discovery/` folder.

- [ ] **Step 3: Type-check + build**

Run: `npm run typecheck && npm run build`
Expected: both succeed.

- [ ] **Step 4: Commit**

```bash
git add src/styles/dashboard.css
git commit -m "feat(dnd): dnd-* styles for the D&D page"
```

---

## Notes carried from the spec (not tasks)

- **Day-count simplification:** `dayLabel` shows only for the active feature (the one with a stored `setAt`), matching how `orient` sources the day-count today. Anchoring to the discovery session's first timer is a later refinement, out of scope.
- **Seed-sync gap:** unrelated to this plan; noted so nobody expects the D&D page to change how skills reach workspaces.
- **Design half:** the reserved "Design not started" slot is the only design-related thing built. A future plan adds a parallel `readDesignDoc`/`designStatus` to fill it.
