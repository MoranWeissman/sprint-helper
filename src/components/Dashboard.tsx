import { useEffect, useMemo, useState } from 'react';
import {
  nameFromEmail,
  useDashboardData,
  type ApiPayload,
  type ApiUserStoryGroup,
  type ApiWorkItem,
} from '../lib/api';
import {
  dayOfSprint,
  fmtEstimate,
  formatClock,
  formatLongDate,
  greetingForHour,
  sprintDays,
  useNow,
} from '../lib/time';
import type { SprintContext } from '../lib/types';
import { Dot } from './Dot';
import { Mono } from './Mono';
import { WorkItemDrawer } from './WorkItemDrawer';

export function Dashboard() {
  const [selectedSprintName, setSelectedSprintName] = useState<string | undefined>(undefined);
  const { state, refresh } = useDashboardData(selectedSprintName);
  const now = useNow();

  if (state.status === 'loading') {
    return <LoadingShell now={now} />;
  }
  if (state.status === 'error') {
    return <ErrorShell now={now} error={state.error} command={state.command} onRetry={refresh} />;
  }
  return (
    <DashboardLive
      data={state.data}
      now={now}
      onRefresh={refresh}
      selectedSprintName={selectedSprintName ?? state.data.sprint?.name}
      onSprintChange={setSelectedSprintName}
    />
  );
}

/* -------------------------------------------------------------------------- */
/*  Live state                                                                */
/* -------------------------------------------------------------------------- */

