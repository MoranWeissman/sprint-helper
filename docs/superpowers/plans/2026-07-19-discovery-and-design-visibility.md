# Discovery & Design — Dashboard Visibility — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Make live sessions on out-of-sprint items (managed features) visible in Focus, and add a "Discovery & Design" rail card showing the active feature + folder + managed features.

**Architecture:** Two pure server helpers feed two new OPTIONAL payload fields (`liveOutsideSprint`, `discovery`). The client merges `liveOutsideSprint` into Focus's item list and renders a `RailDiscovery` card mirroring `RailNeedsYou`. No new persistence — reads existing settings state (`active_feature`, `managed_feature_ids`, `workspace_paths`) and live sessions.

**Tech Stack:** TypeScript, @modelcontextprotocol/sdk, better-sqlite3, React/Vite, Vitest.

## Global Constraints

- **Plain English to Moran** in any user-facing string; banned words: "slack", "cleanup moves", "pending decisions", "outstanding items", "open threads", "burndown", "scope" (noun), "velocity", "throughput", "WIP", "in-flight items", "work item", "blockers" (collective).
- **Names before numbers:** every work item reference the card shows is `**title** (#id)` — build via the same shape used elsewhere (`**${title}** (#${id})`).
- **Sprint math is sacred:** `liveOutsideSprint` items reach Focus ONLY. They must NOT enter inProgress/upNext/done, capacity, counts, or the Daily story grouping. Verify no leak.
- **Version-skew safety:** both new payload fields are OPTIONAL on the client (`field?:`). Missing → Focus behaves as today, card renders nothing, never crash.
- **Best-effort fetches never break the dashboard:** wrap ADO fetches in try/catch, fall back to empty (same as the existing managed/standup fetches).
- **KISS/DRY/YAGNI:** reuse `projectWorkItem`, `getWorkItemsWithParents({errorPolicy:'omit'})`, `getActiveFeature`, `getManagedFeatureIds`, `getWorkspaces`. No disk scanning. No new mode/tab.
- **Discovery & Design is the user-facing label.** Internal names (`workspace_*`, folder logic) unchanged.
- **MCP handler glue is smoke-tested by Moran**, not unit-tested — put logic in pure functions and test those.

---

### Task 1: Pure helper `selectLiveOutsideSprint` + `liveOutsideSprint` payload field

