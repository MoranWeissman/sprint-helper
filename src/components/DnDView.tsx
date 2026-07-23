import { useCallback, useEffect, useState } from 'react';
import {
  fetchDiscoveryList, fetchDiscoveryDetail, markDiscoveryDemo, openDiscoveryFolder,
  type ApiFeatureSection, type DiscoveryDetailPayload, type DndStatus,
} from '../lib/api';

const STATUS_LABEL: Record<DndStatus, string> = {
  'in-progress': 'In progress',
  'not-started': 'Not started',
  'closed': 'Done',
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
      {error && <div className="dnd-error">Couldn't load discoveries: {error}</div>}
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
                  {f.readyToClose && <span className="dnd-ready">ready to close</span>}
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

  if (error) return <div className="dnd-detail">{back}<div className="dnd-error">Couldn't read this discovery: {error}</div></div>;
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
              <p>Tech lead's: {doc.lanes.techLead || '—'}</p>
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
