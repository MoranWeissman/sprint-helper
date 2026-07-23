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
    // Clear the old feature's data first so the reading area shows "Loading…"
    // instead of feature A's title/content under feature B while B loads.
    setDetail(null);
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