function DashboardLive({
  data,
  now,
  onRefresh,
  selectedSprintName,
  onSprintChange,
}: {
  data: ApiPayload;
  now: Date;
  onRefresh: () => void;
  selectedSprintName?: string;
  onSprintChange: (name: string | undefined) => void;
}) {
  const sprintCtx: SprintContext | null = useMemo(() => {
    if (!data.sprint) return null;
    return {
      num: data.sprint.name as unknown as number,
      startDate: new Date(data.sprint.startDate),
      totalDays: data.sprint.totalDays,
    };
  }, [data.sprint]);

  const userName = nameFromEmail(data.user);
  const date = formatLongDate(now);
  const clock = formatClock(now);
  const today = sprintCtx ? dayOfSprint(sprintCtx, now) : 0;
  const daysRemaining = sprintCtx ? Math.max(0, sprintCtx.totalDays - today + 1) : 0;
  const railDays = sprintCtx ? sprintDays(sprintCtx, now) : [];

  const stories = data.userStories;
  const inProgress = data.workItems.inProgress;
  const upNext = data.workItems.upNext;
  const done = data.workItems.done;

  // Active story: defaults to first (already sorted: in-progress first).
  const [activeStoryId, setActiveStoryId] = useState<string | undefined>(stories[0]?.id);
  // Work item drawer state — null means closed.
  const [viewingItemId, setViewingItemId] = useState<string | null>(null);
  const openItem = (id: string) => setViewingItemId(id);
  const closeItem = () => setViewingItemId(null);

  // Re-sync active story when the data changes (e.g., sprint switch).
  useEffect(() => {
    if (!activeStoryId || !stories.some(s => s.id === activeStoryId)) {
      setActiveStoryId(stories[0]?.id);
    }
  }, [stories, activeStoryId]);

  const activeStory = useMemo(
    () => stories.find(s => s.id === activeStoryId) ?? stories[0],
    [stories, activeStoryId],
  );

  const sprintLeftHours = `${Math.round(data.capacity.remainingHours)}h`;
  const completedHours = `${Math.round(data.capacity.completedHours)}h`;
  const totalEstimateHours = `${Math.round(data.capacity.totalEstimateHours)}h`;

  const sprintLabel = data.sprint?.name ?? '—';

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
            <Mono>{userName.toLowerCase()}</Mono>
          </span>
        </div>
        <div className="ember-top-right">
          <SprintPicker
            options={data.sprintOptions}
            currentName={selectedSprintName ?? sprintLabel}
            onSelect={name => {
              const sprint = data.sprintOptions.find(o => o.isCurrent);
              // Pass undefined to clear the override (return to "current") instead
              // of sticking on a stale name when the user re-clicks the current chip.
              onSprintChange(sprint && sprint.name === name ? undefined : name);
            }}
          />
          <span className="ember-chip">
            <span className="dim-small">DAY</span>
            &nbsp;<Mono>
              {today}/{sprintCtx?.totalDays ?? '—'}
            </Mono>
            <span className="ember-chip-sep" />
            <span className="dim-small">LOCAL</span>
            &nbsp;<Mono>{clock}</Mono>
          </span>
          <button className="ember-sync" onClick={onRefresh} title="Refresh from Azure DevOps">
            <Dot size={5} color="var(--accent)" />
            <span className="dim-small">live</span>
            &nbsp;<span className="ember-sync-icon">↻</span>
          </button>
        </div>
      </header>

      <div className="ember-main">
        {/* SIDEBAR */}
        <aside className="ember-side">
          <p className="ember-date">{date}</p>
          <h1 className="ember-greeting">
            {greetingForHour(now)},
            <br />
            <span className="ember-greeting-name">{userName}</span>
          </h1>
          <p className="ember-sub">
            {greetingCopy(inProgress.length, daysRemaining)}
          </p>

          {activeStory ? (
            <>
              <button
                className="ember-cta"
                onClick={() => openItem(activeStory.id)}
                style={{ textDecoration: 'none' }}
              >
                <span className="ember-cta-line1">
                  <span className="dim-small">FOCUS</span>
                </span>
                <span className="ember-cta-line2">
                  <Mono>#{activeStory.id}</Mono>&nbsp;&nbsp;{truncate(activeStory.title, 32)}
                </span>
                <span className="ember-cta-arrow" aria-hidden="true">→</span>
              </button>
              <p className="ember-cta-foot">
                <Mono>{activeStory.tasks.length}</Mono> task{activeStory.tasks.length === 1 ? '' : 's'} · <Mono>{Math.round(activeStory.remainingHours)}h</Mono> remaining
                {stories.length > 1 && (
                  <span className="dim-soft"> · {stories.length - 1} other stor{stories.length - 1 === 1 ? 'y' : 'ies'} in this sprint</span>
                )}
              </p>
            </>
          ) : (
            <p className="ember-cta-foot" style={{ marginTop: 18 }}>
              No active stories in this sprint. Pick one in Azure DevOps and assign yourself a task.
            </p>
          )}

          {/* sprint rail */}
          {sprintCtx && (
            <div className="ember-rail">
              <div className="ember-rail-head">
                <span className="dim-small">SPRINT&nbsp;<Mono style={{ color: 'var(--ink-1)' }}>{sprintLabel}</Mono></span>
                <span className="dim-small">
                  DAY&nbsp;<Mono style={{ color: 'var(--ink-1)' }}>{today}</Mono>/{sprintCtx.totalDays}
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
          )}
        </aside>

        {/* CONTENT */}
        <div className="ember-content">
          {/* GLANCE STATS */}
          <section className="ember-stats">
            {[
              { label: 'LOGGED', value: completedHours, sub: 'this sprint' },
              { label: 'REMAINING', value: sprintLeftHours, sub: 'left to do' },
              { label: 'ESTIMATE', value: totalEstimateHours, sub: 'total scope' },
              { label: 'DAYS', value: String(daysRemaining), sub: 'remaining' },
              { label: 'GOING', value: String(inProgress.length), sub: 'in progress' },
              { label: 'NEXT', value: String(upNext.length), sub: 'waiting' },
            ].map(s => (
              <div key={s.label} className={`ember-stat ${s.value === '0' || s.value === '0h' ? 'muted' : ''}`}>
                <div className="ember-stat-label">{s.label}</div>
                <div className="ember-stat-value">
                  <Mono>{s.value}</Mono>
                </div>
                <div className="ember-stat-sub">{s.sub}</div>
              </div>
            ))}
          </section>

          {/* MY USER STORIES — pick one to focus on */}
          {stories.length > 0 && (
            <section className="ember-stories">
              <div className="ember-stories-head">
                <h3 className="ember-section-title">My user stories</h3>
                <span className="dim-small">
                  <Mono style={{ color: 'var(--ink-1)' }}>{stories.length}</Mono>&nbsp;in this sprint · click one to focus
                </span>
              </div>
              <div className="ember-stories-grid">
                {stories.map(s => (
                  <button
                    key={s.id}
                    className={`ember-story-chip ${activeStory?.id === s.id ? 'active' : ''}`}
                    onClick={() => setActiveStoryId(s.id)}
                    aria-pressed={activeStory?.id === s.id}
                  >
                    <div className="ember-story-chip-head">
                      <span className="ember-story-chip-type">{s.type}</span>
                      <span className="ember-story-chip-id">#{s.id}</span>
                    </div>
                    <span className="ember-story-chip-title">{s.title}</span>
                    <div className="ember-story-chip-meta">
                      {s.counts.inProgress > 0 && (
                        <span className="ember-story-chip-pill going">
                          <Mono>{s.counts.inProgress}</Mono> going
                        </span>
                      )}
                      {s.counts.upNext > 0 && (
                        <span className="ember-story-chip-pill">
                          <Mono>{s.counts.upNext}</Mono> waiting
                        </span>
                      )}
                      {s.counts.done > 0 && (
                        <span className="ember-story-chip-pill">
                          <Mono>{s.counts.done}</Mono> done
                        </span>
                      )}
                      <span style={{ marginLeft: 'auto' }}>
                        <Mono>{Math.round(s.remainingHours)}h</Mono> left
                      </span>
                    </div>
                  </button>
                ))}
              </div>
            </section>
          )}

          {/* ACTIVE STORY focus */}
          {activeStory && <ActiveStoryCard story={activeStory} onOpenItem={openItem} />}

          {/* STANDUP + LISTS */}
          <div className="ember-grid">
            <StandupCard data={data} userName={userName} />
            <section className="ember-tasks">
              <div className="ember-section-head">
                <h3 className="ember-section-title">In this sprint</h3>
                <span className="dim-small">
                  {inProgress.length + done.length} active · {upNext.length} waiting
                </span>
              </div>
              <ul className="ember-items">
                {inProgress.map(w => (
                  <li
                    key={w.id}
                    className={`ember-item running ember-clickable ${activeStory?.tasks.some(t => t.id === w.id) ? 'is-focused' : ''}`}
                    onClick={() => openItem(w.id)}
                    role="button"
                    tabIndex={0}
                  >
                    <Mono className="ember-item-id">#{w.id}</Mono>
                    <span className="ember-item-title">{w.title}</span>
                    <span className="ember-item-state">
                      {activeStory?.tasks.some(t => t.id === w.id) ? 'in focus' : 'going'}
                    </span>
                    <Mono className="ember-item-effort">
                      {loggedFor(w)} / {estimateFor(w)}
                    </Mono>
                  </li>
                ))}
                {done.map(w => (
                  <li
                    key={w.id}
                    className="ember-item done ember-clickable"
                    onClick={() => openItem(w.id)}
                    role="button"
                    tabIndex={0}
                  >
                    <Mono className="ember-item-id">#{w.id}</Mono>
                    <span className="ember-item-title">{w.title}</span>
                    <span className="ember-item-state">done</span>
                    <Mono className="ember-item-effort">{loggedFor(w)}</Mono>
                  </li>
                ))}
              </ul>

              {upNext.length > 0 && (
                <>
                  <div className="ember-section-head ember-section-head-tight">
                    <h3 className="ember-section-title">Up next</h3>
                    <span className="dim-small">{upNext.length} items · {totalEstimateUpNext(upNext)}</span>
                  </div>
                  <ul className="ember-items">
                    {upNext.map(w => (
                      <li
                        key={w.id}
                        className="ember-item queued ember-clickable"
                        onClick={() => openItem(w.id)}
                        role="button"
                        tabIndex={0}
                      >
                        <Mono className="ember-item-id">#{w.id}</Mono>
                        <span className="ember-item-title">{w.title}</span>
                        <span className="ember-item-state dim">waiting</span>
                        <Mono className="ember-item-effort">{estimateFor(w)}</Mono>
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </section>
          </div>

          {/* SYNC BANNER — placeholder until slice 2 wires real pending changes */}
          <section className="ember-sync-banner">
            <div className="ember-sync-left">
              <Mono className="ember-sync-n">0</Mono>
              <div className="ember-sync-text">
                <span className="ember-sync-headline">no pending changes</span>
                <span className="ember-sync-detail">
                  read-only mode · time logging and edits arrive in the next slice
                </span>
              </div>
            </div>
            <a
              className="ember-report"
              href={data.sprint ? `https://dev.azure.com/AHITL/_workitems` : '#'}
              target="_blank"
              rel="noreferrer"
              style={{ textDecoration: 'none' }}
            >
              <span>Open Azure DevOps</span>
              <span aria-hidden="true" className="ember-cta-arrow">↗</span>
            </a>
          </section>
        </div>
      </div>

      <WorkItemDrawer
        itemId={viewingItemId}
        onClose={closeItem}
        onNavigate={openItem}
      />
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  Sub-components                                                            */
/* -------------------------------------------------------------------------- */

function SprintPicker({
  options,
  currentName,
  onSelect,
}: {
  options: import('../lib/api').ApiSprintOption[];
  currentName: string;
  onSelect: (name: string) => void;
}) {
  const sorted = [...options].sort((a, b) => a.startDate.localeCompare(b.startDate));
  const idx = sorted.findIndex(o => o.name === currentName);
  const hasPrev = idx > 0;
  const hasNext = idx >= 0 && idx < sorted.length - 1;
  return (
    <div className="ember-sprint-pick" role="group" aria-label="Sprint navigation">
      <button
        disabled={!hasPrev}
        aria-disabled={!hasPrev}
        title={hasPrev ? `Previous sprint: ${sorted[idx - 1]?.name}` : 'No previous sprint'}
        onClick={() => hasPrev && onSelect(sorted[idx - 1]!.name)}
      >
        ←
      </button>
      <span className="ember-sprint-current" aria-current="true">
        {currentName}
      </span>
      <button
        disabled={!hasNext}
        aria-disabled={!hasNext}
        title={hasNext ? `Next sprint: ${sorted[idx + 1]?.name}` : 'No next sprint'}
        onClick={() => hasNext && onSelect(sorted[idx + 1]!.name)}
      >
        →
      </button>
    </div>
  );
}

function ActiveStoryCard({
  story,
  onOpenItem,
}: {
  story: ApiUserStoryGroup;
  onOpenItem: (id: string) => void;
}) {
  return (
    <section className="ember-active-story">
      <div className="ember-active-story-head">
        <span className="ember-active-story-tag">
          <Dot size={5} color="var(--story)" />
          {story.type} · {story.state || 'In focus'}
        </span>
        <button
          className="ember-active-story-id ember-clickable"
          onClick={() => onOpenItem(story.id)}
          style={{ background: 'transparent', border: 'none', font: 'inherit', padding: 0 }}
          title="View story details"
        >
          #{story.id} →
        </button>
      </div>

      <h2
        className="ember-active-story-title ember-clickable"
        onClick={() => onOpenItem(story.id)}
        title="View story details"
      >
        {story.title}
      </h2>

      <div className="ember-active-story-numbers">
        <NumberBlock label="logged" value={story.completedHours} accent />
        <Divider />
        <NumberBlock label="estimate" value={story.totalEstimateHours} dim />
        <Divider />
        <NumberBlock label="remaining" value={story.remainingHours} dim />
      </div>

      <div className="ember-active-story-tasks">
        <div className="ember-active-story-tasks-head">
          <span className="dim-small">
            <Mono style={{ color: 'var(--ink-1)' }}>{story.tasks.length}</Mono>&nbsp;TASK{story.tasks.length === 1 ? '' : 'S'} ASSIGNED TO YOU
          </span>
          <span className="dim-small">
            {story.counts.inProgress > 0 && <><Mono style={{ color: 'var(--accent)' }}>{story.counts.inProgress}</Mono>&nbsp;going</>}
            {story.counts.upNext > 0 && <>&nbsp;·&nbsp;<Mono style={{ color: 'var(--ink-1)' }}>{story.counts.upNext}</Mono>&nbsp;waiting</>}
            {story.counts.done > 0 && <>&nbsp;·&nbsp;<Mono style={{ color: 'var(--ink-3)' }}>{story.counts.done}</Mono>&nbsp;done</>}
          </span>
        </div>
        {story.tasks.map(task => (
          <button
            key={task.id}
            onClick={() => onOpenItem(task.id)}
            className={`ember-active-story-task ${stateClass(task.state)}`}
            style={{ textDecoration: 'none', textAlign: 'inherit', font: 'inherit', cursor: 'pointer' }}
            title="View task details"
          >
            <Mono className="ember-task-id">#{task.id}</Mono>
            <span className="ember-task-title">{task.title}</span>
            <span className="ember-task-meta">
              <Mono>{loggedFor(task)}</Mono>&nbsp;<span className="dim">/</span>&nbsp;<Mono style={{ color: 'var(--ink-2)' }}>{estimateFor(task)}</Mono>
            </span>
            <span className="ember-task-state">{taskStateLabel(task.state)}</span>
          </button>
        ))}
      </div>

      <div className="ember-active-story-actions">
        <button
          className="ember-act"
          aria-disabled="true"
          title="Start timer on the first running task — slice 2"
          onClick={e => e.preventDefault()}
        >
          start timer
          <span className="ember-act-soon">soon</span>
        </button>
        <span className="ember-act-sep">·</span>
        <button
          className="ember-act"
          aria-disabled="true"
          title="Pause active timer — slice 2"
          onClick={e => e.preventDefault()}
        >
          pause
        </button>
        <a className="ember-act ember-act-ghost" href={story.url} target="_blank" rel="noreferrer">
          open story in Azure DevOps <span aria-hidden="true">↗</span>
        </a>
      </div>
    </section>
  );
}

function stateClass(state: string): string {
  if (DONE_STATES_FRONT.has(state)) return 'done';
  if (ACTIVE_STATES_FRONT.has(state)) return 'running';
  return 'queued';
}

function taskStateLabel(state: string): string {
  if (DONE_STATES_FRONT.has(state)) return 'done';
  if (ACTIVE_STATES_FRONT.has(state)) return 'going';
  return 'waiting';
}

const DONE_STATES_FRONT = new Set(['Done', 'Closed', 'Resolved', 'Completed', 'Removed']);
const ACTIVE_STATES_FRONT = new Set(['Active', 'In Progress', 'Committed', 'Doing']);

function NumberBlock({ label, value, accent, dim }: { label: string; value: number; accent?: boolean; dim?: boolean }) {
  const h = Math.floor(value);
  const m = Math.round((value - h) * 60);
  return (
    <div className="ember-num-block">
      <Mono className={`ember-num-big${dim ? ' dim' : ''}`}>
        {h}
        <span>h</span>
        {m > 0 && (
          <>
            &nbsp;{String(m).padStart(2, '0')}<span>m</span>
          </>
        )}
      </Mono>
      <span className="ember-num-cap" style={accent ? { color: 'var(--accent)' } : undefined}>
        {label}
      </span>
    </div>
  );
}

function Divider() {
  return <div className="ember-num-divider" />;
}

function StandupCard({ data, userName }: { data: ApiPayload; userName: string }) {
  const yesterdayItems = data.workItems.done;
  const goingItems = data.workItems.inProgress;
  const standupText = useMemo(
    () => buildStandupText(yesterdayItems, goingItems, userName),
    [yesterdayItems, goingItems, userName],
  );
  const standupMd = useMemo(
    () => buildStandupMd(yesterdayItems, goingItems),
    [yesterdayItems, goingItems],
  );
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const copy = (key: string, text: string) => {
    navigator.clipboard?.writeText(text).catch(() => {});
    setCopiedKey(key);
    setTimeout(() => setCopiedKey(k => (k === key ? null : k)), 1200);
  };

  return (
    <section className="ember-standup">
      <div className="ember-section-head">
        <h3 className="ember-section-title">Standup draft</h3>
        <span className="dim-small">auto-drafted from ADO</span>
      </div>
      <dl className="ember-standup-list">
        <div>
          <dt>Yesterday</dt>
          <dd>
            {yesterdayItems.length === 0 ? (
              <span className="dim">Nothing closed yesterday. Today's a fresh start.</span>
            ) : (
              yesterdayItems.slice(0, 3).map((w, i) => (
                <span key={w.id}>
                  {i > 0 ? ' · ' : ''}Closed <Mono>#{w.id}</Mono> {truncate(w.title, 40)}
                </span>
              ))
            )}
          </dd>
        </div>
        <div>
          <dt>Today</dt>
          <dd>
            {goingItems.length === 0 ? (
              <span className="dim">No tasks in progress.</span>
            ) : (
              goingItems.slice(0, 4).map((w, i) => (
                <span key={w.id}>
                  {i > 0 ? ' · ' : ''}<Mono>#{w.id}</Mono> {truncate(w.title, 32)}
                </span>
              ))
            )}
          </dd>
        </div>
        <div>
          <dt>Blockers</dt>
          <dd className="dim">None reported.</dd>
        </div>
      </dl>
      <div className="ember-standup-foot">
        <button className="ember-link" onClick={() => copy('text', standupText)}>
          {copiedKey === 'text' ? 'copied' : 'copy as text'}
        </button>
        <button className="ember-link" onClick={() => copy('md', standupMd)}>
          {copiedKey === 'md' ? 'copied' : 'copy as markdown'}
        </button>
      </div>
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/*  Loading + error shells                                                    */
/* -------------------------------------------------------------------------- */

function LoadingShell({ now }: { now: Date }) {
  return (
    <div className="ember">
      <div className="ember-glow ember-glow-1" aria-hidden="true" />
      <div className="ember-glow ember-glow-2" aria-hidden="true" />
      <div className="ember-grain" aria-hidden="true" />
      <header className="ember-top">
        <div className="ember-brand">
          <span className="ember-brand-mark" aria-hidden="true" />
          <span className="ember-brand-name">SPRINT&nbsp;HELPER</span>
        </div>
        <div className="ember-top-right">
          <span className="ember-chip"><Mono>{formatClock(now)}</Mono></span>
        </div>
      </header>
      <div className="ember-main">
        <aside className="ember-side">
          <p className="ember-date">{formatLongDate(now)}</p>
          <h1 className="ember-greeting" style={{ color: 'var(--ink-3)' }}>
            {greetingForHour(now)}.
            <br />Loading…
          </h1>
          <p className="ember-sub">Pulling your current iteration from Azure DevOps.</p>
        </aside>
        <div className="ember-content">
          <div className="ember-stats" style={{ opacity: 0.4 }}>
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="ember-stat">
                <div className="ember-stat-label">—</div>
                <div className="ember-stat-value"><Mono>…</Mono></div>
                <div className="ember-stat-sub">loading</div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function ErrorShell({
  now,
  error,
  command,
  onRetry,
}: {
  now: Date;
  error: string;
  command?: string;
  onRetry: () => void;
}) {
  return (
    <div className="ember">
      <div className="ember-glow ember-glow-1" aria-hidden="true" />
      <div className="ember-glow ember-glow-2" aria-hidden="true" />
      <div className="ember-grain" aria-hidden="true" />
      <header className="ember-top">
        <div className="ember-brand">
          <span className="ember-brand-mark" aria-hidden="true" />
          <span className="ember-brand-name">SPRINT&nbsp;HELPER</span>
        </div>
        <div className="ember-top-right">
          <span className="ember-chip"><Mono>{formatClock(now)}</Mono></span>
        </div>
      </header>
      <div className="ember-main">
        <aside className="ember-side">
          <p className="ember-date">{formatLongDate(now)}</p>
          <h1 className="ember-greeting">Can't reach Azure DevOps.</h1>
          <p className="ember-sub">{error}</p>
          {command && (
            <p className="ember-cta-foot">
              <span className="dim-small">FAILED COMMAND</span>
              <br />
              <Mono style={{ color: 'var(--ink-2)' }}>{command}</Mono>
            </p>
          )}
          <button className="ember-cta" onClick={onRetry}>
            <span className="ember-cta-line1"><span className="dim-small">RETRY</span></span>
            <span className="ember-cta-line2">Try again</span>
            <span className="ember-cta-arrow" aria-hidden="true">↻</span>
          </button>
        </aside>
        <div className="ember-content">
          <p className="dim">
            If you haven't logged into Azure CLI lately, run <Mono>az login</Mono> in your terminal,
            then click <em>Retry</em>.
          </p>
        </div>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  Helpers                                                                   */
/* -------------------------------------------------------------------------- */

function loggedFor(w: ApiWorkItem): string {
  const h = w.completedWork ?? 0;
  return h === 0 ? '0h' : fmtEstimate(Math.round(h * 60));
}

function estimateFor(w: ApiWorkItem): string {
  const h = w.originalEstimate ?? w.remainingWork ?? 0;
  return h === 0 ? '—' : fmtEstimate(Math.round(h * 60));
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1).trimEnd() + '…';
}

function totalEstimateUpNext(items: ApiWorkItem[]): string {
  const hours = items.reduce((sum, w) => sum + (w.originalEstimate ?? 0), 0);
  return `${Math.round(hours)}h`;
}

function greetingCopy(inProgressCount: number, daysRemaining: number): string {
  if (inProgressCount === 0 && daysRemaining > 0) {
    return `You've got ${daysRemaining} day${daysRemaining === 1 ? '' : 's'} left in this sprint and nothing in progress. Pick something from up next when you're ready.`;
  }
  if (inProgressCount === 1) {
    return `One task in progress. ${daysRemaining} day${daysRemaining === 1 ? '' : 's'} left in the sprint.`;
  }
  return `${inProgressCount} tasks in progress. ${daysRemaining} day${daysRemaining === 1 ? '' : 's'} left in the sprint — start with whichever is most urgent.`;
}

function buildStandupText(done: ApiWorkItem[], going: ApiWorkItem[], _userName: string): string {
  const y =
    done.length === 0
      ? 'Nothing closed yesterday.'
      : `Closed: ${done.map(w => `#${w.id} ${w.title}`).join(', ')}.`;
  const t =
    going.length === 0
      ? 'No tasks in progress today.'
      : `In progress: ${going.map(w => `#${w.id} ${w.title}`).join(', ')}.`;
  return `Yesterday: ${y}\nToday: ${t}\nBlockers: none.`;
}

function buildStandupMd(done: ApiWorkItem[], going: ApiWorkItem[]): string {
  const y = done.length === 0 ? '_None._' : done.map(w => `- #${w.id} ${w.title}`).join('\n');
  const t = going.length === 0 ? '_None._' : going.map(w => `- #${w.id} ${w.title}`).join('\n');
  return `**Yesterday**\n${y}\n\n**Today**\n${t}\n\n**Blockers**\n_None._`;
}