**Files:**
- Modify: `server/dashboard.ts` (add helper near `selectManagedFeatures`'s old spot / top-level; add field to `DashboardPayload`; wire into `buildDashboard` + the no-sprint early return)
- Test: `server/dashboard-live-outside.test.ts` (new)

**Interfaces:**
- Consumes: `listActiveSessions` (already imported), `getWorkItemsWithParents` (already imported), `projectWorkItem` (in-file), the sprint `items` list.
- Produces:
  - `export function selectLiveOutsideSprintIds(activeSessionItemIds: number[], sprintItemIds: number[]): number[]` — pure: the live-session ids NOT in the sprint, deduped.
  - `DashboardPayload.liveOutsideSprint: DashboardWorkItem[]`

- [ ] **Step 1: Write the failing test**

`server/dashboard-live-outside.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { selectLiveOutsideSprintIds } from './dashboard';

describe('selectLiveOutsideSprintIds', () => {
  it('returns live-session ids not in the sprint', () => {
    expect(selectLiveOutsideSprintIds([426639, 100], [100, 200]).sort())
      .toEqual([426639]);
  });
  it('empty when every live session is in the sprint', () => {
    expect(selectLiveOutsideSprintIds([100, 200], [100, 200])).toEqual([]);
  });
  it('dedups repeated live ids', () => {
    expect(selectLiveOutsideSprintIds([426639, 426639], [])).toEqual([426639]);
  });
  it('empty when no live sessions', () => {
    expect(selectLiveOutsideSprintIds([], [100])).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run server/dashboard-live-outside.test.ts`
Expected: FAIL — `selectLiveOutsideSprintIds` not exported.

- [ ] **Step 3: Implement the pure helper**

In `server/dashboard.ts`, add:

```ts
/** Live-session work-item ids that are NOT in the current sprint. Deduped.
 *  These get fetched + projected so a session on an out-of-sprint item (a
 *  managed feature, or a previous-sprint task) is still visible in Focus. */
export function selectLiveOutsideSprintIds(
  activeSessionItemIds: number[],
  sprintItemIds: number[],
): number[] {
  const inSprint = new Set(sprintItemIds);
  const out: number[] = [];
  const seen = new Set<number>();
  for (const id of activeSessionItemIds) {
    if (inSprint.has(id) || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}
```

- [ ] **Step 4: Add the payload field**

In `DashboardPayload` (server/dashboard.ts), after `managedFeatures` was removed earlier — add near `wrap`/`needsYou`:

```ts
  /** Live sessions whose item isn't in the current sprint (e.g. a managed
   *  feature being worked in Discovery & Design). Surfaced so Focus shows them
   *  beside sprint work. NOT part of sprint capacity/counts/grouping. */
  liveOutsideSprint: DashboardWorkItem[];
```

- [ ] **Step 5: Wire into `buildDashboard`**

After the `for (const w of items)` projection loop (which fills inProgress/upNext/done) and where `activeSessions`/`recentEvents`/etc. maps already exist, add — placed AFTER `now` and the maps are built, and after `items` exists:

```ts
  // Out-of-sprint live sessions → visible in Focus (managed features, stray
  // previous-sprint work). Best-effort; a fetch failure just yields none.
  let liveOutsideSprint: DashboardWorkItem[] = [];
  try {
    const sprintIds = items.map(w => w.id);
    const liveIds = [...activeSessions.keys()];
    const outsideIds = selectLiveOutsideSprintIds(liveIds, sprintIds);
    if (outsideIds.length > 0) {
      const fetched = await getWorkItemsWithParents(outsideIds, { errorPolicy: 'omit' });
      const extraEvents = getRecentEventsMap(outsideIds, 5);
      const extraCounts = getSessionCountMap(outsideIds);
      liveOutsideSprint = fetched
        .filter(w => !DONE_STATES.has(w.state)) // a done item isn't "live work"
        .map(w => projectWorkItem(w, uncaptured, localLogged, running, activeSessions, extraEvents, extraCounts, lastEventBySession, now));
    }
  } catch {
    liveOutsideSprint = [];
  }
```

NOTE: verify the exact param order of `projectWorkItem` against its current signature (w, uncaptured, localLogged, running, activeSessions, recentEvents, sessionCounts, lastEventBySession, now) and match it. Use the `activeSessions` map already built above — do NOT rebuild it.

Add `liveOutsideSprint,` to the final return object, and `liveOutsideSprint: [],` to the no-sprint early-return payload.

- [ ] **Step 6: Run tests + typecheck**

Run: `npx vitest run server/dashboard-live-outside.test.ts && npx tsc --noEmit`
Expected: PASS; tsc clean.

- [ ] **Step 7: Commit**

```bash
git add server/dashboard.ts server/dashboard-live-outside.test.ts
git commit -m "feat(dashboard): carry out-of-sprint live sessions in payload (liveOutsideSprint)"
```

---

### Task 2: Pure helper `buildDiscoveryBlock` + `discovery` payload field

**Files:**
- Modify: `server/dashboard.ts` (helper + `DashboardPayload.discovery` + wire into build + no-sprint return)
- Test: `server/dashboard-discovery.test.ts` (new)

**Interfaces:**
- Consumes: `getActiveFeature`, `getManagedFeatureIds` from `./workspace`; `getWorkspaces` from `./workspace`; `getWorkItemsWithParents`.
- Produces:
  - `export interface DiscoveryBlock { activeFeature: { id: number; displayName: string; folderPath: string } | null; managed: { id: number; displayName: string }[]; hasWorkspace: boolean }`
  - `export function buildDiscoveryBlock(args: { activeFeature: ActiveFeature | null; managedIds: number[]; fetched: { id: number; title: string }[]; hasWorkspace: boolean }): DiscoveryBlock`
  - `DashboardPayload.discovery: DiscoveryBlock`

- [ ] **Step 1: Write the failing test**

`server/dashboard-discovery.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { buildDiscoveryBlock } from './dashboard';

describe('buildDiscoveryBlock', () => {
  const af = { id: 426639, title: 'Declarative CD', folderPath: '/w/426639-declarative-cd', setAt: '2026-07-19T10:00:00.000Z' };

  it('maps active feature to displayName + folderPath, managed to displayName list', () => {
    const b = buildDiscoveryBlock({
      activeFeature: af,
      managedIds: [426639],
      fetched: [{ id: 426639, title: 'Declarative CD' }],
      hasWorkspace: true,
    });
    expect(b.activeFeature).toEqual({
      id: 426639,
      displayName: '**Declarative CD** (#426639)',
      folderPath: '/w/426639-declarative-cd',
    });
    expect(b.managed).toEqual([{ id: 426639, displayName: '**Declarative CD** (#426639)' }]);
    expect(b.hasWorkspace).toBe(true);
  });

  it('null active feature when none set', () => {
    const b = buildDiscoveryBlock({ activeFeature: null, managedIds: [], fetched: [], hasWorkspace: true });
    expect(b.activeFeature).toBeNull();
    expect(b.managed).toEqual([]);
  });

  it('falls back to #id displayName when a managed id has no fetched title', () => {
    const b = buildDiscoveryBlock({ activeFeature: null, managedIds: [999], fetched: [], hasWorkspace: true });
    expect(b.managed).toEqual([{ id: 999, displayName: '#999' }]);
  });

  it('hasWorkspace false passes through', () => {
    const b = buildDiscoveryBlock({ activeFeature: null, managedIds: [], fetched: [], hasWorkspace: false });
    expect(b.hasWorkspace).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run server/dashboard-discovery.test.ts`
Expected: FAIL — `buildDiscoveryBlock` not exported.

- [ ] **Step 3: Implement**

In `server/dashboard.ts`, add the import (merge into the existing `./workspace` import line):

```ts
import { getManagedFeatureIds, getActiveFeature, getWorkspaces, type ActiveFeature } from './workspace';
```

(NOTE: `getManagedFeatureIds` was removed from dashboard.ts in the prior feature. Re-add it here — it's now used again. Confirm the import line and add all four names.)

Add the block builder:

```ts
export interface DiscoveryBlock {
  activeFeature: { id: number; displayName: string; folderPath: string } | null;
  managed: { id: number; displayName: string }[];
  hasWorkspace: boolean;
}

/** Pure: the "Discovery & Design" rail-card payload. Active feature + managed
 *  features (names before numbers) + whether a workspace is set. */
export function buildDiscoveryBlock(args: {
  activeFeature: ActiveFeature | null;
  managedIds: number[];
  fetched: { id: number; title: string }[];
  hasWorkspace: boolean;
}): DiscoveryBlock {
  const { activeFeature, managedIds, fetched, hasWorkspace } = args;
  const titleById = new Map(fetched.map(w => [w.id, w.title]));
  const managed = managedIds.map(id => {
    const title = titleById.get(id);
    return { id, displayName: title ? `**${title}** (#${id})` : `#${id}` };
  });
  return {
    activeFeature: activeFeature
      ? { id: activeFeature.id, displayName: `**${activeFeature.title}** (#${activeFeature.id})`, folderPath: activeFeature.folderPath }
      : null,
    managed,
    hasWorkspace,
  };
}
```

- [ ] **Step 4: Add the payload field**

In `DashboardPayload`, near `liveOutsideSprint`:

```ts
  /** Discovery & Design rail card: active feature, managed features, workspace flag. */
  discovery: DiscoveryBlock;
