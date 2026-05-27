import { useEffect, useMemo, useState } from 'react';
import {
  nameFromEmail,
  timerDone,
  timerPause,
  timerStart,
  timerSync,
  updateWorkItem,
  useDashboardData,
  type ApiPayload,
  type ApiUserStoryGroup,
  type ApiWorkItem,
  type StateBucket,
} from '../lib/api';
import {
  dayOfSprint,
  fmtEstimate,
  fmtHM,
  formatClock,
  formatLongDate,
  greetingForHour,
  sprintDays,
  useNow,
  useTick,
} from '../lib/time';
import { useEditable } from '../lib/useEditable';
import { useMode } from '../lib/useMode';
import type { SprintContext } from '../lib/types';
import { Dot } from './Dot';
import { ModePlaceholder } from './ModePlaceholder';
import { ModeRail } from './ModeRail';
import { Mono } from './Mono';
import { ScheduleModal } from './ScheduleModal';
import { StatePicker } from './StatePicker';
import { Stepper } from './Stepper';
import { UpNextTile } from './UpNextTile';
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
  // Expanded chip is independent of the focused active story — you can
  // quick-edit a non-focused story without losing your current focus.
  const [expandedChipId, setExpandedChipId] = useState<string | null>(null);
  // Work item drawer state — null means closed.
  const [viewingItemId, setViewingItemId] = useState<string | null>(null);
  const openItem = (id: string) => setViewingItemId(id);
  const closeItem = () => setViewingItemId(null);

  // Mode shell + schedule editor state.
  const [mode, setMode] = useMode();
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const ceremonies = data.ceremonies;

  // Re-sync active story when the data changes (e.g., sprint switch).
  useEffect(() => {
    if (!activeStoryId || !stories.some(s => s.id === activeStoryId)) {
      setActiveStoryId(stories[0]?.id);
    }
  }, [stories, activeStoryId]);
  useEffect(() => {
    if (expandedChipId && !stories.some(s => s.id === expandedChipId)) {
      setExpandedChipId(null);
    }
  }, [stories, expandedChipId]);

  const activeStory = useMemo(
    () => stories.find(s => s.id === activeStoryId) ?? stories[0],
    [stories, activeStoryId],
  );
  const expandedChip = useMemo(
    () => stories.find(s => s.id === expandedChipId) ?? null,
    [stories, expandedChipId],
  );

  const sprintLeftHours = `${Math.round(data.capacity.remainingHours)}h`;
  const completedHours = `${Math.round(data.capacity.completedHours)}h`;
  const totalEstimateHours = `${Math.round(data.capacity.totalEstimateHours)}h`;

  const sprintLabel = data.sprint?.name ?? '—';

  return (
    <div className="ember has-rail">
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
        <ModeRail
          active={mode}
          suggested={ceremonies.suggestedModeId}
          onPick={setMode}
          onOpenSchedule={() => setScheduleOpen(true)}
        />

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

          {/* Up next tile */}
          <UpNextTile
            next={ceremonies.next}
            upcoming={ceremonies.upcoming}
            onJump={setMode}
            onOpenSchedule={() => setScheduleOpen(true)}
          />

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
          {mode !== 'day' ? <ModePlaceholder mode={mode} /> : (
          <>
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
                  <Mono style={{ color: 'var(--ink-1)' }}>{stories.length}</Mono>&nbsp;in this sprint · click to focus · <Mono style={{ color: 'var(--ink-2)' }}>›</Mono> for quick edits
                </span>
              </div>
              <div className="ember-stories-grid chips-grid">
                {stories.map(s => (
                  <StoryChip
                    key={s.id}
                    story={s}
                    active={activeStory?.id === s.id}
                    open={expandedChipId === s.id}
                    onFocus={() => setActiveStoryId(s.id)}
                    onToggleExpand={() => setExpandedChipId(id => (id === s.id ? null : s.id))}
                  />
                ))}
                <div className={`chip-expand-wrap va ${expandedChip ? 'is-open' : ''}`}>
                  <div className="chip-expand">
                    {expandedChip && (
                      <StoryChipExpand
                        story={expandedChip}
                        onOpen={() => openItem(expandedChip.id)}
                        onAfterChange={onRefresh}
                      />
                    )}
                  </div>
                </div>
              </div>
            </section>
          )}

          {/* ACTIVE STORY focus */}
          {activeStory && (
            <ActiveStoryCard
              story={activeStory}
              onOpenItem={openItem}
              onAfterChange={onRefresh}
              fetchedAt={data.fetchedAt}
            />
          )}

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

          {/* SYNC BANNER */}
          <section className="ember-sync-banner">
            <div className="ember-sync-left">
              <Mono className="ember-sync-n">{data.pendingChanges}</Mono>
              <div className="ember-sync-text">
                <span className="ember-sync-headline">
                  {data.pendingChanges === 0
                    ? 'all caught up with azure devops'
                    : `${data.pendingChanges} task${data.pendingChanges === 1 ? '' : 's'} with unsynced time`}
                </span>
                <span className="ember-sync-detail">
                  {data.pendingChanges === 0
                    ? 'logged time is pushed when you sync or mark a task done'
                    : 'press ↑ on a task to sync, or ✓ to mark it done'}
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
          </>
          )}
        </div>
      </div>

      <ScheduleModal
        open={scheduleOpen}
        onClose={() => setScheduleOpen(false)}
        onSaved={onRefresh}
      />

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
  onAfterChange,
  fetchedAt,
}: {
  story: ApiUserStoryGroup;
  onOpenItem: (id: string) => void;
  onAfterChange: () => void;
  fetchedAt: string;
}) {
  // Live tick — re-render once per second so running timers' counters advance.
  useTick();
  const fetchedAtMs = useMemo(() => new Date(fetchedAt).getTime(), [fetchedAt]);
  // Seconds elapsed since the server's snapshot — added to each running task's logged total.
  const driftSec = Math.max(0, Math.floor((Date.now() - fetchedAtMs) / 1000));

  const storyLiveHours = story.completedHours + (story.tasks.filter(t => t.runningSince).length * driftSec) / 3600;
  const storyLiveRemaining = Math.max(
    0,
    story.remainingHours - (story.tasks.filter(t => t.runningSince).length * driftSec) / 3600,
  );

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
        <NumberBlock label="logged" value={storyLiveHours} accent />
        <Divider />
        <NumberBlock label="estimate" value={story.totalEstimateHours} dim />
        <Divider />
        <NumberBlock label="remaining" value={storyLiveRemaining} dim />
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
          <TaskRow
            key={task.id}
            task={task}
            driftSec={driftSec}
            onOpen={() => onOpenItem(task.id)}
            onAfterChange={onAfterChange}
          />
        ))}
      </div>

      <div className="ember-active-story-actions">
        <a className="ember-act ember-act-ghost" href={story.url} target="_blank" rel="noreferrer">
          open story in Azure DevOps <span aria-hidden="true">↗</span>
        </a>
      </div>
    </section>
  );
}

