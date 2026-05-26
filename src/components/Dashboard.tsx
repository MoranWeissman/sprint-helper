import { useState } from 'react';
import { mockData } from '../lib/mockData';
import {
  dayOfSprint,
  fmtEstimate,
  fmtHM,
  formatClock,
  formatLongDate,
  pctOf,
  sprintDays,
  useNow,
  useTick,
} from '../lib/time';
import { Dot } from './Dot';
import { Mono } from './Mono';

export function Dashboard() {
  const data = mockData;
  const tick = useTick();
  const now = useNow();
  const date = formatLongDate(now);
  const clock = formatClock(now);
  const today = dayOfSprint(data.sprint, now);
  const railDays = sprintDays(data.sprint, now);

  const initialFocused = data.running.find(r => r.focused) ?? data.running[0];
  const [focusedId, setFocusedId] = useState(initialFocused.id);
  const focused = data.running.find(r => r.id === focusedId) ?? initialFocused;
  const others = data.running.filter(r => r.id !== focused.id);

  const focusedTotal = focused.elapsedSec + tick;
  const focusedH = Math.floor(focusedTotal / 3600);
  const focusedM = Math.floor((focusedTotal % 3600) / 60);
  const remainingSec = Math.max(0, focused.estimateMin * 60 - focusedTotal);
  const remainingH = Math.floor(remainingSec / 3600);
  const remainingM = Math.floor((remainingSec % 3600) / 60);
  const estimateH = Math.floor(focused.estimateMin / 60);
  const estimateM = focused.estimateMin % 60;

  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const copy = (key: string, text: string) => {
    navigator.clipboard?.writeText(text).catch(() => {});
    setCopiedKey(key);
    setTimeout(() => setCopiedKey(k => (k === key ? null : k)), 1200);
  };

  const standupText =
    `Yesterday: #4519 Login UI cleanup (2h). Worked on #4521 refactor too.\n` +
    `Today: finish #${focused.id} hotfix, keep going on #4521, look into #4548 slow query.\n` +
    `Blockers: none.`;
  const standupMd =
    `**Yesterday** — #4519 Login UI cleanup (2h)\n` +
    `**Today** — finish #${focused.id}, keep going on #4521, look into #4548\n` +
    `**Blockers** — none`;

  const sprintLeftHours = '17h';

  return (
    <div className="ember">
      <div className="ember-glow ember-glow-1" aria-hidden="true" />
      <div className="ember-glow ember-glow-2" aria-hidden="true" />
      <div className="ember-grain" aria-hidden="true" />

      {/* TOP BAR */}
      <header className="ember-top">
        <div className="ember-brand">
          <span className="ember-brand-mark" aria-hidden="true" />
          <span className="ember-brand-name">SPRINT&nbsp;HELPER</span>
          <span className="ember-brand-meta">
            <Mono>{data.user.toLowerCase()}</Mono>
          </span>
        </div>
        <div className="ember-top-right">
          <span className="ember-chip">
            <span className="dim-small">SPRINT</span>
            &nbsp;<Mono>{data.sprint.num}</Mono>
            <span className="ember-chip-sep" />
            <span className="dim-small">DAY</span>
            &nbsp;<Mono>{today}/{data.sprint.totalDays}</Mono>
          </span>
          <span className="ember-chip">
            <span className="dim-small">LOCAL</span>
            &nbsp;<Mono>{clock}</Mono>
          </span>
          <span className="ember-sync">
            <Dot size={5} color="var(--accent)" />
            <span className="dim-small">synced</span>
            &nbsp;<Mono>{data.syncedMinAgo} min ago</Mono>
          </span>
        </div>
      </header>

      <div className="ember-main">
        {/* SIDEBAR */}
        <aside className="ember-side">
          <p className="ember-date">{date}</p>
          <h1 className="ember-greeting">
            Good morning,
            <br />
            <span className="ember-greeting-name">{data.user}</span>
          </h1>
          <p className="ember-sub">
            Three tasks are still going from yesterday. Start with the hotfix — the others can wait.
          </p>

          <button className="ember-cta" onClick={() => setFocusedId(focused.id)}>
            <span className="ember-cta-line1">
              <span className="dim-small">RESUME</span>
            </span>
            <span className="ember-cta-line2">
              <Mono>#{focused.id}</Mono>&nbsp;&nbsp;hotfix
            </span>
            <span className="ember-cta-arrow" aria-hidden="true">→</span>
          </button>
          <p className="ember-cta-foot">
            <Mono>{fmtHM(focused.elapsedSec, tick)}</Mono> of <Mono>{fmtEstimate(focused.estimateMin)}</Mono>
            <span className="dim-soft"> · {others.length} other{others.length === 1 ? '' : 's'} also going</span>
          </p>

          {/* sprint rail */}
          <div className="ember-rail">
            <div className="ember-rail-head">
              <span className="dim-small">SPRINT&nbsp;{data.sprint.num}</span>
              <span className="dim-small">
                DAY&nbsp;<Mono style={{ color: 'var(--ink-1)' }}>{today}</Mono>/{data.sprint.totalDays}
              </span>
            </div>
            <div className="ember-rail-track">
              {railDays.map(d => (
                <div
                  key={d.index}
                  className={`ember-rail-day ${d.state === 'past' ? 'past' : ''} ${d.state === 'today' ? 'today' : ''}`}
                >
                  <span className="ember-rail-tick" />
                  <span className="ember-rail-label">
                    <Mono>{d.label}</Mono>
                  </span>
                </div>
              ))}
            </div>
            <div className="ember-rail-foot">
              <Mono className="ember-rail-big">{sprintLeftHours}</Mono>
              <span className="dim-small">remaining</span>
            </div>
          </div>
        </aside>

        {/* CONTENT */}
        <div className="ember-content">
          {/* GLANCE STATS */}
          <section className="ember-stats">
            {[
              { label: 'TODAY', value: '3h', sub: 'logged' },
              { label: 'SPRINT', value: sprintLeftHours, sub: 'left' },
              { label: 'DAYS', value: String(data.sprint.totalDays - today + 1), sub: 'remaining' },
              { label: 'RUNNING', value: String(data.running.length), sub: 'going now' },
              { label: 'NEXT', value: String(data.upNext.length), sub: 'waiting' },
              { label: 'BLOCKED', value: '0', sub: 'all clear' },
            ].map(s => (
              <div key={s.label} className={`ember-stat ${s.value === '0' ? 'muted' : ''}`}>
                <div className="ember-stat-label">{s.label}</div>
                <div className="ember-stat-value">
                  <Mono>{s.value}</Mono>
                </div>
                <div className="ember-stat-sub">{s.sub}</div>
              </div>
            ))}
          </section>

          {/* NOW + parallel runners */}
          <section className="ember-runblock">
            <div className="ember-runblock-head">
              <h3 className="ember-section-title">Now</h3>
              <span className="dim-small">
                <Mono style={{ color: 'var(--ink-1)' }}>1</Mono>&nbsp;MAIN ·{' '}
                <Mono style={{ color: 'var(--ink-1)' }}>{others.length}</Mono>&nbsp;IN THE BACKGROUND
              </span>
            </div>

            {/* focused running */}
            <article className="ember-running">
              <div className="ember-running-rail" aria-hidden="true" />
              <div className="ember-running-head">
                <span className="ember-running-flag">
                  <Dot size={5} color="var(--accent)" />
                  <span className="dim-small">MAIN TASK · RUNNING</span>
                </span>
                <Mono className="ember-running-id">#{focused.id}</Mono>
                <span className="ember-running-since dim-small">
                  started <Mono style={{ color: 'var(--ink-1)' }}>{focused.started}</Mono>
                </span>
              </div>
              <h2 className="ember-running-title">{focused.title}</h2>

              <div className="ember-running-numbers">
                <div className="ember-num-block">
                  <Mono className="ember-num-big">
                    {focusedH}<span>h</span>&nbsp;{String(focusedM).padStart(2, '0')}<span>m</span>
                  </Mono>
                  <span className="ember-num-cap">elapsed</span>
                </div>
                <div className="ember-num-divider" />
                <div className="ember-num-block">
                  <Mono className="ember-num-big dim">
                    {estimateH}<span>h</span>{estimateM ? ` ${String(estimateM).padStart(2, '0')}` : ' 00'}<span>m</span>
                  </Mono>
                  <span className="ember-num-cap">estimate</span>
                </div>
                <div className="ember-num-divider" />
                <div className="ember-num-block">
                  <Mono className="ember-num-big dim">
                    {remainingH}<span>h</span>&nbsp;{String(remainingM).padStart(2, '0')}<span>m</span>
                  </Mono>
                  <span className="ember-num-cap">remaining</span>
                </div>
              </div>

              <div className="ember-running-bar">
                <span style={{ width: `${pctOf(focused.elapsedSec, tick, focused.estimateMin)}%` }} />
              </div>

              <div className="ember-running-actions">
                <button className="ember-act">pause</button>
                <span className="ember-act-sep">·</span>
                <button className="ember-act">stop and mark done</button>
                <span className="ember-act-sep">·</span>
                <button className="ember-act ember-act-ghost">
                  open in Azure DevOps <span aria-hidden="true">↗</span>
                </button>
              </div>
            </article>

            {/* parallel list */}
            {others.length > 0 && (
              <div className="ember-parallel">
                <div className="ember-parallel-head">
                  <span className="ember-parallel-label">ALSO GOING IN THE BACKGROUND</span>
                  <span className="dim-small">tap focus to switch what you're working on</span>
                </div>
                <ul className="ember-parallel-list">
                  {others.map(r => {
                    const total = r.elapsedSec + tick;
                    const h = Math.floor(total / 3600);
                    const m = Math.floor((total % 3600) / 60);
                    return (
                      <li key={r.id} className="ember-par-row">
                        <Mono className="ember-par-id">#{r.id}</Mono>
                        <div className="ember-par-body">
                          <div className="ember-par-title">{r.title}</div>
                          <div className="ember-par-story dim-small">
                            {r.story} · since <Mono style={{ color: 'var(--ink-2)' }}>{r.started}</Mono>
                          </div>
                        </div>
                        <div className="ember-par-meter">
                          <div className="ember-par-bar">
                            <span style={{ width: `${pctOf(r.elapsedSec, tick, r.estimateMin)}%` }} />
                          </div>
                          <div className="ember-par-times">
                            <Mono className="ember-par-elapsed">
                              {h}h&nbsp;{String(m).padStart(2, '0')}m
                            </Mono>
                            <span className="dim">
                              &nbsp;/&nbsp;
                              <Mono style={{ color: 'var(--ink-2)' }}>{fmtEstimate(r.estimateMin)}</Mono>
                            </span>
                          </div>
                        </div>
                        <div className="ember-par-actions">
                          <button
                            className="ember-par-act ember-par-act-focus"
                            onClick={() => setFocusedId(r.id)}
                          >
                            focus
                          </button>
                          <button className="ember-par-act">pause</button>
                          <button
                            className="ember-par-act ember-par-act-ghost"
                            aria-label="open in Azure DevOps"
                          >
                            ↗
                          </button>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              </div>
            )}
          </section>

          {/* STANDUP + LISTS */}
          <div className="ember-grid">
            <section className="ember-standup">
              <div className="ember-section-head">
                <h3 className="ember-section-title">Standup draft</h3>
                <span className="dim-small">ready 09:45</span>
              </div>
              <dl className="ember-standup-list">
                <div>
                  <dt>Yesterday</dt>
                  <dd>
                    Shipped <Mono>#4519</Mono> Login UI cleanup (<Mono>2h</Mono>). Worked on{' '}
                    <Mono>#4521</Mono> refactor too.
                  </dd>
                </div>
                <div>
                  <dt>Today</dt>
                  <dd>
                    Finish <Mono>#{focused.id}</Mono> hotfix (
                    <Mono>{fmtHM(focused.elapsedSec, tick)}</Mono>/
                    <Mono>{fmtEstimate(focused.estimateMin)}</Mono>), keep going on{' '}
                    <Mono>#4521</Mono>, look into <Mono>#4548</Mono>.
                  </dd>
                </div>
                <div>
                  <dt>Blockers</dt>
                  <dd className="dim">None.</dd>
                </div>
              </dl>
              <div className="ember-standup-foot">
                <button className="ember-link" onClick={() => copy('b-text', standupText)}>
                  {copiedKey === 'b-text' ? 'copied' : 'copy as text'}
                </button>
                <button className="ember-link" onClick={() => copy('b-md', standupMd)}>
                  {copiedKey === 'b-md' ? 'copied' : 'copy as markdown'}
                </button>
              </div>
            </section>

            <section className="ember-tasks">
              <div className="ember-section-head">
                <h3 className="ember-section-title">Today</h3>
                <span className="dim-small">
                  {data.running.length + data.doneToday.length} items
                </span>
              </div>
              <ul className="ember-items">
                {data.running.map(r => (
                  <li
                    key={r.id}
                    className={`ember-item running ${r.id === focused.id ? 'is-focused' : ''}`}
                  >
                    <Mono className="ember-item-id">#{r.id}</Mono>
                    <span className="ember-item-title">{r.title}</span>
                    <span className="ember-item-state">
                      {r.id === focused.id ? 'main' : 'going'}
                    </span>
                    <Mono className="ember-item-effort">
                      {fmtHM(r.elapsedSec, tick)} / {fmtEstimate(r.estimateMin)}
                    </Mono>
                  </li>
                ))}
                {data.doneToday.map(d => (
                  <li key={d.id} className="ember-item done">
                    <Mono className="ember-item-id">#{d.id}</Mono>
                    <span className="ember-item-title">{d.title}</span>
                    <span className="ember-item-state">done</span>
                    <Mono className="ember-item-effort">{d.effort}</Mono>
                  </li>
                ))}
              </ul>

              <div className="ember-section-head ember-section-head-tight">
                <h3 className="ember-section-title">Up next</h3>
                <span className="dim-small">{data.upNext.length} items · 5h</span>
              </div>
              <ul className="ember-items">
                {data.upNext.map(it => (
                  <li key={it.id} className="ember-item queued">
                    <Mono className="ember-item-id">#{it.id}</Mono>
                    <span className="ember-item-title">{it.title}</span>
                    <span className="ember-item-state dim">waiting</span>
                    <Mono className="ember-item-effort">{it.estimate}</Mono>
                  </li>
                ))}
              </ul>
            </section>
          </div>

          {/* SYNC BANNER */}
          <section className="ember-sync-banner">
            <div className="ember-sync-left">
              <Mono className="ember-sync-n">{data.pendingChanges}</Mono>
              <div className="ember-sync-text">
                <span className="ember-sync-headline">changes to send to Azure DevOps</span>
                <span className="ember-sync-detail">
                  time logged on <Mono>#4530</Mono> and <Mono>#4519</Mono>
                </span>
              </div>
            </div>
            <button className="ember-report">
              <span>Send to Azure DevOps</span>
              <span aria-hidden="true" className="ember-cta-arrow">→</span>
            </button>
          </section>
        </div>
      </div>
    </div>
  );
}