```

- [ ] **Step 5: Wire into `buildDashboard`**

Near the managed-id read (best-effort), add:

```ts
  // Discovery & Design card. Managed-feature titles fetched best-effort.
  let discovery: DiscoveryBlock = { activeFeature: null, managed: [], hasWorkspace: false };
  try {
    const activeFeature = getActiveFeature();
    const managedIds = getManagedFeatureIds();
    const hasWorkspace = getWorkspaces().paths.length > 0;
    let fetchedForTitles: { id: number; title: string }[] = [];
    if (managedIds.length > 0) {
      fetchedForTitles = await getWorkItemsWithParents(managedIds, { errorPolicy: 'omit' });
    }
    discovery = buildDiscoveryBlock({ activeFeature, managedIds, fetched: fetchedForTitles, hasWorkspace });
  } catch {
    discovery = { activeFeature: null, managed: [], hasWorkspace: getWorkspaces().paths.length > 0 };
  }
```

Add `discovery,` to the final return and `discovery: { activeFeature: null, managed: [], hasWorkspace: getWorkspaces().paths.length > 0 },` to the no-sprint early return. (For the no-sprint return, if calling getWorkspaces there is awkward, use `hasWorkspace: false` — the card just won't show; note that choice in the report.)

- [ ] **Step 6: Run tests + typecheck**

Run: `npx vitest run server/dashboard-discovery.test.ts && npx tsc --noEmit`
Expected: PASS; tsc clean.

- [ ] **Step 7: Commit**

```bash
git add server/dashboard.ts server/dashboard-discovery.test.ts
git commit -m "feat(dashboard): discovery block payload (active feature + managed + workspace flag)"
```

---

### Task 3: Client types + merge liveOutsideSprint into Focus

**Files:**
- Modify: `src/lib/api.ts` (add `ApiDiscovery` + optional `liveOutsideSprint?` and `discovery?` on `ApiPayload`)
- Modify: `src/components/Dashboard.tsx` (merge `liveOutsideSprint` into `allItems`)

No unit test (client wiring; behavior verified by Moran's smoke + tsc).

- [ ] **Step 1: Add client types**

In `src/lib/api.ts`:

```ts
export interface ApiDiscovery {
  activeFeature: { id: number; displayName: string; folderPath: string } | null;
  managed: { id: number; displayName: string }[];
  hasWorkspace: boolean;
}
```

Add to `ApiPayload` (both OPTIONAL — version-skew guard):

```ts
  /** Live sessions on items outside the current sprint (Discovery & Design work). Optional. */
  liveOutsideSprint?: ApiWorkItem[];
  /** Discovery & Design rail card data. Optional (older payloads omit it). */
  discovery?: ApiDiscovery;