function TaskRow({
  task,
  driftSec,
  onOpen,
  onAfterChange,
}: {
  task: ApiWorkItem;
  driftSec: number;
  onOpen: () => void;
  onAfterChange: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [timerPending, setTimerPending] = useState<null | 'start' | 'pause' | 'sync' | 'done'>(null);
  const [timerError, setTimerError] = useState<string | null>(null);

  const stateEdit = useEditable<StateBucket>(bucketForState(task.state));
  const estimateEdit = useEditable<number>(task.originalEstimate ?? 0);
  const remainingEdit = useEditable<number>(task.remainingWork ?? 0);

  const isDone = stateEdit.display === 'done';
  const running = !!task.runningSince;
  const hasUnsynced = task.localUncapturedSeconds > 0 || running;

  const baseLoggedSec = Math.round((task.completedWork ?? 0) * 3600) + task.localUncapturedSeconds;
  const liveLoggedSec = baseLoggedSec + (running ? driftSec : 0);
  const loggedDisplay = fmtHM(liveLoggedSec, 0);

  async function doTimerAction(kind: 'start' | 'pause' | 'sync' | 'done') {
    setTimerPending(kind);
    setTimerError(null);
    try {
      switch (kind) {
        case 'start': await timerStart(task.id); break;
        case 'pause': await timerPause(task.id); break;
        case 'sync':  await timerSync(task.id); break;
        case 'done':  await timerDone(task.id); break;
      }
      onAfterChange();
    } catch (e) {
      setTimerError(e instanceof Error ? e.message : String(e));
    } finally {
      setTimerPending(null);
    }
  }

  const errorMsg = timerError ?? stateEdit.error ?? estimateEdit.error ?? remainingEdit.error;

  const toggle = () => setExpanded(v => !v);
  const stop = (fn: () => void) => (e: React.MouseEvent) => {
    e.stopPropagation();
    fn();
  };

  return (
    <>
      <div
        className={`ember-active-story-task task-row state-${stateEdit.display} ${running ? 'is-running' : ''} ${expanded ? 'is-open' : ''}`}
        role="button"
        tabIndex={0}
        aria-expanded={expanded}
        aria-label={`Task #${task.id} ${task.title} — ${expanded ? 'collapse' : 'expand'}`}
        onClick={toggle}
        onKeyDown={e => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            toggle();
          }
        }}
      >
        <span className="ember-task-id task-id">#{task.id}</span>
        <span className="ember-task-title task-title">{task.title}</span>
        <span className="ember-task-meta task-effort">
          <Mono className={running ? 'accent' : undefined}>{loggedDisplay}</Mono>
          &nbsp;<span className="of">/</span>&nbsp;
          <Mono style={{ color: 'var(--ink-2)' }}>{estimateFor(task)}</Mono>
        </span>
        <span className="ember-task-state task-state">{bucketLabel(stateEdit.display)}</span>
        <span className="ember-task-controls task-quickacts">
          {!isDone && !running && (
            <button className="ember-task-btn task-quick" onClick={stop(() => doTimerAction('start'))} disabled={timerPending !== null} title="Start timer">
              <span className="task-quick-glyph">▶</span> start
            </button>
          )}
          {!isDone && running && (
            <button className="ember-task-btn pause task-quick" onClick={stop(() => doTimerAction('pause'))} disabled={timerPending !== null} title="Pause timer">
              <span className="task-quick-glyph">⏸</span> pause
            </button>
          )}
          {!isDone && hasUnsynced && !running && (
            <button className="ember-task-btn sync task-quick" onClick={stop(() => doTimerAction('sync'))} disabled={timerPending !== null} title="Push logged time to Azure DevOps">
              <span className="task-quick-glyph">↑</span> sync
            </button>
          )}
          {!isDone && (
            <button className="ember-task-btn done task-quick" onClick={stop(() => doTimerAction('done'))} disabled={timerPending !== null} title="Mark done in Azure DevOps">
              <span className="task-quick-glyph">✓</span> done
            </button>
          )}
        </span>
        <span
          className={`chev ${expanded ? 'is-open' : ''}`}
          aria-hidden="true"
          title={expanded ? 'collapse' : 'expand'}
        >
          ›
        </span>
      </div>

      <div className={`task-expand-wrap va ${expanded ? 'is-open' : ''}`}>
        <div className="task-expand">
          <div className="task-expand-inner">
            {task.parent && (
              <div className="task-expand-context">
                <span>{task.parent.type}</span>
                <span className="dot">·</span>
                <span className="tag-id">#{task.parent.id}</span>
                <span className="dot">·</span>
                <span className="tag-title">{task.parent.title}</span>
              </div>
            )}
            {task.descriptionPreview && (
              <p className="task-expand-desc">{task.descriptionPreview}</p>
            )}
            <div className="task-expand-strip">
              <div className="group">
                <span className="label">STATE</span>
                <StatePicker
                  value={stateEdit.display}
                  disabled={stateEdit.saving}
                  onChange={next => stateEdit.save(next, n =>
                    updateWorkItem(task.id, { state: n }).then(() => onAfterChange()),
                  )}
                />
              </div>
              <div className="group">
                <span className="label">ESTIMATE</span>
                <Stepper
                  value={estimateEdit.display}
                  disabled={estimateEdit.saving}
                  onChange={next => estimateEdit.save(next, n =>
                    updateWorkItem(task.id, { originalEstimate: n }).then(() => onAfterChange()),
                  )}
                />
              </div>
              <div className="group">
                <span className="label">REMAINING</span>
                <Stepper
                  value={remainingEdit.display}
                  disabled={remainingEdit.saving}
                  onChange={next => remainingEdit.save(next, n =>
                    updateWorkItem(task.id, { remainingWork: n }).then(() => onAfterChange()),
                  )}
                />
              </div>
            </div>
            <div className="task-expand-foot">
              <span className="pushnote">edits push to Azure DevOps when you click away</span>
              <button className="ghost" onClick={onOpen}>see full description and comments →</button>
            </div>
            {errorMsg && (
              <div className="task-expand-error" role="alert">
                {errorMsg}
              </div>
            )}
          </div>
        </div>
      </div>
    </>
  );
}

