# Discovery HTML Artifacts (Walkthrough + Demo) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a chat session build two self-contained HTML files per feature (a discovery *walkthrough* slideshow and a scrollable concept *demo*), and show them in the dashboard as sub-tabs under Discovery, each in a sealed iframe with Open + Download.

**Architecture:** The Vite dev-server middleware (`vite.config.ts`, `/api/discovery`) reports which artifact files exist and serves them by a fixed `kind`. `DnDView.tsx` drops the top-level Demo tab and gives the Discovery facet an inner sub-tab strip (Review / Walkthrough / Demo). Sessions write the HTML files; the dashboard only reads and shows. Two new skill files carry the writing recipes.

**Tech Stack:** TypeScript, Vite 5 dev-server middleware, React, Vitest 4, plain CSS (design tokens in `src/styles/dashboard.css`).

## Global Constraints

- Two tsconfigs must both typecheck: `tsconfig.app.json` (frontend) + `tsconfig.node.json` (server). Verify with `npm run build` (runs `tsc -b` then vite build) and `npx tsc -p tsconfig.node.json --noEmit`.
- Tests: `npm test` (Vitest). All must stay green.
- Artifact files live in the feature folder's `demo/` subfolder: `demo/walkthrough.html`, `demo/concept-demo.html`. One of each per feature; rebuild overwrites.
- The served HTML is shown in a `sandbox="allow-scripts"` iframe — NO `allow-same-origin`, so its CSS/JS cannot touch the dashboard. This boundary is mandatory (feedback-dnd-concept-demo-format).
- Serve route validates `kind` against a two-value allow-list (`walkthrough` | `demo`) — never a free-form filename, so there is no path-traversal surface.
- The dashboard has NO AI and NO generate button. It only reads and shows files.
- Commit messages end with: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`
- Plain-English UI copy: short, everyday words, no jargon. Never combine ≤11px font with `--ink-4`.
- Work happens on branch `feat/demo-generator` (already created, spec committed there).

---

### Task 1: `htmlArtifactPath` helper + `hasHtmlArtifact` in discovery-store

A pure path helper both the doc route (existence check) and the serve route (read) will use, so the `demo/<file>.html` mapping lives in one place.

**Files:**
- Modify: `server/discovery-store.ts`
- Test: `server/discovery-store.test.ts`

**Interfaces:**
- Produces:
  - `export type HtmlArtifactKind = 'walkthrough' | 'demo';`
  - `export function htmlArtifactPath(featureFolderPath: string, kind: HtmlArtifactKind): string` — returns `<folder>/demo/walkthrough.html` or `<folder>/demo/concept-demo.html`.
  - `export function hasHtmlArtifact(featureFolderPath: string, kind: HtmlArtifactKind): boolean` — `existsSync` of that path.

- [ ] **Step 1: Write the failing test**

Add to `server/discovery-store.test.ts` (inside the existing `describe('discovery-store', ...)` block, after the last `it`):

```typescript
it('maps html artifact kinds to demo/ files and reports existence', () => {
  expect(htmlArtifactPath(dir, 'walkthrough')).toBe(join(dir, 'demo', 'walkthrough.html'));
  expect(htmlArtifactPath(dir, 'demo')).toBe(join(dir, 'demo', 'concept-demo.html'));

  expect(hasHtmlArtifact(dir, 'demo')).toBe(false);
  mkdirSync(join(dir, 'demo'), { recursive: true });
  writeFileSync(join(dir, 'demo', 'concept-demo.html'), '<!doctype html><title>x</title>');
  expect(hasHtmlArtifact(dir, 'demo')).toBe(true);
  expect(hasHtmlArtifact(dir, 'walkthrough')).toBe(false);
});
```

Add `htmlArtifactPath, hasHtmlArtifact` to the existing import from `./discovery-store` at the top of the test file.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run server/discovery-store.test.ts`
Expected: FAIL — `htmlArtifactPath is not a function` (or import error).

- [ ] **Step 3: Write minimal implementation**

Add to `server/discovery-store.ts`, after the `DISCOVERY_MD` const block (near the top, keeping file-layout constants together):

```typescript
/** HTML artifacts a session builds for a feature, shown in the dashboard's
 *  Discovery sub-tabs. Both live in the feature's `demo/` subfolder. */
export type HtmlArtifactKind = 'walkthrough' | 'demo';
const HTML_ARTIFACT_FILE: Record<HtmlArtifactKind, string> = {
  walkthrough: 'walkthrough.html',
  demo: 'concept-demo.html',
};

/** Absolute path to a feature's HTML artifact of the given kind. */
export function htmlArtifactPath(featureFolderPath: string, kind: HtmlArtifactKind): string {
  return join(featureFolderPath, 'demo', HTML_ARTIFACT_FILE[kind]);
}

/** True when that artifact file exists on disk. */
export function hasHtmlArtifact(featureFolderPath: string, kind: HtmlArtifactKind): boolean {
  return existsSync(htmlArtifactPath(featureFolderPath, kind));
}
```