```

- [ ] **Step 2: Merge into Focus's item list**

In `src/components/Dashboard.tsx`, the `allItems` useMemo currently is:

```ts
  const allItems = useMemo(
    () => [...inProgress, ...upNext, ...done],
    [inProgress, upNext, done],
  );
```

Change it to also include out-of-sprint live items (dedup by id so a race can't double-add):

```ts
  const allItems = useMemo(
    () => {
      const base = [...inProgress, ...upNext, ...done];
      const seen = new Set(base.map(w => w.id));
      const extra = (data.liveOutsideSprint ?? []).filter(w => !seen.has(w.id));
      return [...base, ...extra];
    },
    [inProgress, upNext, done, data.liveOutsideSprint],
  );
```

(NOTE: confirm `inProgress`/`upNext`/`done` and `data` are all in scope where `allItems` is defined — they are, `allItems` is defined from the same `data` buckets. `liveItems` derives from `allItems`, so Focus picks these up automatically.)

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add src/lib/api.ts src/components/Dashboard.tsx
git commit -m "feat(daily): show out-of-sprint live sessions in Focus"
```

---

### Task 4: The Discovery & Design rail card

**Files:**
- Modify: `src/components/Dashboard.tsx` (new `RailDiscovery` component; mount it in the rail)
- Modify: `src/styles/dashboard.css` (card styles — reuse `r22-rail-card` tokens)

No unit test (presentational; Moran smokes the look).

- [ ] **Step 1: Add the `RailDiscovery` component**

In `src/components/Dashboard.tsx`, near `RailNeedsYou`, add:

```tsx
function RailDiscovery({ discovery }: { discovery: ApiDiscovery | undefined }) {
  // Version-skew guard: old payloads omit this → render nothing.
  if (!discovery) return null;
  // Only show once Moran has a Discovery & Design workspace set.
  if (!discovery.hasWorkspace) return null;
  const { activeFeature, managed } = discovery;
  return (
    <section className="r22-rail-card r22-rail-discovery" aria-label="Discovery and Design">
      <div className="r22-rail-card-head">
        <span className="r22-rail-card-label">Discovery &amp; Design</span>
        {managed.length > 0 && (
          <span className="r22-rail-card-meta">managing {managed.length}</span>
        )}
      </div>
      {activeFeature ? (
        <div className="disc-active">
          <span className="disc-on">On now</span>
          <span className="disc-title">{plainTitle(activeFeature.displayName)}</span>
          <span className="disc-folder">📁 {folderBase(activeFeature.folderPath)}</span>
        </div>
      ) : (
        <p className="empty">No feature open yet — name one in a chat to start.</p>
      )}
      {managed.length > 0 && (
        <ul className="disc-managed">
          {managed.map(m => (
            <li key={m.id} className="disc-managed-row">{plainTitle(m.displayName)}</li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** Last path segment of a folder path, for compact display. */
function folderBase(p: string): string {
  const parts = p.split('/').filter(Boolean);
  return parts[parts.length - 1] ?? p;
}
```