function bucketForState(state: string): StateBucket {
  if (DONE_STATES_FRONT.has(state)) return 'done';
  if (ACTIVE_STATES_FRONT.has(state)) return 'going';
  return 'waiting';
}

function bucketLabel(b: StateBucket): string {
  return b === 'going' ? 'GOING' : b === 'done' ? 'DONE' : 'WAITING';
}

function StoryChip({
  story,
  active,
  open,
  onFocus,
  onToggleExpand,
}: {
  story: ApiUserStoryGroup;
  active: boolean;
  open: boolean;
  onFocus: () => void;
  onToggleExpand: () => void;
}) {
  return (
    <div
      className={`ember-story-chip chip ${active ? 'active' : ''} ${open ? 'is-open' : ''}`}
      role="button"
      tabIndex={0}
      aria-pressed={active}
      onClick={onFocus}
      onKeyDown={e => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onFocus();
        }
      }}
    >
      <div className="ember-story-chip-head chip-head">
        <span className="ember-story-chip-type">{story.type}</span>
        <span className="ember-story-chip-id">#{story.id}</span>
        <button
          className={`chip-chev ${open ? 'is-open' : ''}`}
          onClick={e => {
            e.stopPropagation();
            onToggleExpand();
          }}
          aria-expanded={open}
          aria-label={open ? 'collapse quick edits' : 'expand quick edits'}
          title={open ? 'collapse quick edits' : 'expand for quick edits'}
        >
          ›
        </button>
      </div>
      <span className="ember-story-chip-title">{story.title}</span>
      <div className="ember-story-chip-meta">
        {story.counts.inProgress > 0 && (
          <span className="ember-story-chip-pill going">
            <Mono>{story.counts.inProgress}</Mono> going
          </span>
        )}
        {story.counts.upNext > 0 && (
          <span className="ember-story-chip-pill">
            <Mono>{story.counts.upNext}</Mono> waiting
          </span>
        )}
        {story.counts.done > 0 && (
          <span className="ember-story-chip-pill">
            <Mono>{story.counts.done}</Mono> done
          </span>
        )}
        <span style={{ marginLeft: 'auto' }}>
          <Mono>{Math.round(story.remainingHours)}h</Mono> left
        </span>
      </div>
    </div>
  );
}

