import { useCallback, useEffect, useState } from 'react';
import {
  fetchDiscoveryList, fetchDiscoveryDoc, fetchDiscoveryBoard, markDiscoveryDemo, openDiscoveryFolder,
  type ApiFeatureSection, type ApiFeatureListEntry, type DiscoveryDocPayload, type DiscoveryBoardPayload,
  type ApiDiscoveryChild, type DndStatus,
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

/** Turn inline **bold** runs anywhere in a string into <strong> spans. */
function renderInlineBold(s: string): (string | JSX.Element)[] {
  return s.split(/(\*\*[^*]+\*\*)/g).map((part, i) =>
    /^\*\*[^*]+\*\*$/.test(part) ? <strong key={i}>{part.slice(2, -2)}</strong> : part,
  );
}

/** Render board description text: paragraphs split on blank lines, inline bold honored. */
function renderDescription(text: string): JSX.Element {
  const paras = text.split(/\n{2,}/).map(p => p.trim()).filter(Boolean);
  return (
    <>
      {paras.map((p, i) => (
        <p key={i} className="dnd-overview-desc">
          {p.split('\n').map((line, j) => (
            <span key={j}>{j > 0 && <br />}{renderInlineBold(line)}</span>
          ))}
        </p>
      ))}
    </>
  );
}

export function DnDView(): JSX.Element {
  const [sections, setSections] = useState<ApiFeatureSection[] | null>(null);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [facet, setFacet] = useState<Facet>('discovery');
  // Disk-backed doc (Discovery/Demo) and board data (Overview) load separately,
  // so a slow board never stalls the doc that's sitting ready on disk.
  const [doc, setDoc] = useState<DiscoveryDocPayload | null>(null);
  const [board, setBoard] = useState<DiscoveryBoardPayload | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadList = useCallback(() => {
    setError(null);
    fetchDiscoveryList()
      .then(p => setSections(Array.isArray(p?.sections) ? p.sections : []))
      .catch(e => setError(String(e)));
  }, []);

  useEffect(() => { loadList(); }, [loadList]);

  const loadDoc = useCallback(() => {
    if (selectedId == null) { setDoc(null); setBoard(null); return; }
    setError(null);
    // Clear the old feature's data first so the reading area shows "Loading…"
    // instead of feature A's content under feature B while B loads.
    setDoc(null);
    setBoard(null);
    // Two independent requests. The doc is disk-only and returns instantly;
    // the board hits ADO and may lag — it fills the Overview when it arrives.
    fetchDiscoveryDoc(selectedId).then(setDoc).catch(e => setError(String(e)));
    fetchDiscoveryBoard(selectedId).then(setBoard).catch(() => setBoard({ reachable: false, children: [] }));
  }, [selectedId]);

  useEffect(() => { loadDoc(); }, [loadDoc]);

  function selectFeature(id: number): void {
    setSelectedId(id);
    setFacet('discovery');
  }

  const demoStatus = doc?.doc?.demo.status ?? 'none';
  const selectedName =
    sections?.flatMap(s => s.features).find(f => f.id === selectedId)?.displayName ?? `#${selectedId}`;

  // No feature open → full-width browser so the whole page is used.
  if (selectedId == null) {
    return <FeatureBrowser sections={sections} error={error} onSelect={selectFeature} />;
  }

  // A feature is open → the three-level reading layout (unchanged).
  return (
    <div className="dnd">
      <FeatureListRail
        sections={sections}
        selectedId={selectedId}
        error={error}
        onSelect={selectFeature}
      />
      <FeatureFacetMenu facet={facet} demoStatus={demoStatus} onPick={setFacet} />
      <FacetReadingArea
        facet={facet}
        featureId={selectedId}
        displayName={selectedName}
        doc={doc}
        board={board}
        error={error}
        onReloadDoc={loadDoc}
      />
    </div>
  );
}

/** Feature meta chips — shared by the browser cards and the reading-view rail rows. */
function FeatureMeta(props: { feature: ApiFeatureListEntry }): JSX.Element {
  const { feature: f } = props;
  return (
    <span className="dnd-row-meta">
      {f.boardState && <span className={`dnd-chip is-${f.boardState.toLowerCase()}`}>{f.boardState}</span>}
      {f.readyToClose && <span className="dnd-ready">ready to close</span>}
      {f.dayLabel && <span className="dnd-day">{f.dayLabel}</span>}
    </span>
  );
}

/** Compact rail row — used inside the three-level reading view. */
function FeatureRow(props: {
  feature: ApiFeatureListEntry;
  selected: boolean;
  onSelect: (id: number) => void;
}): JSX.Element {
  const { feature: f, selected, onSelect } = props;
  return (
    <button className={`dnd-row${selected ? ' is-sel' : ''}`} onClick={() => onSelect(f.id)}>
      <span className="dnd-row-name">{renderDisplayName(f.displayName)}</span>
      <FeatureMeta feature={f} />
    </button>
  );
}

/* ------------------- Landing — full-width feature browser ----------------- */

/** A roomy card for the landing grid, with a status-colored spine. */
function FeatureCard(props: {
  feature: ApiFeatureListEntry;
  onSelect: (id: number) => void;
}): JSX.Element {
  const { feature: f, onSelect } = props;
  return (
    <button className={`dnd-card is-${f.dndStatus}`} onClick={() => onSelect(f.id)}>
      <span className="dnd-card-name">{renderDisplayName(f.displayName)}</span>
      <FeatureMeta feature={f} />
      <span className="dnd-card-go" aria-hidden="true">Read discovery →</span>
    </button>
  );
}

/** Plain-word noun for the running summary line, e.g. "3 in progress". */
const STATUS_NOUN: Record<DndStatus, string> = {
  'in-progress': 'in progress',
  'not-started': 'not started',
  'closed': 'done',
};

function FeatureBrowser(props: {
  sections: ApiFeatureSection[] | null;
  error: string | null;
  onSelect: (id: number) => void;
}): JSX.Element {
  const { sections, error, onSelect } = props;
  const groups = sections?.filter(sec => sec.features.length > 0) ?? [];
  const total = groups.reduce((n, s) => n + s.features.length, 0);
  const summary = groups.map(s => `${s.features.length} ${STATUS_NOUN[s.status]}`).join(' · ');

  return (
    <main className="dnd-browse">
      <header className="dnd-browse-head">
        <div className="dnd-browse-cap">Discovery &amp; Design</div>
        <h1 className="dnd-browse-h">Your features</h1>
        {total > 0
          ? <p className="dnd-browse-sub"><b>{summary}</b> — pick one to read its discovery, design, and demo.</p>
          : <p className="dnd-browse-sub">Discovery, design, and demo — one place per feature.</p>}
      </header>

      {error && <div className="dnd-error">Couldn't load discoveries: {error}</div>}
      {sections && total === 0 && !error && (
        <div className="dnd-empty">
          Discoveries show up here once you start one. Run <code>/sprint-helper:discovery</code> in a workspace to begin.
        </div>
      )}

      {groups.map(sec => (
        <section key={sec.status} className={`dnd-browse-grp is-${sec.status}`}>
          <div className="dnd-browse-grp-head">
            <span className="dnd-browse-grp-dot" />
            <span className="dnd-browse-grp-label">{STATUS_LABEL[sec.status]}</span>
            <span className="dnd-browse-grp-count">{sec.features.length}</span>
          </div>
          <div className="dnd-browse-grid">
            {sec.features.map(f => (
              <FeatureCard key={f.id} feature={f} onSelect={onSelect} />
            ))}
          </div>
        </section>
      ))}
    </main>
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
            <FeatureRow key={f.id} feature={f} selected={f.id === selectedId} onSelect={onSelect} />
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
  facet: Facet;
  featureId: number;
  displayName: string;
  doc: DiscoveryDocPayload | null;
  board: DiscoveryBoardPayload | null;
  error: string | null;
  onReloadDoc: () => void;
}): JSX.Element {
  const { facet, featureId, displayName, doc, board, error, onReloadDoc } = props;

  if (error) {
    return <main className="dnd-read"><div className="dnd-error">Couldn't read this feature: {error}</div></main>;
  }
  // Only the disk-backed doc gates the reading area — it returns instantly.
  // The board (Overview) fills in separately and never blocks this.
  if (!doc) {
    return <main className="dnd-read"><div className="dnd-loading">Loading…</div></main>;
  }

  return (
    <main className="dnd-read">
      <h1 className="dnd-read-title">{renderDisplayName(displayName)}</h1>
      <div className="dnd-facet-label">{facetLabel(facet)}</div>
      {facet === 'overview' && <OverviewFacet board={board} />}
      {facet === 'discovery' && <DiscoveryFacet doc={doc.doc} />}
      {facet === 'design' && <DesignFacet />}
      {facet === 'demo' && <DemoFacet featureId={featureId} folderPath={doc.folderPath} doc={doc.doc} onSaved={onReloadDoc} />}
    </main>
  );
}

function facetLabel(f: Facet): string {
  return f === 'overview' ? 'Overview' : f === 'discovery' ? 'Discovery' : f === 'design' ? 'Design' : 'Demo';
}

function OverviewFacet(props: { board: DiscoveryBoardPayload | null }): JSX.Element {
  const { board } = props;
  // Board hasn't arrived yet — the ADO call is still in flight.
  if (!board) return <div className="dnd-loading">Reading the board…</div>;
  if (!board.reachable) {
    return <p className="dnd-muted">Couldn't reach the board — Overview needs Azure DevOps. Discovery still reads fine.</p>;
  }
  return (
    <div className="dnd-overview">
      {board.featureState && (
        <div className="dnd-overview-state">
          <span className={`dnd-chip is-${board.featureState.toLowerCase()}`}>{board.featureState}</span>
        </div>
      )}
      {board.featureDescription
        ? renderDescription(board.featureDescription)
        : <p className="dnd-muted">No description on the board.</p>}
      <h2 className="dnd-h2">Stories &amp; tasks under this feature</h2>
      {board.children.length === 0
        ? <p className="dnd-muted">Nothing linked under this feature yet.</p>
        : (
          <ul className="dnd-children">
            {board.children.map((c: ApiDiscoveryChild) => (
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

function DiscoveryFacet(props: { doc: DiscoveryDocPayload['doc'] }): JSX.Element {
  const { doc } = props;
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

function DemoFacet(props: {
  featureId: number;
  folderPath: string;
  doc: DiscoveryDocPayload['doc'];
  onSaved: () => void;
}): JSX.Element {
  const { featureId: id, folderPath, doc, onSaved } = props;
  const [status, setStatus] = useState<'none' | 'scheduled' | 'built'>(doc?.demo.status ?? 'none');
  const [date, setDate] = useState(doc?.demo.date ?? '');
  const [folderMsg, setFolderMsg] = useState<string | null>(null);

  useEffect(() => {
    setStatus(doc?.demo.status ?? 'none');
    setDate(doc?.demo.date ?? '');
  }, [doc]);

  if (!doc) return <div className="dnd-empty">Start a discovery before marking a demo.</div>;

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
        <button className="dnd-btn is-quiet" onClick={() => openDiscoveryFolder(id).then(r => { if (!r.ok) setFolderMsg(folderPath); })}>
          Open folder
        </button>
        {folderMsg && <code className="dnd-path">{folderMsg}</code>}
      </div>
    </div>
  );
}