NOTE: `plainTitle` already exists in this file (used by `RailNeedsYou` to strip `**…**` markdown to plain text) — reuse it; do NOT add a second copy. Confirm its name by grepping; if it's named differently, use that.

- [ ] **Step 2: Mount it in the rail**

In the rail `<aside>` (after `RailNeedsYou`, before `RailNotes`), add — and thread `discovery` down. The rail is rendered inside `DailyView`, which receives `data`. Add:

```tsx
          <RailNeedsYou needsYou={needsYou} now={now} />
          <RailDiscovery discovery={data.discovery} />
          <RailNotes notes={helperNotes} onRefresh={onRefresh} />
```

`data` is already a prop of `DailyView` (confirm — it's passed `data={data}` at the call site). If the rail is a nested component without `data`, pass `discovery={data.discovery}` through the same way `needsYou` is threaded.

- [ ] **Step 3: Add CSS**

In `src/styles/dashboard.css`, near the other `.r22-rail-*` cards, add (reuse existing tokens `--ink-*`, `--accent`, `--line`, `--surface-*`; match the calm style, no new colors):

```css
/* ============================ Discovery & Design rail card ============================ */
.r22-rail-discovery .disc-active {
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.r22-rail-discovery .disc-on {
  font-size: 11px;
  color: var(--ink-3);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.r22-rail-discovery .disc-title {
  font-size: 14px;
  color: var(--ink-1);
}
.r22-rail-discovery .disc-folder {
  font-size: 12px;
  color: var(--ink-3);
  font-family: var(--mono, monospace);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.r22-rail-discovery .disc-managed {
  list-style: none;
  margin: 10px 0 0;
  padding: 10px 0 0;
  border-top: 1px solid var(--line);
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.r22-rail-discovery .disc-managed-row {
  font-size: 13px;
  color: var(--ink-2);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
```

(NOTE: check whether a `--mono` token exists; if not, use `monospace` directly or the same font stack other mono spots use — grep `Mono` / `monospace` in dashboard.css.)

- [ ] **Step 4: Typecheck + full suite**

Run: `npx tsc --noEmit && npm test`
Expected: tsc clean; all green.

- [ ] **Step 5: Commit**

```bash
git add src/components/Dashboard.tsx src/styles/dashboard.css
git commit -m "feat(daily): Discovery & Design rail card (active feature + managed + folder)"
```

---

### Task 5: Update project memory

**Files:**
- Modify: `/Users/weissmmo/.claude/projects/-Users-weissmmo-projects-github-moran-sprint-helper/memory/project_build_state.md`

- [ ] **Step 1: Record what shipped**

Update the RESUME HERE block: Discovery & Design visibility shipped — out-of-sprint live sessions now show in Focus (`liveOutsideSprint`), plus a Discovery & Design rail card (active feature + folder + managed list). Note it fixes the old previous-sprint-session Focus blind spot too. Note the pending Moran smoke: MCP reload + dashboard restart, open a session on a managed feature, confirm it appears in Focus AND the card shows the active feature + folder.

- [ ] **Step 2: (No commit — memory lives outside the repo.)**

---

## Notes for the executor

- **Branch:** `discovery-and-design-visibility` off `main` (currently `3b17782`). Merge locally when done; `main` is NEVER pushed to origin (Moran's standing call).
- **Ordering:** Task 1 and Task 2 are both server, independent of each other — either order. Task 3 depends on both payload fields existing. Task 4 depends on Task 2 (the `discovery` field) + Task 3 (the `ApiDiscovery` type). Task 5 last.
- **Do NOT** add `liveOutsideSprint` items to sprint capacity, counts, the Daily story grouping, or inProgress/upNext/done. They flow to `allItems` (Focus) ONLY. If a reviewer sees them leaking into sprint math, that's a defect.
- **Verify** the `projectWorkItem` param order against its real signature before calling it in Task 1 — do not guess.
- **Verify before completion:** `npx tsc --noEmit` and `npm test` both clean.