function StoryChipExpand({
  story,
  onOpen,
  onAfterChange,
}: {
  story: ApiUserStoryGroup;
  onOpen: () => void;
  onAfterChange: () => void;
}) {
  const stateEdit = useEditable<StateBucket>(bucketForState(story.state));
  const estimateEdit = useEditable<number>(story.parentEstimate ?? 0);
  const remainingEdit = useEditable<number>(story.parentRemaining ?? 0);
  const totalChildren = story.counts.inProgress + story.counts.upNext + story.counts.done;
  const errorMsg = stateEdit.error ?? estimateEdit.error ?? remainingEdit.error;

  return (
    <div className="chip-expand-inner">
      <div className="chip-expand-meta">
        <span>{story.type}</span>
        <span className="sep">·</span>
        <Mono className="v">#{story.id}</Mono>
        <span className="sep">·</span>
        <span className="v">{bucketLabel(stateEdit.display).toLowerCase()}</span>
        {story.area && (
          <>
            <span className="sep">·</span>
            <span>{story.area}</span>
          </>
        )}
        <span className="sep">·</span>
        <span>{totalChildren} child task{totalChildren === 1 ? '' : 's'} assigned to you</span>
      </div>
      {story.descriptionPreview && (
        <p className="chip-expand-desc">{story.descriptionPreview}</p>
      )}
      <div className="chip-expand-strip">
        <div className="group">
          <span className="label">STATE</span>
          <StatePicker
            value={stateEdit.display}
            disabled={stateEdit.saving}
            onChange={next => stateEdit.save(next, n =>
              updateWorkItem(story.id, { state: n }).then(() => onAfterChange()),
            )}
          />
        </div>
        <div className="group">
          <span className="label">ESTIMATE</span>
          <Stepper
            value={estimateEdit.display}
            disabled={estimateEdit.saving}
            onChange={next => estimateEdit.save(next, n =>
              updateWorkItem(story.id, { originalEstimate: n }).then(() => onAfterChange()),
            )}
          />
        </div>
        <div className="group">
          <span className="label">REMAINING</span>
          <Stepper
            value={remainingEdit.display}
            disabled={remainingEdit.saving}
            onChange={next => remainingEdit.save(next, n =>
              updateWorkItem(story.id, { remainingWork: n }).then(() => onAfterChange()),
            )}
          />
        </div>
      </div>
      <div className="chip-expand-foot">
        <span>edits push to Azure DevOps when you click away</span>
        <button className="ghost" onClick={onOpen}>open story details →</button>
      </div>
      {errorMsg && (
        <div className="task-expand-error" role="alert">
          {errorMsg}
        </div>
      )}
    </div>
  );
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