(`join` and `existsSync` are already imported at the top of the file.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run server/discovery-store.test.ts`
Expected: PASS (all tests in the file green).

- [ ] **Step 5: Commit**

```bash
git add server/discovery-store.ts server/discovery-store.test.ts
git commit -m "feat(discovery): htmlArtifactPath + hasHtmlArtifact helpers

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Doc route reports artifacts + `html/:kind` serve route

Extend the disk-only doc route to report which artifacts exist, and add one route that serves an artifact by kind. No ADO, no new dependency.

**Files:**
- Modify: `vite.config.ts` (the `/api/discovery` middleware — the route regex ~line 484, the no-action doc branch ~line 495, and add an `html` action branch)

**Interfaces:**
- Consumes: `htmlArtifactPath`, `hasHtmlArtifact`, `HtmlArtifactKind` from Task 1.
- Produces (HTTP):
  - `GET /api/discovery/:id` now returns `{ folderPath, doc, hasWalkthrough, hasDemoHtml }`.
  - `GET /api/discovery/:id/html/walkthrough` and `.../html/demo` serve the file as `text/html; charset=utf-8`, or 404 if absent.

- [ ] **Step 1: Add `html` to the route regex**

In `vite.config.ts`, find (~line 484):

```typescript
          const m = path.match(/^\/(\d+)(?:\/(board|demo|open-folder|image)(?:\/[^/]+)?)?\/?$/);
          if (!m) { res.statusCode = 400; res.end(JSON.stringify({ error: 'Expected /api/discovery/<id>[/board|/demo|/open-folder|/image/<name>]' })); return; }
```

Replace with:

```typescript
          const m = path.match(/^\/(\d+)(?:\/(board|demo|open-folder|image|html)(?:\/[^/]+)?)?\/?$/);
          if (!m) { res.statusCode = 400; res.end(JSON.stringify({ error: 'Expected /api/discovery/<id>[/board|/demo|/open-folder|/image/<name>|/html/<kind>]' })); return; }
```

Also update the action comment one line down to include `'html'`:

```typescript
          const action = m[2]; // 'board' | 'demo' | 'open-folder' | 'image' | 'html' | undefined
```

- [ ] **Step 2: Add the artifact helpers to the route's imports**

Find the existing import of discovery-store inside the handler (~line 434):

```typescript
          const { discoveryStatus, readDiscoveryDoc, writeDiscoveryDoc } = await import('./server/discovery-store');
```

Replace with:

```typescript
          const { discoveryStatus, readDiscoveryDoc, writeDiscoveryDoc, hasHtmlArtifact, htmlArtifactPath } = await import('./server/discovery-store');
```

- [ ] **Step 3: Report artifacts on the doc branch**

Find the no-action doc branch (~line 495):

```typescript
          if (!action) {
            if (method !== 'GET') { res.statusCode = 405; res.end(JSON.stringify({ error: 'GET only' })); return; }
            res.end(JSON.stringify({ folderPath, doc: readDiscoveryDoc(folderPath) }));
            return;
          }
```

Replace with:

```typescript
          if (!action) {
            if (method !== 'GET') { res.statusCode = 405; res.end(JSON.stringify({ error: 'GET only' })); return; }
            res.end(JSON.stringify({
              folderPath,
              doc: readDiscoveryDoc(folderPath),
              hasWalkthrough: hasHtmlArtifact(folderPath, 'walkthrough'),
              hasDemoHtml: hasHtmlArtifact(folderPath, 'demo'),
            }));
            return;
          }
```

- [ ] **Step 4: Add the `html` serve branch**

Insert this branch immediately AFTER the `image` branch closes (after its `return;` and closing brace, ~line 556) and BEFORE the `if (action === 'demo')` block:

```typescript
          // HTML — serve a session-built artifact (walkthrough slideshow / concept
          // demo). Fixed filenames by kind; no free-form name → no path traversal.
          if (action === 'html') {
            if (method !== 'GET') { res.statusCode = 405; res.end(JSON.stringify({ error: 'GET only' })); return; }
            const kindMatch = path.match(/\/html\/([^/]+)$/);
            const kind = kindMatch ? decodeURIComponent(kindMatch[1]) : '';
            if (kind !== 'walkthrough' && kind !== 'demo') {
              res.statusCode = 400; res.end(JSON.stringify({ error: 'kind must be walkthrough | demo' })); return;
            }
            const { existsSync, readFileSync } = await import('node:fs');
            const file = htmlArtifactPath(folderPath, kind);
            if (!existsSync(file)) { res.statusCode = 404; res.end(JSON.stringify({ error: 'not built' })); return; }
            res.setHeader('Content-Type', 'text/html; charset=utf-8');
            res.end(readFileSync(file));
            return;
          }
```

- [ ] **Step 5: Verify server typecheck**

Run: `npx tsc -p tsconfig.node.json --noEmit`
Expected: no errors.

- [ ] **Step 6: Smoke the routes manually**

Start the dev server (`npm run dev`), then in another shell (replace `<id>` with a touched feature id):

```bash
curl -s "http://localhost:5173/api/discovery/<id>" | grep -o '"hasWalkthrough":[a-z]*,"hasDemoHtml":[a-z]*'
curl -s -o /dev/null -w "%{http_code}\n" "http://localhost:5173/api/discovery/<id>/html/demo"      # 404 until a file exists
curl -s -o /dev/null -w "%{http_code}\n" "http://localhost:5173/api/discovery/<id>/html/bogus"     # 400
```

Expected: the doc JSON now shows both booleans (both `false`); `html/demo` → 404; `html/bogus` → 400. Then drop a throwaway file to confirm serving:

```bash
mkdir -p "<featureFolder>/demo" && echo '<!doctype html><title>t</title><h1>hi</h1>' > "<featureFolder>/demo/concept-demo.html"
curl -s -w " [%{content_type}]\n" "http://localhost:5173/api/discovery/<id>/html/demo"
rm "<featureFolder>/demo/concept-demo.html"
```

Expected: the HTML body with `[text/html; charset=utf-8]`.

- [ ] **Step 7: Commit**

```bash
git add vite.config.ts
git commit -m "feat(discovery): doc route reports artifacts + html/:kind serve route

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: `DiscoveryDocPayload` booleans in api.ts

Mirror the new server fields in the frontend type. No behavior change yet.

**Files:**
- Modify: `src/lib/api.ts:269-272` (the `DiscoveryDocPayload` interface)

**Interfaces:**
- Consumes: the doc route JSON from Task 2.
- Produces: `DiscoveryDocPayload` gains `hasWalkthrough: boolean; hasDemoHtml: boolean;`

- [ ] **Step 1: Edit the interface**

Find (`src/lib/api.ts` ~line 268):

```typescript
/** Disk-backed part of a feature — reads instantly, never waits on the board. */
export interface DiscoveryDocPayload {
  folderPath: string;
  doc: ApiDiscoveryDoc | null;
}
```

Replace with:

```typescript
/** Disk-backed part of a feature — reads instantly, never waits on the board. */
export interface DiscoveryDocPayload {
  folderPath: string;
  doc: ApiDiscoveryDoc | null;
  /** Whether the session has built each HTML artifact (shown in Discovery sub-tabs). */
  hasWalkthrough: boolean;
  hasDemoHtml: boolean;
}
```

- [ ] **Step 2: Verify frontend typecheck**

Run: `npx tsc -p tsconfig.app.json --noEmit`
Expected: no errors (existing code reads `doc`/`folderPath`; the new required fields are only produced by the server, so no consumer breaks — but if a test or mock constructs `DiscoveryDocPayload` literally, the next task/step will surface it; none exists today).

- [ ] **Step 3: Commit**

```bash
git add src/lib/api.ts
git commit -m "feat(discovery): DiscoveryDocPayload gains hasWalkthrough/hasDemoHtml

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Sealed-iframe artifact view (shared component + CSS)

One small presentational component both sub-tabs use to show an artifact: sealed iframe + Open-in-new-tab + Download. Built and styled on its own so the sub-tab wiring in Task 5 is thin.

**Files:**
- Modify: `src/components/DnDView.tsx` (add the `ArtifactView` component; no wiring yet)
- Modify: `src/styles/dashboard.css` (append `.dnd-artifact*` rules)

**Interfaces:**
- Produces:
  ```typescript
  function ArtifactView(props: { featureId: number; kind: 'walkthrough' | 'demo'; title: string }): JSX.Element
  ```
  Renders an iframe at `/api/discovery/<featureId>/html/<kind>` plus Open + Download links. Caller only renders it when the artifact exists.

- [ ] **Step 1: Add the component**

In `src/components/DnDView.tsx`, add near the other facet helpers (e.g. just before `function DemoFacet`):

```tsx
/** Shows a session-built HTML artifact in a sealed frame. The sandbox allows
 *  scripts (the demo's animated flow, the slideshow) but NOT same-origin, so the
 *  artifact's loud styling can never leak into the calm dashboard. */
function ArtifactView(props: { featureId: number; kind: 'walkthrough' | 'demo'; title: string }): JSX.Element {
  const { featureId, kind, title } = props;
  const url = `/api/discovery/${featureId}/html/${kind}`;
  const downloadName = kind === 'walkthrough' ? 'walkthrough.html' : 'concept-demo.html';
  return (
    <div className="dnd-artifact">
      <div className="dnd-artifact-bar">
        <a className="dnd-btn is-quiet" href={url} target="_blank" rel="noreferrer">Open in new tab</a>
        <a className="dnd-btn is-quiet" href={url} download={downloadName}>Download</a>
      </div>
      <iframe className="dnd-artifact-frame" src={url} title={title} sandbox="allow-scripts" loading="lazy" />
    </div>
  );
}
```

- [ ] **Step 2: Add the CSS**

Append to `src/styles/dashboard.css` (after the existing `.dnd-*` block — e.g. near the `.dnd-demo` rules):

```css
/* ---- Discovery HTML artifacts (walkthrough / demo), shown sealed ---- */
.dnd-artifact { display: flex; flex-direction: column; gap: 12px; margin-top: 8px; }
.dnd-artifact-bar { display: flex; gap: 10px; }
.dnd-artifact-frame {
  width: 100%; min-height: 72vh; border: 1px solid var(--line-strong);
  border-radius: 12px; background: #07090f;
}
.dnd-artifact-empty { font-size: 15px; color: var(--ink-3); padding: 24px 0; }
```

(`.dnd-btn.is-quiet` already exists — reused. The dark frame background matches the concept-demo navy so there's no white flash before load.)

- [ ] **Step 3: Verify typecheck (component is unused — expect a warning path)**

Run: `npx tsc -p tsconfig.app.json --noEmit`
Expected: no errors. (An unused function is not a TS error under this project's config. It gets wired in Task 5.)

- [ ] **Step 4: Commit**

```bash
git add src/components/DnDView.tsx src/styles/dashboard.css
git commit -m "feat(discovery): sealed ArtifactView component + styles

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Discovery sub-tabs — drop top-level Demo, wire Review/Walkthrough/Demo

Rework `DnDView.tsx`: top tabs become Overview · Discovery · Design; the Discovery facet gets an inner sub-tab strip (Review / Walkthrough / Demo) with URL persistence; the old `DemoFacet` becomes the Demo sub-tab and gains the artifact view.

**Files:**
- Modify: `src/components/DnDView.tsx`
- Modify: `src/styles/dashboard.css` (append `.dnd-subtabs*` rules)

**Interfaces:**
- Consumes: `ArtifactView` (Task 4), `DiscoveryDocPayload.hasWalkthrough/hasDemoHtml` (Task 3).
- Produces: no exported API change; `DnDView` still takes `{ onOpenItem }`.

- [ ] **Step 1: Narrow the `Facet` type and URL sub-tab**

Change the `Facet` type (line ~14) from:

```typescript
type Facet = 'overview' | 'discovery' | 'design' | 'demo';
```

to:

```typescript
type Facet = 'overview' | 'discovery' | 'design';
type DiscoverySub = 'review' | 'walkthrough' | 'demo';
```

Update the `FACETS` const (line ~140):

```typescript
const FACETS: Facet[] = ['overview', 'discovery', 'design'];
const DISCOVERY_SUBS: DiscoverySub[] = ['review', 'walkthrough', 'demo'];
```

- [ ] **Step 2: Read + persist the sub-tab in URL state**

Replace `readUrlState` (lines ~142-150) with:

```typescript
/** Read the open feature + facet + discovery sub-tab from the URL so a refresh
 *  restores them. */
function readUrlState(): { id: number | null; facet: Facet; sub: DiscoverySub } {
  if (typeof window === 'undefined') return { id: null, facet: 'discovery', sub: 'review' };
  const p = new URL(window.location.href).searchParams;
  const rawId = Number(p.get('feature'));
  const id = Number.isInteger(rawId) && rawId > 0 ? rawId : null;
  const f = p.get('facet');
  const s = p.get('sub');
  return {
    id,
    facet: FACETS.includes(f as Facet) ? (f as Facet) : 'discovery',
    sub: DISCOVERY_SUBS.includes(s as DiscoverySub) ? (s as DiscoverySub) : 'review',
  };
}
```

- [ ] **Step 3: Add sub-tab state + URL sync in `DnDView`**

In `DnDView`, after `const [facet, setFacet] = useState<Facet>(initial.facet);` (line ~156) add:

```typescript
  const [sub, setSub] = useState<DiscoverySub>(initial.sub);
```

Update the URL-sync effect (lines ~189-194) to include `sub`:

```typescript
  useEffect(() => {
    const url = new URL(window.location.href);
    if (selectedId == null) {
      url.searchParams.delete('feature'); url.searchParams.delete('facet'); url.searchParams.delete('sub');
    } else {
      url.searchParams.set('feature', String(selectedId));
      url.searchParams.set('facet', facet);
      if (facet === 'discovery') url.searchParams.set('sub', sub); else url.searchParams.delete('sub');
    }
    window.history.replaceState(null, '', url.toString());
  }, [selectedId, facet, sub]);
```

Update the popstate handler (lines ~197-201) to restore `sub`:

```typescript
  useEffect(() => {
    const handler = () => { const s = readUrlState(); setSelectedId(s.id); setFacet(s.facet); setSub(s.sub); };
    window.addEventListener('popstate', handler);
    return () => window.removeEventListener('popstate', handler);
  }, []);
```

- [ ] **Step 4: Remove `demoStatus` from the top bar; drop the Demo top tab**

In `DnDView`, the `demoStatus` const (line ~212) is still used by the Demo sub-tab hint — keep it. Change the `FeatureFacetBar` usage (line ~233) to stop passing `demoStatus` (the bar no longer shows Demo):

```tsx
        <FeatureFacetBar facet={facet} onPick={setFacet} />
```

Replace `FeatureFacetBar` (lines ~384-412) with the three-tab version (no demo, no demoStatus prop):

```tsx
function FeatureFacetBar(props: {
  facet: Facet;
  onPick: (f: Facet) => void;
}): JSX.Element {
  const { facet, onPick } = props;
  const tabs: { id: Facet; label: string; hint?: string }[] = [
    { id: 'overview', label: 'Overview' },
    { id: 'discovery', label: 'Discovery' },
    { id: 'design', label: 'Design', hint: 'soon' },
  ];
  return (
    <nav className="dnd-tabbar" role="tablist" aria-label="This feature">
      {tabs.map(t => (
        <button
          key={t.id}
          role="tab"
          aria-selected={t.id === facet}
          className={`dnd-tabtop${t.id === facet ? ' is-sel' : ''}`}
          onClick={() => onPick(t.id)}
        >
          <span className="dnd-tabtop-label">{t.label}</span>
          {t.hint && <span className="dnd-tabtop-hint">{t.hint}</span>}
        </button>
      ))}
    </nav>
  );
}
```

- [ ] **Step 5: Thread `sub` + doc booleans into the reading area**

Update the `FacetReadingArea` call in `DnDView` (lines ~234-243) to pass `sub`, `onSub`, and the payload:

```tsx
        <FacetReadingArea
          facet={facet}
          sub={sub}
          onSub={setSub}
          featureId={selectedId}
          displayName={selectedName}
          doc={doc}
          board={board}
          error={error}
          onReloadDoc={loadDoc}
          onOpenItem={onOpenItem}
        />
```

Update the `FacetReadingArea` signature + body (lines ~416-446). Replace the whole function with:

```tsx
function FacetReadingArea(props: {
  facet: Facet;
  sub: DiscoverySub;
  onSub: (s: DiscoverySub) => void;
  featureId: number;
  displayName: string;
  doc: DiscoveryDocPayload | null;
  board: DiscoveryBoardPayload | null;
  error: string | null;
  onReloadDoc: () => void;
  onOpenItem?: (id: string) => void;
}): JSX.Element {
  const { facet, sub, onSub, featureId, displayName, doc, board, error, onReloadDoc, onOpenItem } = props;

  if (error) {
    return <main className="dnd-read"><div className="dnd-error">Couldn't read this feature: {error}</div></main>;
  }
  if (!doc) {
    return <main className="dnd-read"><div className="dnd-loading">Loading…</div></main>;
  }

  return (
    <main className="dnd-read">
      <h1 className="dnd-read-title">{renderDisplayName(displayName)}</h1>
      {facet === 'overview' && <OverviewFacet board={board} onOpenItem={onOpenItem} />}
      {facet === 'discovery' && (
        <DiscoveryFacet
          sub={sub}
          onSub={onSub}
          featureId={featureId}
          payload={doc}
          onReloadDoc={onReloadDoc}
        />
      )}
      {facet === 'design' && <DesignFacet />}
    </main>
  );
}
```

- [ ] **Step 6: Give `DiscoveryFacet` its sub-tab strip**

Replace the current `DiscoveryFacet` (lines ~523-566) with a wrapper that renders the sub-tab strip and switches between Review / Walkthrough / Demo. Rename the current body to `DiscoveryReview`:

```tsx
function DiscoverySubBar(props: {
  sub: DiscoverySub;
  onSub: (s: DiscoverySub) => void;
  demoStatus: 'none' | 'scheduled' | 'built';
}): JSX.Element {
  const { sub, onSub, demoStatus } = props;
  const tabs: { id: DiscoverySub; label: string; hint?: string }[] = [
    { id: 'review', label: 'Review' },
    { id: 'walkthrough', label: 'Walkthrough' },
    { id: 'demo', label: 'Demo', hint: demoStatus === 'none' ? undefined : demoStatus },
  ];
  return (
    <nav className="dnd-subtabs" role="tablist" aria-label="Discovery views">
      {tabs.map(t => (
        <button
          key={t.id}
          role="tab"
          aria-selected={t.id === sub}
          className={`dnd-subtab${t.id === sub ? ' is-sel' : ''}`}
          onClick={() => onSub(t.id)}
        >
          {t.label}
          {t.hint && <span className="dnd-subtab-hint">{t.hint}</span>}
        </button>
      ))}
    </nav>
  );
}

function DiscoveryFacet(props: {
  sub: DiscoverySub;
  onSub: (s: DiscoverySub) => void;
  featureId: number;
  payload: DiscoveryDocPayload;
  onReloadDoc: () => void;
}): JSX.Element {
  const { sub, onSub, featureId, payload, onReloadDoc } = props;
  const demoStatus = payload.doc?.demo.status ?? 'none';
  return (
    <div className="dnd-discovery-wrap">
      <DiscoverySubBar sub={sub} onSub={onSub} demoStatus={demoStatus} />
      {sub === 'review' && <DiscoveryReview doc={payload.doc} />}
      {sub === 'walkthrough' && (
        payload.hasWalkthrough
          ? <ArtifactView featureId={featureId} kind="walkthrough" title="Discovery walkthrough" />
          : <p className="dnd-artifact-empty">No walkthrough built yet. In a Discovery &amp; Design chat, ask to build the walkthrough slideshow.</p>
      )}
      {sub === 'demo' && (
        <DemoFacet
          featureId={featureId}
          folderPath={payload.folderPath}
          doc={payload.doc}
          hasDemoHtml={payload.hasDemoHtml}
          onSaved={onReloadDoc}
        />
      )}
    </div>
  );
}

function DiscoveryReview(props: { doc: DiscoveryDocPayload['doc'] }): JSX.Element {
  const { doc } = props;
  if (!doc) return <div className="dnd-empty">This feature has no discovery yet.</div>;
  return (
    <div className="dnd-discovery">
      <div className="dnd-problem">{doc.problem || '—'}</div>

      <h2 className="dnd-h2">The feature end-to-end</h2>
      <ol className="dnd-flow">{doc.flow.map((s, i) => <li key={i}>{s}</li>)}</ol>

      <h2 className="dnd-h2">Context groups</h2>
      {doc.groups.map((g, gi) => (
        <details key={gi} className="dnd-group">
          <summary className="dnd-group-sum">
            <span className="dnd-group-chev" aria-hidden="true" />
            <span className="dnd-group-name">{g.name}</span>
            <span className="dnd-group-count">{g.items.length}</span>
          </summary>
          <ul className="dnd-items">
            {g.items.map((it, ii) => <ContextItem key={ii} item={it} />)}
          </ul>
        </details>
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
      <p className="dnd-section-note">Still unanswered — your agenda for the talk with the platform team.</p>
      {doc.openQuestions.length === 0
        ? <p className="dnd-muted">None noted.</p>
        : <ul className="dnd-qs">{doc.openQuestions.map((q, i) => <li key={i}>{q}</li>)}</ul>}
    </div>
  );
}
```

- [ ] **Step 7: Add the artifact view to `DemoFacet`**

In `DemoFacet` (lines ~577-629), add `hasDemoHtml: boolean` to the props type, and render the artifact when present. Change the signature:

```tsx
function DemoFacet(props: {
  featureId: number;
  folderPath: string;
  doc: DiscoveryDocPayload['doc'];
  hasDemoHtml: boolean;
  onSaved: () => void;
}): JSX.Element {
  const { featureId: id, folderPath, doc, hasDemoHtml, onSaved } = props;
```

Then, inside the returned JSX, replace the "Where the demo stands" paragraph block. Find:

```tsx
      <h2 className="dnd-h2">Where the demo stands</h2>
      <p className="dnd-muted">
        A built demo will show up here once the demo generator exists. For now you can mark where the demo stands.
      </p>
```

Replace with:

```tsx
      <h2 className="dnd-h2">The demo</h2>
      {hasDemoHtml
        ? <ArtifactView featureId={id} kind="demo" title="Concept demo" />
        : <p className="dnd-artifact-empty">No demo built yet. In a Discovery &amp; Design chat, ask to build the concept demo.</p>}

      <h2 className="dnd-h2">Where the demo stands</h2>
```

- [ ] **Step 8: Add sub-tab CSS**

Append to `src/styles/dashboard.css` (near the `.dnd-artifact` block from Task 4):

```css
/* ---- Discovery inner sub-tabs (Review / Walkthrough / Demo) ---- */
.dnd-discovery-wrap { display: flex; flex-direction: column; }
.dnd-subtabs { display: flex; gap: 6px; margin: 0 0 22px; border-bottom: 1px solid var(--line-soft); }
.dnd-subtab {
  appearance: none; -webkit-appearance: none; cursor: pointer; font-family: inherit;
  display: inline-flex; align-items: center; gap: 7px;
  background: none; border: none; padding: 8px 12px 10px;
  color: var(--ink-3); font-size: 14px; font-weight: 500;
  border-bottom: 2px solid transparent; margin-bottom: -1px;
  transition: color 0.15s ease, border-color 0.15s ease;
}
.dnd-subtab:hover { color: var(--ink-1); }
.dnd-subtab:focus-visible { outline: 2px solid var(--accent); outline-offset: -3px; }
.dnd-subtab.is-sel { color: var(--ink-0); font-weight: 600; border-bottom-color: var(--accent); }
.dnd-subtab-hint {
  font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.03em;
  color: var(--accent); border: 1px solid color-mix(in oklch, var(--accent) 32%, transparent);
  border-radius: 999px; padding: 1px 7px;
}
```

- [ ] **Step 9: Verify typecheck + build**

Run: `npm run build`
Expected: `tsc -b` clean, vite build succeeds. (Confirms no dangling references to the removed `'demo'` facet or the old `DiscoveryFacet` signature.)

- [ ] **Step 10: Run the full test suite**

Run: `npm test`
Expected: all green (no frontend unit tests touch these components; this confirms nothing else broke).

- [ ] **Step 11: Smoke in the browser**

`npm run dev`, open the D&D page, pick a feature:
- Top tabs show Overview · Discovery · Design (no Demo).
- Discovery shows sub-tabs Review · Walkthrough · Demo. Review is unchanged.
- Walkthrough + Demo show the "not built yet" note.
- Refresh on the Demo sub-tab (`?facet=discovery&sub=demo`) stays on Demo.
- Drop a throwaway `demo/concept-demo.html` in the feature folder, reload → the Demo sub-tab shows it sealed, Open + Download work. Remove the file after.

- [ ] **Step 12: Commit**

```bash
git add src/components/DnDView.tsx src/styles/dashboard.css
git commit -m "feat(discovery): Discovery sub-tabs (Review/Walkthrough/Demo); drop top-level Demo tab

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: The `demo` writing skill (concept-demo scrollable page)

A self-contained skill telling a session how to build `demo/concept-demo.html`. Written to all three skill locations.

**Files:**
- Create: `~/projects/github-moran/features/.claude/skills/demo/SKILL.md` (seed)
- Create: `~/.claude/skills/sprint-helper-plus/skills/demo/SKILL.md` (global on-ramp)
- Create: `~/projects/github-msd/sprint-helper/.claude/skills/demo/SKILL.md` (live workspace copy)

**Interfaces:** none (prose). The file path the session writes MUST be `demo/concept-demo.html` in the feature folder (matches Task 1's `HTML_ARTIFACT_FILE`).

- [ ] **Step 1: Write the seed skill**

Create `~/projects/github-moran/features/.claude/skills/demo/SKILL.md`:

```markdown
---
name: demo
description: Use when building a CONCEPT DEMO for a feature whose discovery is done — one self-contained, scrollable HTML page that throws a convincing picture of the idea on screen. NOT a working system, NOT slides. Fast, honest, flashy.
---

# Concept demo (this workspace)

A concept demo is one long **scrollable** HTML page that pictures the feature
working, to show a stakeholder or think out loud — before any real build. It is
NOT a working system and NOT a slide deck. Build it only once discovery is done.

## When to offer it

The moment the feature's discovery is complete (its `discovery.json` has a
non-empty `flow` AND at least one group with a diff, a risk, and a fact-or-option),
offer in one plain line, naming the feature by its `displayName`:

> **<feature>** discovery looks complete — want me to build a concept demo?

Do not build without a yes.

## Pick the flow (2–3 ideas first)

Read the discovery — especially `demo.notes` (the demo candidate) and `flow`.
Offer 2–3 demo ideas in plain words, one line each: which flow to show and why.
Let the user pick one. Build only the picked one.

## Write the file

Write one self-contained HTML file to `demo/concept-demo.html` in the feature's
folder (create `demo/` if absent). No CDN, no external files — it must open
offline. The page, top to bottom:

1. **Honest banner** — e.g. "Illustrative concept for design review — not a
   working system · all steps mocked/animated." Never pretends to be real. This is
   what makes it safe to show during discovery.
2. **Human hook FIRST** (before any architecture) — a big first-person line
   selling the FEELING: "I merged my PR. It was live in DEV before I closed the
   tab." State the win as crossed-out pain (~~kubectl~~, ~~deploy tickets~~).
3. **Numbered pillars** (`01`, `02`, …) — one idea each. The star pillar has an
   INTERACTIVE animated flow: Run / Step / Reset buttons, a fake console printing
   lines, stages lighting up along a rail.
4. **"Behind the scenes" layer** — a calmer panel after the shiny view: the real
   machinery (bot → GitOps repo → sync → RBAC chokepoint → cluster). Honest about
   what's underneath.
5. **A dashed "Alternative / out of scope" aside** — amber, dashed border,
   explicitly "NOT in this feature — parked for debate." The discovery debate made
   visible: the shipped idea vs the thing still argued, clearly separated.

## The look (style tokens)

- Deep navy background (`--bg:#07090f`, `--bg2:#0c1120`, `--card:#0f1524`), radial
  glows in the top corners.
- Accents: teal `#5eead4`, blue `#7c9dff`, violet `#b088ff`, amber `#ffcc66`
  (debate), danger `#ff6b81`, green `#4ade80`.
- Big gradient headline (white→teal→blue→violet via `-webkit-background-clip:text`),
  `clamp()` sizing, weight 800.
- Section chrome: a numbered pill + an h2 + a right-aligned dashed tag.
- Font: "Segoe UI" / system-ui. Keyframes like `pulse`, `breathe`, `spin` are
  fine — but ALWAYS include
  `@media (prefers-reduced-motion: reduce) { * { animation-duration: .001s !important } }`.
  Flashy by choice, accessibility-safe.

This loud style is the OPPOSITE of the calm sprint-helper dashboard, and that is
fine — the dashboard shows this file in a SEALED frame, it never copies the look.
Keep it a separate self-contained file.

## After writing

Mark the demo built so the dashboard reflects it: set the discovery's demo status
to `built` (the dashboard's Demo sub-tab and `orient` read this). Tell the user in
one line where it shows: the **Demo** sub-tab under Discovery on the D&D page.

## Voice

Plain English, short sentences. The reader/viewer may be a non-native speaker and
some walk in cold. Every line must be honest — a dramatic-but-wrong line is worse
than no line, because a cold viewer trusts the screen.
```

- [ ] **Step 2: Copy to the other two locations**

```bash
mkdir -p ~/.claude/skills/sprint-helper-plus/skills/demo ~/projects/github-msd/sprint-helper/.claude/skills/demo
cp ~/projects/github-moran/features/.claude/skills/demo/SKILL.md ~/.claude/skills/sprint-helper-plus/skills/demo/SKILL.md
cp ~/projects/github-moran/features/.claude/skills/demo/SKILL.md ~/projects/github-msd/sprint-helper/.claude/skills/demo/SKILL.md
diff -q ~/projects/github-moran/features/.claude/skills/demo/SKILL.md ~/.claude/skills/sprint-helper-plus/skills/demo/SKILL.md && echo "on-ramp identical"
diff -q ~/projects/github-moran/features/.claude/skills/demo/SKILL.md ~/projects/github-msd/sprint-helper/.claude/skills/demo/SKILL.md && echo "live identical"
```

Expected: both "identical".

- [ ] **Step 3: Commit the seed (it's the only one inside a tracked repo path here)**

The seed lives under `~/projects/github-moran/features/` (not this git repo) and the global/live copies live outside any repo — none are committed by this project's git. No commit step; the files are in place. (Note in the execution log that skills were written to all three locations.)

---

### Task 7: The `walkthrough` writing skill (discovery slideshow)

A self-contained skill telling a session how to build `demo/walkthrough.html` — an interactive slideshow presenting the discovery.

**Files:**
- Create: `~/projects/github-moran/features/.claude/skills/walkthrough/SKILL.md` (seed)
- Create: `~/.claude/skills/sprint-helper-plus/skills/walkthrough/SKILL.md` (global on-ramp)
- Create: `~/projects/github-msd/sprint-helper/.claude/skills/walkthrough/SKILL.md` (live workspace copy)

**Interfaces:** none (prose). The file path the session writes MUST be `demo/walkthrough.html` (matches Task 1's `HTML_ARTIFACT_FILE`).

- [ ] **Step 1: Write the seed skill**

Create `~/projects/github-moran/features/.claude/skills/walkthrough/SKILL.md`:

```markdown
---
name: walkthrough
description: Use when building a DISCOVERY WALKTHROUGH for a feature — an interactive, self-contained HTML slideshow that presents the discovery findings slide by slide, for showing a room or uploading to another repo. NOT the concept demo (that pictures the product working).
---

# Discovery walkthrough (this workspace)

A walkthrough is one self-contained HTML **slideshow** that presents a feature's
discovery — the findings, slide by slide — so you can walk a room through it or
upload it somewhere outside the dashboard. It is NOT the concept demo (that
pictures the product working); this presents what the discovery FOUND.

## When to offer it

Once the feature's discovery is complete, offer in one plain line, naming the
feature by its `displayName`:

> **<feature>** discovery is ready — want a walkthrough slideshow to present it?

Build only on a yes.

## What each slide holds

Read the discovery (`discovery.json`). Build the slides straight from it, one idea
per slide, in this order:

1. **Title** — the feature name + one line on what it's about.
2. **What we're solving** — the `problem`, 2–3 lines.
3. **The end-to-end flow** — the `flow` steps, revealed one at a time.
4. **One slide per context group** — the group name, then its items with their tag
   chips (diff / risk / fact / option). Keep a diff and its risk visually paired.
5. **Lanes** — ours vs the tech lead's, one line each.
6. **Open questions** — the list; frame it as the agenda for the platform-team talk.

## The slideshow itself

- One self-contained HTML file at `demo/walkthrough.html` (create `demo/` if
  absent). No CDN — opens offline.
- Keyboard + on-screen navigation: arrow keys / Prev-Next buttons, a slide counter.
- One idea per slide. No walls of text — a slide is a headline plus a few short
  lines, never a paragraph.
- Tag chips use clear colors: diff and risk stand out (they're the point), fact and
  option are quieter.
- Calmer and more readable than the concept demo — this is for discussion, not wow.
  A restrained palette, high contrast, large type.
- Always include
  `@media (prefers-reduced-motion: reduce) { * { animation-duration: .001s !important } }`.

The dashboard shows this file in a SEALED frame — its styling can't touch the
dashboard, so style it for the room, not for the app.

## After writing

Tell the user in one line where it shows: the **Walkthrough** sub-tab under
Discovery on the D&D page, with Open-in-new-tab and Download.

## Voice

Plain English, short sentences. The reader is a non-native speaker and some
reviewers walk in cold. Names before numbers — echo a work item's `displayName`.
Every line must be exactly right; a dramatic-but-wrong line is worse than none.
```

- [ ] **Step 2: Copy to the other two locations**

```bash
mkdir -p ~/.claude/skills/sprint-helper-plus/skills/walkthrough ~/projects/github-msd/sprint-helper/.claude/skills/walkthrough
cp ~/projects/github-moran/features/.claude/skills/walkthrough/SKILL.md ~/.claude/skills/sprint-helper-plus/skills/walkthrough/SKILL.md
cp ~/projects/github-moran/features/.claude/skills/walkthrough/SKILL.md ~/projects/github-msd/sprint-helper/.claude/skills/walkthrough/SKILL.md
diff -q ~/projects/github-moran/features/.claude/skills/walkthrough/SKILL.md ~/.claude/skills/sprint-helper-plus/skills/walkthrough/SKILL.md && echo "on-ramp identical"
diff -q ~/projects/github-moran/features/.claude/skills/walkthrough/SKILL.md ~/projects/github-msd/sprint-helper/.claude/skills/walkthrough/SKILL.md && echo "live identical"
```

Expected: both "identical".

- [ ] **Step 3: No commit (skills live outside this repo)** — same as Task 6 Step 3. Note in the execution log that both skills were written to all three locations.

---

## Self-Review

**1. Spec coverage:**
- Two HTML artifacts (walkthrough slideshow + scrollable demo) → Tasks 6 & 7 (writing recipes), Tasks 1–2 (paths + serving), Task 4–5 (showing). ✓
- Files at `demo/walkthrough.html` + `demo/concept-demo.html` → Task 1 `HTML_ARTIFACT_FILE`, used consistently in Tasks 2/4/6/7. ✓
- Discovery three sub-tabs (Review unchanged / Walkthrough / Demo) → Task 5. ✓
- Top-level Demo tab removed → Task 5 Step 4. ✓
- Demo status/date/candidate controls move into the Demo sub-tab → Task 5 (DemoFacet reused under the sub-tab). ✓
- One serve mechanism, sealed iframe, `sandbox="allow-scripts"`, no same-origin → Task 4. ✓
- `kind` allow-list, no path traversal → Task 2 Step 4. ✓
- Doc route booleans, no ADO, no new request → Task 2 Step 3. ✓
- URL persistence of sub-tab (`?sub=`) → Task 5 Steps 2–3. ✓
- "Offer when complete" = skill instructions only, no orient/MCP code → Tasks 6/7; nothing added to orient. ✓
- Skills in all three locations → Tasks 6/7 Steps 1–2. ✓
- Pure helper unit-tested; routes/UI user-smoked → Task 1 test; Tasks 2/5 smokes. ✓

**2. Placeholder scan:** No TBD/TODO; every code step shows full code; smoke steps give exact curl/commands. ✓

**3. Type consistency:**
- `HtmlArtifactKind = 'walkthrough' | 'demo'` (Task 1) matches `kind` param in `ArtifactView` (Task 4) and the serve route allow-list (Task 2). ✓
- `htmlArtifactPath(folderPath, kind)` signature identical in Tasks 1, 2. ✓
- `DiscoveryDocPayload.hasWalkthrough/hasDemoHtml` (Task 3) consumed as `payload.hasWalkthrough`/`payload.hasDemoHtml` (Task 5). ✓
- `Facet` narrowed to 3 values; every `facet === 'demo'` reference removed (Task 5 Steps 1, 4, 5). ✓
- `DiscoveryFacet` old signature `{ doc }` fully replaced; new callers pass `{ sub, onSub, featureId, payload, onReloadDoc }` (Task 5 Steps 5–6). Old body preserved as `DiscoveryReview`. ✓
- `DemoFacet` gains `hasDemoHtml`; caller in Task 5 Step 6 passes it. ✓

All consistent.
