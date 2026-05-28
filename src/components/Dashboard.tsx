import { useEffect, useMemo, useState } from 'react';
import {
  nameFromEmail,
  useDashboardData,
  type ApiPayload,
  type ApiUserStoryGroup,
  type ApiWorkItem,
  type ModeId,
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
} from '../lib/time';
import { useMode } from '../lib/useMode';
import type { SprintContext } from '../lib/types';
import { Dot } from './Dot';
import { ModePlaceholder } from './ModePlaceholder';
import { Mono } from './Mono';
import { ScheduleModal } from './ScheduleModal';
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

  // Work item drawer state — null means closed.
  const [viewingItemId, setViewingItemId] = useState<string | null>(null);
  const openItem = (id: string) => setViewingItemId(id);
  const closeItem = () => setViewingItemId(null);

  // Mode shell + schedule editor state.
  const [mode, setMode] = useMode();
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const ceremonies = data.ceremonies;

  // Every work item with a live Claude Code session, newest session first.
  const allItems = useMemo(
    () => [...inProgress, ...upNext, ...done],
    [inProgress, upNext, done],
  );
  const liveItems = useMemo(
    () =>
      allItems
        .filter(w => !!w.activeSession)
        .sort((a, b) => (a.activeSession!.startedAt < b.activeSession!.startedAt ? 1 : -1)),
    [allItems],
  );

  // R2 focus state: the Day screen morphs to the live task automatically.
  // `focalId` lets a second live task be promoted to the focus; `showBoard`
  // is the manual "show the whole board" escape while a session is still live.
  const [focalId, setFocalId] = useState<string | null>(null);
  const [showBoard, setShowBoard] = useState(false);
  useEffect(() => {
    if (liveItems.length === 0) {
      setShowBoard(false);
      setFocalId(null);
    }
  }, [liveItems.length]);
  const focalTask = useMemo(
    () => liveItems.find(w => w.id === focalId) ?? liveItems[0] ?? null,
    [liveItems, focalId],
  );
  const secondaryLive = useMemo(
    () => liveItems.find(w => !focalTask || w.id !== focalTask.id) ?? null,
    [liveItems, focalTask],
  );
  const isFocus = mode === 'day' && !!focalTask && !showBoard;

  const focusStory = (storyId: string) => {
    const t = liveItems.find(w => (w.parent?.id ?? w.id) === storyId);
    if (t) {
      setFocalId(t.id);
      setShowBoard(false);
    }
  };

  const sprintLabel = data.sprint?.name ?? '—';

  return (
    <div className={`r21-app ${isFocus ? 'is-focus' : 'is-overview'}`} data-density="generous" data-focal="whisper" data-feed="ruled">
      <R21Rail
        active={mode}
        suggested={ceremonies.suggestedModeId}
        onPick={setMode}
        onOpenSchedule={() => setScheduleOpen(true)}
      />

      {mode === 'day' && (
        <R21Sidebar
          dateLabel={date}
          greeting={greetingForHour(now)}
          userName={userName}
          sub={greetingCopy(inProgress.length, daysRemaining)}
          next={ceremonies.next}
          sprintLabel={sprintLabel}
          today={today}
          totalDays={sprintCtx?.totalDays ?? 0}
          railDays={railDays}
        />
      )}

      <div className="r21-main">
        <div className="r21-topwrap">
          {/* OVERVIEW top bar */}
          <div className="r21-top is-overview">
            <div className="r21-brand">
              <span className="r21-brand-mark" aria-hidden="true" />
              <span className="r21-brand-name">SPRINT&nbsp;HELPER</span>
              <span className="r21-brand-meta"><Mono>{userName.toLowerCase()}</Mono></span>
            </div>
            <div className="r21-top-right">
              <SprintPicker
                options={data.sprintOptions}
                currentName={selectedSprintName ?? sprintLabel}
                onSelect={name => {
                  const sprint = data.sprintOptions.find(o => o.isCurrent);
                  onSprintChange(sprint && sprint.name === name ? undefined : name);
                }}
              />
              <span className="r21-pill">day&nbsp;<span className="v">{today}/{sprintCtx?.totalDays ?? '—'}</span></span>
              <span className="r21-pill"><span className="v">{clock}</span></span>
              <button className="ember-sync" onClick={onRefresh} title="Refresh from Azure DevOps">
                <Dot size={5} color="var(--accent)" />
                <span className="dim-small">live</span>&nbsp;<span className="ember-sync-icon">↻</span>
              </button>
            </div>
          </div>
          {/* FOCUS top bar (collapsed strip) */}
          <div className="r21-top is-focus">
            <div className="r21-brand">
              <span className="r21-brand-mark" aria-hidden="true" />
              <span className="r21-brand-name">SPRINT&nbsp;HELPER</span>
              <span className="r21-strip-meta">
                <span className="sep">·</span>
                <span>sprint <span className="v">{sprintLabel}</span></span>
                <span className="sep">·</span>
                <span>day <span className="v">{today}/{sprintCtx?.totalDays ?? '—'}</span></span>
                <span className="sep">·</span>
                <span><span className="v">{Math.round(data.capacity.remainingHours)}h</span> remaining</span>
                <span className="sep">·</span>
                <span><span className="v">{clock}</span></span>
              </span>
            </div>
            <button className="r21-escape" onClick={() => setShowBoard(true)} title="Show the whole board — your work keeps logging">
              <span><span className="v">{Math.max(0, stories.length - 1)}</span> more in sprint</span>
              <span className="arr">↗</span>
            </button>
          </div>
        </div>

        <div className="r21-bodywrap">
          {mode !== 'day' ? (
            <ModePlaceholder mode={mode} />
          ) : (
            <>
              <div className="r21-body is-overview" aria-hidden={isFocus}>
                <R21Overview
                  capacity={data.capacity}
                  stories={stories}
                  inProgress={inProgress}
                  upNext={upNext}
                  done={done}
                  today={today}
                  totalDays={sprintCtx?.totalDays ?? 0}
                  live={liveItems.length > 0}
                  focalTitle={focalTask?.title}
                  onOpenItem={openItem}
                  onShowFocus={() => setShowBoard(false)}
                  onFocusStory={focusStory}
                />
              </div>
              <div className="r21-body is-focus" aria-hidden={!isFocus}>
                {focalTask && (
                  <R21Focus
                    task={focalTask}
                    secondary={secondaryLive}
                    onOpenItem={openItem}
                    onPromoteSecondary={() => secondaryLive && setFocalId(secondaryLive.id)}
                  />
                )}
              </div>
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

const EVENT_LABELS: Record<string, string> = {
  focus: 'Focus',
  progress: 'Progress',
  blocker: 'Blocker',
  decision: 'Decision',
  note: 'Note',
};

const R21_MODES: { id: ModeId; label: string; glyph: JSX.Element }[] = [
  { id: 'day', label: 'Day', glyph: <circle cx="7" cy="7" r="3" fill="currentColor" /> },
  { id: 'preplan', label: 'Pre-plan', glyph: <><rect x="2" y="3" width="10" height="8" rx="1" stroke="currentColor" fill="none" /><line x1="2" y1="6" x2="12" y2="6" stroke="currentColor" /></> },
  { id: 'plan', label: 'Plan', glyph: <><line x1="2" y1="4" x2="12" y2="4" stroke="currentColor" /><line x1="2" y1="7" x2="10" y2="7" stroke="currentColor" /><line x1="2" y1="10" x2="11" y2="10" stroke="currentColor" /></> },
  { id: 'demo', label: 'Demo', glyph: <polygon points="4,3 4,11 12,7" fill="currentColor" /> },
  { id: 'retro', label: 'Retro', glyph: <path d="M 11 7 A 4 4 0 1 1 7 3" stroke="currentColor" fill="none" strokeWidth="1.2" /> },
];

function R21Rail({
  active,
  suggested,
  onPick,
  onOpenSchedule,
}: {
  active: ModeId;
  suggested: ModeId | null;
  onPick: (m: ModeId) => void;
  onOpenSchedule: () => void;
}) {
  return (
    <nav className="r21-rail" aria-label="Mode">
      <span className="r21-rail-cap">Mode</span>
      {R21_MODES.map(m => (
        <button
          key={m.id}
          className={`r21-rail-tile ${active === m.id ? 'is-active' : ''} ${suggested === m.id && active !== m.id ? 'is-suggested' : ''}`}
          onClick={() => onPick(m.id)}
          title={m.label}
        >
          <span className="glyph" aria-hidden="true"><svg viewBox="0 0 14 14">{m.glyph}</svg></span>
          <span className="lbl">{m.label}</span>
        </button>
      ))}
      <button className="r21-rail-gear" onClick={onOpenSchedule} title="Schedule">
        <span className="glyph" aria-hidden="true">
          <svg viewBox="0 0 14 14"><circle cx="7" cy="7" r="3" stroke="currentColor" fill="none" /><circle cx="7" cy="7" r="1" fill="currentColor" /></svg>
        </span>
        <span className="lbl">Schedule</span>
      </button>
    </nav>
  );
}

function R21Sidebar({
  dateLabel,
  greeting,
  userName,
  sub,
  next,
  sprintLabel,
  today,
  totalDays,
  railDays,
}: {
  dateLabel: string;
  greeting: string;
  userName: string;
  sub: string;
  next: ApiPayload['ceremonies']['next'];
  sprintLabel: string;
  today: number;
  totalDays: number;
  railDays: Array<{ index: number; state: string; label: string }>;
}) {
  return (
    <div className="r21-sidewrap">
      <aside className="r21-side">
        <div className="r21-side-date">{dateLabel}</div>
        <h1 className="r21-side-greet">{greeting}, <b>{userName}</b></h1>
        <p className="r21-side-sub">{sub}</p>

        {next && (
          <div className="r21-side-card">
            <span className="cap">Up next · {next.label}</span>
            <div className="row">
              <span className="when"><Mono>{fmtClockISO(next.startsAt)}</Mono></span>
              <span className="rel">{relUntil(next.minutesUntil)}</span>
            </div>
            <span className="name">{next.label}</span>
          </div>
        )}

        {totalDays > 0 && (
          <div className="r21-side-week">
            <div className="r21-side-week-head">
              <span>Sprint <span className="day"><Mono>{sprintLabel}</Mono></span></span>
              <span>day <span className="day"><Mono>{today}/{totalDays}</Mono></span></span>
            </div>
            <div className="r21-side-week-grid">
              {railDays.map(d => (
                <span
                  key={d.index}
                  className={`r21-side-week-cell ${d.state === 'past' ? 'is-past' : d.state === 'today' ? 'is-today' : 'is-future'}`}
                >
                  {d.label}
                </span>
              ))}
            </div>
          </div>
        )}
      </aside>
    </div>
  );
}

function R21Overview({
  capacity,
  stories,
  inProgress,
  upNext,
  done,
  today,
  totalDays,
  live,
  focalTitle,
  onOpenItem,
  onShowFocus,
  onFocusStory,
}: {
  capacity: ApiPayload['capacity'];
  stories: ApiUserStoryGroup[];
  inProgress: ApiWorkItem[];
  upNext: ApiWorkItem[];
  done: ApiWorkItem[];
  today: number;
  totalDays: number;
  live: boolean;
  focalTitle?: string;
  onOpenItem: (id: string) => void;
  onShowFocus: () => void;
  onFocusStory: (storyId: string) => void;
}) {
  const remaining = Math.round(capacity.remainingHours);
  const logged = Math.round(capacity.completedHours);
  const estimate = Math.round(capacity.totalEstimateHours);
  const dailyItems = done.slice(0, 4);
  const sprintItems = [...inProgress, ...upNext].slice(0, 5);

  return (
    <div className="r21-overview">
      <section>
        <div className="r21-headline">
          <div className="r21-headline-left">
            <div>
              <div className="r21-headline-cap">REMAINING</div>
              <div className="r21-headline-big"><Mono>{remaining}</Mono><span className="unit">h</span></div>
            </div>
            <div className="r21-headline-day">day <span className="v">{today}</span> of <span className="v">{totalDays || '—'}</span></div>
          </div>
          <div className="r21-headline-prompt">
            {live && focalTitle
              ? <>Live on <button type="button" className="linkish" onClick={onShowFocus}>{focalTitle}</button></>
              : <>Nothing live — pick a story below</>}
          </div>
        </div>
        <div className="r21-subline">
          <span><span className="v">{logged}h</span> logged this sprint</span>
          <span className="sep">·</span>
          <span><span className="v">{estimate}h</span> estimate</span>
          <span className="sep">·</span>
          <span><span className="v">{inProgress.length}</span> going</span>
          <span className="sep">·</span>
          <span><span className="v">{upNext.length}</span> waiting</span>
        </div>
      </section>

      <section>
        <div className="r21-stories-head">
          <span className="r21-stories-title">My stories</span>
          <span className="r21-stories-meta">{stories.length} in sprint · click to open</span>
        </div>
        <div className="r21-stories-grid">
          {stories.map(s => (
            <button
              key={s.id}
              type="button"
              className={`r21-storychip ${s.hasActiveSession ? 'is-live' : ''}`}
              onClick={() => (s.hasActiveSession ? onFocusStory(s.id) : onOpenItem(s.id))}
            >
              <div className="r21-storychip-head">
                <span className="r21-storychip-kind">{s.type}</span>
                <span className="r21-storychip-id">#{s.id}</span>
              </div>
              <h4 className="r21-storychip-title">{s.title}</h4>
              <div className="r21-storychip-counts">
                {s.counts.inProgress > 0 && <span className="c-going">{s.counts.inProgress} going</span>}
                {s.counts.inProgress > 0 && s.counts.upNext > 0 && <span className="sep">·</span>}
                {s.counts.upNext > 0 && <span>{s.counts.upNext} waiting</span>}
                {s.counts.done > 0 && <><span className="sep">·</span><span>{s.counts.done} done</span></>}
              </div>
            </button>
          ))}
        </div>
      </section>

      <section className="r21-lists">
        <div className="r21-list">
          <div className="r21-list-head">
            <span className="r21-list-title">For your daily</span>
            <span className="r21-list-meta">recently closed</span>
          </div>
          <ul>
            {dailyItems.length === 0 ? (
              <li><span className="t" style={{ color: 'var(--ink-4)' }}>Nothing closed yet</span></li>
            ) : (
              dailyItems.map(w => (
                <li key={w.id} onClick={() => onOpenItem(w.id)}>
                  <Mono className="id">closed #{w.id}</Mono>
                  <span className="t">{w.title}</span>
                </li>
              ))
            )}
          </ul>
        </div>
        <div className="r21-list">
          <div className="r21-list-head">
            <span className="r21-list-title">In this sprint</span>
            <span className="r21-list-meta">{inProgress.length + upNext.length} open</span>
          </div>
          <ul>
            {sprintItems.map(w => (
              <li key={w.id} onClick={() => onOpenItem(w.id)}>
                <Mono className="id">#{w.id}</Mono>
                <span className="t">{w.title}</span>
              </li>
            ))}
          </ul>
        </div>
      </section>
    </div>
  );
}

function R21Focus({
  task,
  secondary,
  onOpenItem,
  onPromoteSecondary,
}: {
  task: ApiWorkItem;
  secondary: ApiWorkItem | null;
  onOpenItem: (id: string) => void;
  onPromoteSecondary: () => void;
}) {
  const parent = task.parent;
  const loggedSec = Math.round((task.completedWork ?? 0) * 3600) + task.localUncapturedSeconds;
  const logged = fmtHM(loggedSec, 0);
  const startedAt = task.activeSession ? fmtClockISO(task.activeSession.startedAt) : '';
  const remaining = task.remainingWork != null ? `${Math.round(task.remainingWork)}h` : '—';
  const events = task.recentActivity;

  return (
    <div className="r21-focal">
      <div className="r21-focal-context">
        <button type="button" onClick={() => onOpenItem(parent ? parent.id : task.id)}>
          <span className="kind">{parent ? 'Story' : task.type}</span>
          {parent && (
            <>
              <span className="sep">·</span>
              <span className="story-title">{parent.title}</span>
              <span className="sep">·</span>
              <Mono className="id">#{parent.id}</Mono>
            </>
          )}
        </button>
      </div>

      <div className="r21-focal-id"><Mono>#{task.id}</Mono></div>
      <h1 className="r21-focal-title">{task.title}</h1>

      <div className="r21-focal-meta">
        <span className="r21-live-pill">live</span>
        {startedAt && <span className="r21-since">started <span className="v">{startedAt}</span></span>}
        <span className="r21-grow" />
        <span className="r21-num">
          <span className="cap">LOGGED</span>
          <span className="val">{logged}</span>
          {task.sessionCount > 0 && <span className="sub">· {task.sessionCount} sitting{task.sessionCount === 1 ? '' : 's'}</span>}
        </span>
        <span className="r21-num">
          <span className="cap">ESTIMATE</span>
          <span className="val">{estimateFor(task)}</span>
        </span>
        <span className="r21-num">
          <span className="cap">REMAINING</span>
          <span className="val">{remaining}</span>
        </span>
      </div>

      {secondary && (
        <button className="r21-also" onClick={onPromoteSecondary} title="Make this the focus instead">
          <span className="cap">ALSO LIVE</span>
          <span className="t">{secondary.title}</span>
          <span className="arr">→</span>
        </button>
      )}

      <div className="r21-feed">
        <div className="r21-feed-head">
          <span className="r21-feed-title">Recent activity</span>
          <span className="r21-feed-meta">
            {events.length} {events.length === 1 ? 'entry' : 'entries'}{startedAt ? ` · since ${startedAt}` : ''}
          </span>
        </div>
        <div className="r21-feed-list">
          {events.length === 0 ? (
            <div className="r21-feed-empty">Nothing logged yet. Claude Code will note things here as you work.</div>
          ) : (
            events.map(e => (
              <div className="r21-ev" key={e.id}>
                <span className="r21-ev-time">{fmtClockISO(e.createdAt)}</span>
                <span className={`r21-ev-type t-${e.type}`}>{EVENT_LABELS[e.type] ?? e.type}</span>
                <span className="r21-ev-body">{e.text}</span>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

function fmtClockISO(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function relUntil(min: number): string {
  if (min <= 0) return 'now';
  if (min < 60) return `in ${min}m`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m === 0 ? `in ${h}h` : `in ${h}h ${m}m`;
}

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

function estimateFor(w: ApiWorkItem): string {
  const h = w.originalEstimate ?? w.remainingWork ?? 0;
  return h === 0 ? '—' : fmtEstimate(Math.round(h * 60));
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

