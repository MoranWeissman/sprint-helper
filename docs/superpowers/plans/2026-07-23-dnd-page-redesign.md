# D&D Page Redesign — three-level layout — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild the D&D page as a three-column layout — feature list → per-feature facet menu (Overview · Discovery · Design · Demo) → full-width reading area — sized to match the rest of the dashboard.

**Architecture:** No new routes and no new data source. One additive extension to the existing `GET /api/discovery/:id` payload (the feature's `state`, a plain-text `description`, and its child stories/tasks) feeds the new Overview facet. `DnDView.tsx` is rewritten from a list→detail flip into a persistent three-column grid with local `selectedId` + `facet` state. The `dnd-*` CSS block is replaced with the three-column grid + app-sized type scale.

**Tech Stack:** TypeScript ESM, React 18, Vite 5 dev-server middleware (the API), Vitest 4 (node environment), a single `src/styles/dashboard.css`.

## Global Constraints

Every task's requirements implicitly include this section. Values copied verbatim from the spec (`docs/superpowers/specs/2026-07-23-dnd-page-redesign.md`) and verified against the code.

- **Typecheck gate is `npm run typecheck`** (= `tsc -b --noEmit`, project references). Bare `tsc --noEmit` checks nothing. `npm test` = `vitest run`. `npm run build` must also pass.
- **Reuse the real palette variables** from `src/styles/dashboard.css` — do NOT invent new ones (the mockups did; ignore the mockup's `:root`). The ones that exist and must be used: `--bg-0`, `--bg-1`, `--surface-1`, `--surface-2`, `--surface-3`, `--line-soft`, `--line-strong`, `--line-hair`, `--ink-0`, `--ink-1`, `--ink-2`, `--ink-3`, `--ink-4`, `--accent`, `--accent-deep`, `--accent-soft`, `--st-going`/`--st-going-bg`, `--st-done`/`--st-done-bg`, `--st-waiting`/`--st-waiting-bg`, `--st-blocked`/`--st-blocked-bg`, `--ev-progress`, `--font-mono`.
- **Sizing floors (the fix that made it look right):** reading text 15–16px; rail rows + menu tabs 14–15px; section labels / caps 12–13px uppercase; chips + tag chips **11–12px, never ≤10px**; feature title in the reading area ~24px.
- **ADHD-calm rules:** one accent colour, no pulsing/looping animation, one focal point per view (the flow), generous whitespace. Never combine ≤11px text with the faintest ink (`--ink-4`) — chips use strong semantic colours, not `--ink-4`.
- **Plain English in all UI copy** — no agile jargon. Facet labels are exactly: `Overview`, `Discovery`, `Design`, `Demo`.
- **Names before numbers** in any work-item reference shown to the user: render `**title** (#id)` with the title first and bold, the id after. Never show a bare id as the name.
- **CSS namespace stays `dnd-`.** Same single file `src/styles/dashboard.css`.
- **Read-only page** except the one existing write (mark-demo) and the open-folder action. No new board writes.
- **Do NOT push. Do NOT run `git push`.** Commit locally only. All work stays on the current branch / local `main`.

---

### Task 1: Extract `htmlPreview` into a shared, tested pure module

**Why first:** The new Overview facet needs the feature's description as plain text (ADO stores it as HTML). The dashboard already has a private `htmlPreview` for exactly this. Extract it into its own pure module so the discovery route can reuse it (DRY) and so it gets a real unit test. No behaviour change for the dashboard.

**Files:**
- Create: `server/html-preview.ts`
- Create: `server/html-preview.test.ts`
- Modify: `server/dashboard.ts:967-984` (remove the local function, import from the new module)

**Interfaces:**
- Produces: `export function htmlPreview(html: string | undefined): string | undefined` — strips HTML tags + common entities, collapses whitespace, trims, returns `undefined` for empty/whitespace-only input, truncates to 280 chars with a `…` suffix when longer. Task 2 consumes this.

- [ ] **Step 1: Write the failing test**

Create `server/html-preview.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { htmlPreview } from './html-preview';

describe('htmlPreview', () => {
  it('returns undefined for undefined or empty input', () => {
    expect(htmlPreview(undefined)).toBeUndefined();
    expect(htmlPreview('')).toBeUndefined();
    expect(htmlPreview('   ')).toBeUndefined();
    expect(htmlPreview('<p></p>')).toBeUndefined();
  });

  it('strips tags and decodes entities into plain text', () => {
    expect(htmlPreview('<p>Move CI/CD to <b>GitHub</b> &amp; test</p>'))
      .toBe('Move CI/CD to GitHub & test');
  });

  it('turns <br> and </p> into spaces and collapses whitespace', () => {
    expect(htmlPreview('<p>one</p><p>two</p><div>three<br/>four</div>'))
      .toBe('one two three four');
  });

  it('truncates to 280 chars with an ellipsis', () => {
    const long = 'x'.repeat(400);
    const out = htmlPreview(long)!;
    expect(out.length).toBe(280);
    expect(out.endsWith('…')).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run server/html-preview.test.ts`
Expected: FAIL — cannot resolve `./html-preview`.

- [ ] **Step 3: Create the module**

Create `server/html-preview.ts` with the exact body currently in `server/dashboard.ts` (lines 967–984), exported:

```ts
/** Strip HTML tags + entities, collapse whitespace, truncate to 280 chars. */
export function htmlPreview(html: string | undefined): string | undefined {
  if (!html) return undefined;
  const text = html
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<\/p>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return undefined;
  return text.length > 280 ? text.slice(0, 277).trimEnd() + '…' : text;
}
```

- [ ] **Step 4: Point `dashboard.ts` at the shared module**

In `server/dashboard.ts`, delete the local `function htmlPreview(...) { ... }` (lines 967–984) and add an import near the other `server/*` imports at the top of the file:

```ts
import { htmlPreview } from './html-preview';
```

The three existing call sites (`server/dashboard.ts:770`, `:798`, `:940`) are unchanged — they now resolve to the imported function.

- [ ] **Step 5: Run tests + typecheck**

Run: `npx vitest run server/html-preview.test.ts`
Expected: PASS (4 tests).

Run: `npm run typecheck`
Expected: no errors (confirms `dashboard.ts` still resolves `htmlPreview`).

- [ ] **Step 6: Commit**

```bash
git add server/html-preview.ts server/html-preview.test.ts server/dashboard.ts
git commit -m "refactor(discovery): extract htmlPreview into shared tested module"
```

---

### Task 2: Extend the discovery detail payload with feature state + description + children

**Why:** The Overview facet answers "what is this feature and what work is under it." The detail route already calls `getWorkItem(id)`, which returns `state`, `description` (raw HTML), and `children` (`{id,title,type,state,url}[]`). Surface a small, plain-text-safe slice of that on the payload. Additive only — existing consumers keep working.

**Files:**
- Modify: `vite.config.ts:489-496` (the detail branch of the `/api/discovery` route)
- Modify: `src/lib/api.ts:262-266` (the `DiscoveryDetailPayload` interface)

**Interfaces:**
- Consumes: `htmlPreview` from Task 1 (`server/html-preview.ts`); `getWorkItem(id)` from `server/ado` returning `{ title, state, description?, children: {id,title,type,state,url}[] }`.
- Produces: the extended `DiscoveryDetailPayload` shape below. Task 3 consumes `state`, `description`, and `children` for the Overview facet.

- [ ] **Step 1: Extend the payload type**

In `src/lib/api.ts`, add a child type and three fields to `DiscoveryDetailPayload` (currently lines 262–266). Replace that interface block with:

```ts
export interface ApiDiscoveryChild {
  id: number;
  title: string;
  type: string;
  state: string;
}
export interface DiscoveryDetailPayload {
  displayName: string;
  folderPath: string;
  doc: ApiDiscoveryDoc | null;
  /** The feature's own ADO state (Active / Closed / …). Absent if ADO was down. */
  featureState?: string;
  /** The feature's description as plain text (HTML stripped). Absent if empty/ADO down. */
  featureDescription?: string;
  /** The feature's child stories/tasks from the board. Empty if none / ADO down. */
  children: ApiDiscoveryChild[];
}
```

- [ ] **Step 2: Fill the new fields in the detail route**

In `vite.config.ts`, the detail branch currently reads (around lines 489–496):

```ts
          let displayName = `#${id}`;
          try { const wi = await getWorkItem(id); displayName = `**${wi.title}** (#${id})`; } catch { /* ADO down */ }

          if (!action) {
            if (method !== 'GET') { res.statusCode = 405; res.end(JSON.stringify({ error: 'GET only' })); return; }
            res.end(JSON.stringify({ displayName, folderPath, doc: readDiscoveryDoc(folderPath) }));
            return;
          }
```

Replace that block with (capture state/description/children from the same `getWorkItem` call, and add the `htmlPreview` import to the route's lazy-import group):

```ts
          let displayName = `#${id}`;
          let featureState: string | undefined;
          let featureDescription: string | undefined;
          let children: { id: number; title: string; type: string; state: string }[] = [];
          try {
            const wi = await getWorkItem(id);
            displayName = `**${wi.title}** (#${id})`;
            featureState = wi.state;
            featureDescription = htmlPreview(wi.description);
            children = wi.children.map(c => ({ id: c.id, title: c.title, type: c.type, state: c.state }));
          } catch { /* ADO down — Overview degrades, discovery still reads from disk */ }

          if (!action) {
            if (method !== 'GET') { res.statusCode = 405; res.end(JSON.stringify({ error: 'GET only' })); return; }
            res.end(JSON.stringify({
              displayName, folderPath, doc: readDiscoveryDoc(folderPath),
              featureState, featureDescription, children,
            }));
            return;
          }
```

Add `htmlPreview` to the lazy imports at the top of the route handler (near line 435, alongside `const { getWorkItem } = await import('./server/ado');`):

```ts
          const { htmlPreview } = await import('./server/html-preview');
```

- [ ] **Step 3: Typecheck + build**

Run: `npm run typecheck`
Expected: no errors. (The route is untyped JS-in-TS glue; the type gate is `DiscoveryDetailPayload` in `api.ts` and its consumer in Task 3. `children` is required on the type and always set in the route — the `try` initialises it to `[]` before any throw.)

Run: `npm run build`
Expected: succeeds.

- [ ] **Step 4: Commit**

```bash
git add src/lib/api.ts vite.config.ts
git commit -m "feat(discovery): add feature state/description/children to detail payload"
```

---

### Task 3: Rewrite DnDView as the three-level layout (component + CSS)

**Why:** This is the redesign itself. The page changes from a list that flips to a full-screen detail into a persistent three-column grid: feature list (left) → facet menu (middle, appears once a feature is open) → reading area (right). The component and its CSS land together — the page is one visual artifact and must be reviewed as one.

**Files:**
- Modify (full rewrite of the component body): `src/components/DnDView.tsx`
- Modify: `src/styles/dashboard.css` — replace the entire existing `dnd-*` block (lines ~5104 to end of that block, currently ~5104–5571) with the new three-column styles. Keep the `dnd-` namespace.

**Interfaces:**
- Consumes: `fetchDiscoveryList`, `fetchDiscoveryDetail`, `markDiscoveryDemo`, `openDiscoveryFolder`, and the types `ApiFeatureSection`, `DiscoveryDetailPayload`, `ApiDiscoveryChild`, `DndStatus` — all from `src/lib/api.ts`. The payload now carries `featureState`, `featureDescription`, `children` (Task 2).
- Produces: `export function DnDView(): JSX.Element` — same export name and signature, still rendered by `Dashboard.tsx:312` with no props. No change needed in `Dashboard.tsx`.

**Layout contract (from the spec + `layout-v3.html`):**
- Three columns: feature list ~288px, facet menu ~184px, reading area fills the rest.
- The whole view fills `.r21-bodywrap` — root element uses `position: absolute; inset: 0` and lays out its three columns as a CSS grid (same fill pattern as `.r12-plan`). Each column scrolls independently (`overflow-y: auto`).
- Facet menu only renders when a feature is selected. Before any selection, the reading area shows a calm "pick a feature" prompt and the menu column is empty.
- Selecting a feature resets the facet to `discovery`.
- Facets: `overview | discovery | design | demo`, default `discovery`.

- [ ] **Step 1: Rewrite `src/components/DnDView.tsx`**

Replace the entire file contents with:

```tsx
import { useCallback, useEffect, useState } from 'react';
import {
  fetchDiscoveryList, fetchDiscoveryDetail, markDiscoveryDemo, openDiscoveryFolder,
  type ApiFeatureSection, type DiscoveryDetailPayload, type ApiDiscoveryChild, type DndStatus,
} from '../lib/api';

const STATUS_LABEL: Record<DndStatus, string> = {
  'in-progress': 'In progress',
  'not-started': 'Not started',
  'closed': 'Done',
};

type Facet = 'overview' | 'discovery' | 'design' | 'demo';

/** Render a displayName's **bold** span without showing raw asterisks. */
function renderDisplayName(s: string): JSX.Element {
  const m = s.match(/^\*\*(.+?)\*\*\s*(.*)$/);
  if (!m) return <span>{s}</span>;
  return <span><strong>{m[1]}</strong> {m[2]}</span>;
}

export function DnDView(): JSX.Element {
  const [sections, setSections] = useState<ApiFeatureSection[] | null>(null);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [facet, setFacet] = useState<Facet>('discovery');
  const [detail, setDetail] = useState<DiscoveryDetailPayload | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadList = useCallback(() => {
    setError(null);
    fetchDiscoveryList()
      .then(p => setSections(Array.isArray(p?.sections) ? p.sections : []))
      .catch(e => setError(String(e)));
  }, []);

  useEffect(() => { loadList(); }, [loadList]);

  const loadDetail = useCallback(() => {
    if (selectedId == null) { setDetail(null); return; }
    setError(null);
    fetchDiscoveryDetail(selectedId).then(setDetail).catch(e => setError(String(e)));
  }, [selectedId]);

  useEffect(() => { loadDetail(); }, [loadDetail]);

  function selectFeature(id: number): void {
    setSelectedId(id);
    setFacet('discovery');
  }

  const demoStatus = detail?.doc?.demo.status ?? 'none';

  return (
    <div className="dnd">
      <FeatureListRail
        sections={sections}
        selectedId={selectedId}
        error={error}
        onSelect={selectFeature}
      />
      {selectedId != null && (
        <FeatureFacetMenu facet={facet} demoStatus={demoStatus} onPick={setFacet} />
      )}
      <FacetReadingArea
        selectedId={selectedId}
        facet={facet}
        detail={detail}
        error={error}
        onReloadDetail={loadDetail}
      />
    </div>
  );
}

/* ------------------------- Level 1 — feature list ------------------------- */

function FeatureListRail(props: {
  sections: ApiFeatureSection[] | null;
  selectedId: number | null;
  error: string | null;
  onSelect: (id: number) => void;
}): JSX.Element {
  const { sections, selectedId, error, onSelect } = props;
  return (
    <aside className="dnd-rail">
      <div className="dnd-rail-title">Discovery &amp; Design</div>
      <div className="dnd-rail-sub">Features you've worked</div>
      {error && <div className="dnd-error">Couldn't load discoveries: {error}</div>}
      {sections && sections.length === 0 && (
        <div className="dnd-empty">
          Discoveries show up here once you start one. Run <code>/sprint-helper:discovery</code> in a workspace to begin.
        </div>
      )}
      {sections?.map(sec => (
        <div key={sec.status} className={`dnd-grp is-${sec.status}`}>
          <div className="dnd-grp-head">
            {STATUS_LABEL[sec.status]} <span className="dnd-grp-count">{sec.features.length}</span>
          </div>
          {sec.features.map(f => (
            <button
              key={f.id}
              className={`dnd-row${f.id === selectedId ? ' is-sel' : ''}`}
              onClick={() => onSelect(f.id)}
            >
              <span className="dnd-row-name">{renderDisplayName(f.displayName)}</span>
              <span className="dnd-row-meta">
                {f.boardState && <span className={`dnd-chip is-${f.boardState.toLowerCase()}`}>{f.boardState}</span>}
                {f.readyToClose && <span className="dnd-ready">ready to close</span>}
                {f.dayLabel && <span className="dnd-day">{f.dayLabel}</span>}
              </span>
            </button>
          ))}
        </div>
      ))}
    </aside>
  );
}

/* ------------------------- Level 2 — facet menu --------------------------- */

function FeatureFacetMenu(props: {
  facet: Facet;
  demoStatus: 'none' | 'scheduled' | 'built';
  onPick: (f: Facet) => void;
}): JSX.Element {
  const { facet, demoStatus, onPick } = props;
  const tabs: { id: Facet; label: string; hint?: string }[] = [
    { id: 'overview', label: 'Overview' },
    { id: 'discovery', label: 'Discovery' },
    { id: 'design', label: 'Design', hint: 'soon' },
    { id: 'demo', label: 'Demo', hint: demoStatus },
  ];
  return (
    <nav className="dnd-menu">
      <div className="dnd-menu-cap">This feature</div>
      {tabs.map(t => (
        <button
          key={t.id}
          className={`dnd-tab${t.id === facet ? ' is-sel' : ''}`}
          onClick={() => onPick(t.id)}
        >
          <span className="dnd-tab-dot" />
          <span className="dnd-tab-label">{t.label}</span>
          {t.hint && <span className="dnd-tab-hint">{t.hint}</span>}
        </button>
      ))}
    </nav>
  );
}

/* ------------------------- Level 3 — reading area ------------------------- */

function FacetReadingArea(props: {
  selectedId: number | null;
  facet: Facet;
  detail: DiscoveryDetailPayload | null;
  error: string | null;
  onReloadDetail: () => void;
}): JSX.Element {
  const { selectedId, facet, detail, error, onReloadDetail } = props;

  if (selectedId == null) {
    return (
      <main className="dnd-read">
        <div className="dnd-read-prompt">Pick a feature on the left to read its discovery.</div>
      </main>
    );
  }
  if (error) {
    return <main className="dnd-read"><div className="dnd-error">Couldn't read this feature: {error}</div></main>;
  }
  if (!detail) {
    return <main className="dnd-read"><div className="dnd-loading">Loading…</div></main>;
  }

  return (
    <main className="dnd-read">
      <h1 className="dnd-read-title">{renderDisplayName(detail.displayName)}</h1>
      <div className="dnd-facet-label">{facetLabel(facet)}</div>
      {facet === 'overview' && <OverviewFacet detail={detail} />}
      {facet === 'discovery' && <DiscoveryFacet detail={detail} />}
      {facet === 'design' && <DesignFacet />}
      {facet === 'demo' && <DemoFacet detail={detail} onSaved={onReloadDetail} />}
    </main>
  );
}

function facetLabel(f: Facet): string {
  return f === 'overview' ? 'Overview' : f === 'discovery' ? 'Discovery' : f === 'design' ? 'Design' : 'Demo';
}

function OverviewFacet(props: { detail: DiscoveryDetailPayload }): JSX.Element {
  const { detail } = props;
  return (
    <div className="dnd-overview">
      {detail.featureState && (
        <div className="dnd-overview-state">
          <span className={`dnd-chip is-${detail.featureState.toLowerCase()}`}>{detail.featureState}</span>
        </div>
      )}
      {detail.featureDescription
        ? <p className="dnd-overview-desc">{detail.featureDescription}</p>
        : <p className="dnd-muted">No description on the board.</p>}
      <h2 className="dnd-h2">Stories &amp; tasks under this feature</h2>
      {detail.children.length === 0
        ? <p className="dnd-muted">Nothing linked under this feature yet.</p>
        : (
          <ul className="dnd-children">
            {detail.children.map((c: ApiDiscoveryChild) => (
              <li key={c.id} className="dnd-child">
                <span className="dnd-child-name"><strong>{c.title}</strong> <span className="dnd-child-id">#{c.id}</span></span>
                <span className="dnd-child-meta">
                  <span className="dnd-child-type">{c.type}</span>
                  {c.state && <span className={`dnd-chip is-${c.state.toLowerCase()}`}>{c.state}</span>}
                </span>
              </li>
            ))}
          </ul>
        )}
    </div>
  );
}

function DiscoveryFacet(props: { detail: DiscoveryDetailPayload }): JSX.Element {
  const { doc } = props.detail;
  if (!doc) return <div className="dnd-empty">This feature has no discovery yet.</div>;
  return (
    <div className="dnd-discovery">
      <div className="dnd-problem">{doc.problem || '—'}</div>

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

      <h2 className="dnd-h2">Lanes</h2>
      <div className="dnd-lanes">
        <div className="dnd-lane">
          <div className="dnd-lane-lab">Ours</div>
          <p>{doc.lanes.ours || '—'}</p>
        </div>
        <div className="dnd-lane">
          <div className="dnd-lane-lab">Tech lead's</div>
          <p>{doc.lanes.techLead || '—'}</p>
        </div>
      </div>

      <h2 className="dnd-h2">Open questions</h2>
      {doc.openQuestions.length === 0
        ? <p className="dnd-muted">None noted.</p>
        : <ul className="dnd-qs">{doc.openQuestions.map((q, i) => <li key={i}>{q}</li>)}</ul>}
    </div>
  );
}

function DesignFacet(): JSX.Element {
  return (
    <div className="dnd-placeholder">
      <p className="dnd-muted">Design hasn't started for this feature yet.</p>
      <p className="dnd-muted-2">It'll live here once the design phase is built.</p>
    </div>
  );
}

function DemoFacet(props: { detail: DiscoveryDetailPayload; onSaved: () => void }): JSX.Element {
  const { detail, onSaved } = props;
  const id = Number(detail.displayName.match(/#(\d+)/)?.[1] ?? 0);
  const [status, setStatus] = useState<'none' | 'scheduled' | 'built'>(detail.doc?.demo.status ?? 'none');
  const [date, setDate] = useState(detail.doc?.demo.date ?? '');
  const [folderMsg, setFolderMsg] = useState<string | null>(null);

  useEffect(() => {
    setStatus(detail.doc?.demo.status ?? 'none');
    setDate(detail.doc?.demo.date ?? '');
  }, [detail]);

  if (!detail.doc) return <div className="dnd-empty">Start a discovery before marking a demo.</div>;

  return (
    <div className="dnd-demo">
      <p className="dnd-muted">
        A built demo will show up here once the demo generator exists. For now you can mark where the demo stands.
      </p>
      <div className="dnd-demo-controls">
        <label className="dnd-field">
          <span>Status</span>
          <select value={status} onChange={e => setStatus(e.target.value as 'none' | 'scheduled' | 'built')}>
            <option value="none">none</option>
            <option value="scheduled">scheduled</option>
            <option value="built">built</option>
          </select>
        </label>
        <label className="dnd-field">
          <span>Date</span>
          <input type="date" value={date} onChange={e => setDate(e.target.value)} />
        </label>
        <button className="dnd-btn" onClick={() => markDiscoveryDemo(id, { status, date }).then(onSaved)}>Save</button>
      </div>
      <div className="dnd-demo-folder">
        <button className="dnd-btn is-quiet" onClick={() => openDiscoveryFolder(id).then(r => { if (!r.ok) setFolderMsg(detail.folderPath); })}>
          Open folder
        </button>
        {folderMsg && <code className="dnd-path">{folderMsg}</code>}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Typecheck the component before styling**

Run: `npm run typecheck`
Expected: no errors. Fix any type mismatch against `DiscoveryDetailPayload` before moving on.

- [ ] **Step 3: Replace the `dnd-*` CSS block**

In `src/styles/dashboard.css`, delete the entire existing `dnd-*` block (from `.dnd-list {` at line ~5104 through the end of that block, ~line 5571 — it runs to end of file; confirm the last `dnd-` rule and delete up to and including it, leaving any non-`dnd` rules intact). Replace with:

```css
/* ========================================================================== */
/*  D&D page — three-level layout (feature list · facet menu · reading area)  */
/* ========================================================================== */
.dnd {
  position: absolute; inset: 0;
  display: grid;
  grid-template-columns: 288px 184px minmax(0, 1fr);
  overflow: hidden;
  background: var(--bg-0);
}
/* When no feature is open, the menu column collapses to nothing. */
.dnd:has(.dnd-read-prompt) { grid-template-columns: 288px 0 minmax(0, 1fr); }

/* ---- LEVEL 1 — feature list rail ---- */
.dnd-rail {
  background: var(--surface-1);
  border-right: 1px solid var(--line-soft);
  padding: 24px 14px;
  overflow-y: auto;
  min-width: 0;
}
.dnd-rail-title { font-size: 17px; font-weight: 600; color: var(--ink-0); padding: 0 8px 4px; }
.dnd-rail-sub { font-size: 13px; color: var(--ink-3); padding: 0 8px 20px; }
.dnd-grp { margin-bottom: 20px; }
.dnd-grp-head {
  font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.08em;
  color: var(--ink-3); padding: 0 8px 9px;
}
.dnd-grp.is-in-progress .dnd-grp-head { color: var(--accent); }
.dnd-grp-count { color: var(--ink-4); font-weight: 500; }
.dnd-row {
  appearance: none; display: block; width: 100%; text-align: left; cursor: pointer;
  font-family: inherit; background: transparent; border: 1px solid transparent;
  border-radius: 10px; padding: 11px 12px; margin-bottom: 4px; color: var(--ink-1);
  transition: background 0.15s ease, border-color 0.15s ease;
}
.dnd-row:hover { background: var(--surface-2); }
.dnd-row.is-sel { background: var(--surface-3); border-color: var(--line-strong); }
.dnd-row.is-sel .dnd-row-name { color: var(--ink-0); }
.dnd-row-name { font-size: 14px; font-weight: 500; line-height: 1.35; display: block; margin-bottom: 8px; }
.dnd-row-name strong { font-weight: 600; }
.dnd-row-meta { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }

/* chips (shared by rail rows, overview state, child rows) */
.dnd-chip {
  font-size: 11.5px; font-weight: 500; padding: 3px 9px; border-radius: 999px; white-space: nowrap;
  background: var(--bg-1); color: var(--ink-2);
}
.dnd-chip.is-active, .dnd-chip.is-committed, .dnd-chip.is-new { background: var(--st-going-bg); color: var(--st-going); }
.dnd-chip.is-closed, .dnd-chip.is-done, .dnd-chip.is-resolved { background: var(--st-done-bg); color: var(--st-done); }
.dnd-chip.is-blocked { background: var(--st-blocked-bg); color: var(--st-blocked); }
.dnd-ready { font-size: 11.5px; color: var(--ev-progress); }
.dnd-day { font-size: 11.5px; color: var(--ink-4); }

/* ---- LEVEL 2 — facet menu ---- */
.dnd-menu {
  background: var(--surface-2);
  border-right: 1px solid var(--line-soft);
  padding: 24px 11px;
  overflow-y: auto;
  min-width: 0;
}
.dnd-menu-cap {
  font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.08em;
  color: var(--ink-4); padding: 0 9px 14px;
}
.dnd-tab {
  appearance: none; display: flex; align-items: center; gap: 10px; width: 100%; text-align: left;
  cursor: pointer; font-family: inherit; background: transparent; border: none;
  border-radius: 9px; padding: 11px; margin-bottom: 3px; color: var(--ink-2); font-size: 15px;
  transition: background 0.15s ease, color 0.15s ease;
}
.dnd-tab:hover { background: var(--surface-3); color: var(--ink-1); }
.dnd-tab.is-sel { background: var(--accent-soft); color: var(--ink-0); font-weight: 500; }
.dnd-tab-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--ink-4); flex-shrink: 0; }
.dnd-tab.is-sel .dnd-tab-dot { background: var(--accent); }
.dnd-tab-hint {
  margin-left: auto; font-size: 11px; color: var(--ink-4);
  text-transform: uppercase; letter-spacing: 0.04em;
}

/* ---- LEVEL 3 — reading area ---- */
.dnd-read { overflow-y: auto; padding: 30px 40px 64px; min-width: 0; }
.dnd-read-prompt, .dnd-loading { font-size: 15px; color: var(--ink-3); padding: 40px 0; }
.dnd-read-title {
  margin: 0; font-size: 24px; font-weight: 600; color: var(--ink-0);
  letter-spacing: -0.02em; line-height: 1.25;
}
.dnd-read-title strong { font-weight: 600; }
.dnd-facet-label {
  font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.08em;
  color: var(--accent); margin: 8px 0 18px;
}
.dnd-h2 {
  font-size: 13px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.07em;
  color: var(--ink-3); margin: 30px 0 14px;
}
.dnd-muted { font-size: 15px; color: var(--ink-3); }
.dnd-muted-2 { font-size: 14px; color: var(--ink-4); margin-top: 6px; }
.dnd-error {
  font-size: 14px; color: oklch(0.78 0.10 30);
  padding: 12px 16px; background: oklch(0.22 0.05 30 / 0.18);
  border: 1px solid oklch(0.42 0.08 30 / 0.32); border-radius: 6px; margin: 12px 0;
}
.dnd-empty { font-size: 15px; line-height: 1.6; color: var(--ink-3); padding: 16px 0; }
.dnd-empty code {
  background: var(--bg-1); border: 1px solid var(--line-hair); padding: 1px 6px;
  border-radius: 4px; font-size: 14px; font-family: var(--font-mono); color: var(--ink-0);
}

/* Discovery facet */
.dnd-problem {
  font-size: 16px; line-height: 1.65; color: var(--ink-2);
  padding: 16px 18px; background: var(--surface-2);
  border: 1px solid var(--line-hair); border-radius: 10px;
}
.dnd-flow { list-style: none; counter-reset: f; margin: 0; padding: 0; }
.dnd-flow li {
  counter-increment: f; position: relative; padding: 13px 0 13px 44px;
  font-size: 16px; color: var(--ink-1); line-height: 1.6;
  border-bottom: 1px solid var(--line-hair);
}
.dnd-flow li:last-child { border-bottom: none; }
.dnd-flow li::before {
  content: counter(f); position: absolute; left: 0; top: 11px;
  width: 28px; height: 28px; border-radius: 50%;
  background: var(--accent-soft); color: var(--accent);
  font-size: 13px; font-weight: 600;
  display: flex; align-items: center; justify-content: center;
}
.dnd-group { margin-bottom: 20px; }
.dnd-group-name {
  font-size: 15px; font-weight: 600; color: var(--ink-0);
  margin: 0 0 9px; padding-bottom: 7px; border-bottom: 1px solid var(--line-soft);
}
.dnd-items { list-style: none; margin: 0; padding: 0; }
.dnd-item { display: flex; align-items: baseline; gap: 10px; padding: 7px 0; font-size: 15px; color: var(--ink-2); line-height: 1.55; }
.dnd-item-text { flex: 1; min-width: 0; }
.dnd-tag {
  font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em;
  padding: 3px 8px; border-radius: 6px; white-space: nowrap;
}
.dnd-tag.is-diff { background: var(--accent-soft); color: var(--accent); }
.dnd-tag.is-risk { background: var(--st-blocked-bg); color: var(--st-blocked); }
.dnd-tag.is-fact { background: var(--bg-2); color: var(--ink-2); }
.dnd-tag.is-option { background: var(--st-waiting-bg); color: var(--st-waiting); }
.dnd-lanes { display: grid; grid-template-columns: 1fr 1fr; gap: 13px; }
.dnd-lane { background: var(--surface-2); border: 1px solid var(--line-hair); border-radius: 10px; padding: 14px 15px; }
.dnd-lane-lab { font-size: 11.5px; text-transform: uppercase; letter-spacing: 0.05em; color: var(--ink-4); margin-bottom: 7px; }
.dnd-lane p { font-size: 14.5px; color: var(--ink-2); line-height: 1.5; margin: 0; }
.dnd-qs { list-style: none; margin: 0; padding: 0; }
.dnd-qs li { font-size: 15px; color: var(--ink-2); padding: 9px 0 9px 18px; position: relative; border-bottom: 1px solid var(--line-hair); }
.dnd-qs li:last-child { border-bottom: none; }
.dnd-qs li::before { content: "?"; position: absolute; left: 0; color: var(--ink-4); font-weight: 600; }

/* Overview facet */
.dnd-overview-state { margin-bottom: 14px; }
.dnd-overview-desc { font-size: 16px; line-height: 1.65; color: var(--ink-2); margin: 0; }
.dnd-children { list-style: none; margin: 0; padding: 0; }
.dnd-child {
  display: flex; align-items: center; justify-content: space-between; gap: 12px;
  padding: 12px 0; border-bottom: 1px solid var(--line-hair);
}
.dnd-child:last-child { border-bottom: none; }
.dnd-child-name { font-size: 15px; color: var(--ink-1); line-height: 1.4; min-width: 0; }
.dnd-child-name strong { font-weight: 600; color: var(--ink-0); }
.dnd-child-id { color: var(--ink-4); font-weight: 400; font-size: 13px; }
.dnd-child-meta { display: flex; align-items: center; gap: 8px; flex-shrink: 0; }
.dnd-child-type { font-size: 12px; color: var(--ink-4); }

/* Demo facet + placeholder */
.dnd-placeholder { padding: 8px 0; }
.dnd-demo-controls { display: flex; align-items: flex-end; gap: 14px; flex-wrap: wrap; margin: 18px 0; }
.dnd-field { display: flex; flex-direction: column; gap: 6px; font-size: 13px; color: var(--ink-3); }
.dnd-field select, .dnd-field input {
  font-family: inherit; font-size: 14px; color: var(--ink-1);
  background: var(--surface-2); border: 1px solid var(--line-soft);
  border-radius: 8px; padding: 8px 10px;
}
.dnd-btn {
  appearance: none; cursor: pointer; font-family: inherit; font-size: 14px; font-weight: 500;
  color: var(--ink-0); background: var(--accent-soft); border: 1px solid var(--accent-deep);
  border-radius: 8px; padding: 9px 16px;
}
.dnd-btn:hover { background: var(--accent); color: var(--bg-0); }
.dnd-btn.is-quiet { background: var(--surface-2); border-color: var(--line-soft); color: var(--ink-2); }
.dnd-demo-folder { display: flex; align-items: center; gap: 10px; margin-top: 8px; }
.dnd-path { font-family: var(--font-mono); font-size: 12.5px; color: var(--ink-3); }

/* Narrow: drop the facet menu into a row of pills under the title area. */
@media (max-width: 900px) {
  .dnd, .dnd:has(.dnd-read-prompt) { grid-template-columns: 240px minmax(0, 1fr); }
  .dnd-menu {
    grid-column: 2; border-right: none; border-bottom: 1px solid var(--line-soft);
    display: flex; gap: 6px; padding: 12px 16px; overflow-x: auto;
  }
  .dnd-menu-cap { display: none; }
  .dnd-tab { width: auto; margin-bottom: 0; white-space: nowrap; }
  .dnd-read { grid-column: 2; }
}
```

- [ ] **Step 4: Verify the mode still mounts + build**

Confirm `Dashboard.tsx:311-312` still reads `mode === 'dnd' ? ( <DnDView /> )` — no change needed (same export, no props).

Run: `npm run typecheck` → no errors.
Run: `npm run build` → succeeds.
Run: `npm test` → all green (the existing `server/discovery-list.test.ts` and Task 1's test are unaffected).

- [ ] **Step 5: Commit**

```bash
git add src/components/DnDView.tsx src/styles/dashboard.css
git commit -m "feat(dnd): three-level layout — feature list, facet menu, reading area"
```

---

## Self-Review

**Spec coverage:**
- Three-column grid (288 / 184 / rest), all visible at once, no full-page swap → Task 3 `.dnd` grid + component renders all three columns without a route flip. ✓
- Facet menu appears only when a feature is open; Discovery default; picking a feature resets to Discovery → `selectedId != null &&` guard + `selectFeature` sets `facet='discovery'`. ✓
- Overview = feature details + child stories/tasks → Task 2 payload + `OverviewFacet`. ✓
- Design/Demo calm placeholders, menu always visible → `DesignFacet`, `DemoFacet`, tabs always rendered. ✓
- Discovery reading order: problem → flow (focal) → groups w/ tag chips → lanes → open questions → `DiscoveryFacet` order matches. ✓
- Sizing floors → CSS uses 15–16px reading, 24px title, 11–12px chips/tags, 14–15px tabs/rows, 12–13px caps. ✓
- No new data/routes; one additive payload change → Tasks 1–2 only extend the existing detail route + type. ✓
- Empty/error/skew states → empty list message, no-discovery message per facet, ADO-down leaves Overview degraded (fields optional, `children` defaults `[]`), error banner. ✓
- Reuse palette vars → Global Constraints + CSS uses only existing vars. ✓

**Placeholder scan:** No TBD/TODO; every code step is complete. ✓

**Type consistency:** `DiscoveryDetailPayload` gains `featureState?`, `featureDescription?`, `children: ApiDiscoveryChild[]` (Task 2) and the component consumes exactly those (Task 3). `Facet` type used consistently. `htmlPreview` signature identical across Tasks 1–2. Chip class names (`is-active`, `is-closed`, `is-blocked`, etc.) are derived from `boardState.toLowerCase()` / `state.toLowerCase()` — the CSS covers the common ADO states and every unmatched state falls back to the neutral base `.dnd-chip`. ✓

**One risk noted for the reviewer:** `.dnd:has(...)` and the `@media` narrow layout are progressive; `:has()` is supported in the app's target (modern Chromium/electron-class browser Moran runs). If `:has()` were unavailable the menu column would just show at 184px with an empty menu before selection — harmless.

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-07-23-dnd-page-redesign.md`. Executing subagent-driven per the standing approach.
