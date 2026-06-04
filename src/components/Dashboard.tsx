import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import MarkdownIt from 'markdown-it';
import {
  dismissHelperNote,
  nameFromEmail,
  useDashboardData,
  type ApiHelperNote,
  type ApiHelperNotes,
  type ApiOutlookCapacity,
  type ApiPayload,
  type ApiSessionEvent,
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
import { PlanView } from './PlanView';
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

  // Side-panel collapse state — persisted to localStorage so the choice
  // survives refresh. Each panel collapses independently; collapsing both
  // gives the main column the full width.
  const [sideCollapsed, setSideCollapsed] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    return window.localStorage.getItem('sh.side.collapsed') === '1';
  });
  const [railCollapsed, setRailCollapsed] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    return window.localStorage.getItem('sh.rail.collapsed') === '1';
  });
  useEffect(() => {
    window.localStorage.setItem('sh.side.collapsed', sideCollapsed ? '1' : '0');
  }, [sideCollapsed]);
  useEffect(() => {
    window.localStorage.setItem('sh.rail.collapsed', railCollapsed ? '1' : '0');
  }, [railCollapsed]);

  const stories = data.userStories;
  // "My stories" surfaces shouldn't include parent groups that are actually
  // Features or Epics — those happen when tasks are linked directly to a
  // feature with no intermediate user story. Filter once at the top.
  const storyOnlyAll = stories.filter(s => {
    const t = s.type.toLowerCase();
    return t !== 'feature' && t !== 'epic';
  });
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
        // Skip tasks that are Done in ADO even if the local session is still
        // open. Done has to beat the live-session signal — when another chat
        // (or ADO directly) flips a task to closed without calling
        // session_end, the ghost session shouldn't keep pinning Focus to a
        // closed task. The leftover session gets cleaned up via the
        // STALE LIVE SESSION prompt or a future auto-end nudge.
        .filter(w => !!w.activeSession && classifyAdoState(w.state) !== 'done')
        .sort((a, b) => (a.activeSession!.startedAt < b.activeSession!.startedAt ? 1 : -1)),
    [allItems],
  );

  // R2 focus state: the Day screen morphs to the live task automatically.
  // `focalId` lets a second live task be promoted to the focus; `showBoard`
  // is the manual "show the whole board" escape while a session is still live.
  const [focalId, setFocalId] = useState<string | null>(null);
  const [showBoard, setShowBoard] = useState(false);
  // Day mode is now two-place: Daily (the board) and Focus (auto-morphs when
  // a session is live). The old "Overview" place was merged into Daily —
  // helper notes, capacity, and the stat strip all live at the top of Daily.
  const pickMode = (m: ModeId) => setMode(m);
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
  // Focus has top precedence — if a session is live and Moran hasn't asked to
  // see the whole board, the screen morphs to Focus.
  const isFocus = mode === 'day' && !!focalTask && !showBoard;

  const sprintLabel = data.sprint?.name ?? '—';

  return (
    <div className={`r21-app ${isFocus ? 'is-focus' : 'is-overview'}`} data-density="generous" data-focal="whisper" data-feed="ruled">
      <R21Rail
        active={mode}
        suggested={ceremonies.suggestedModeId}
        onPick={pickMode}
        onOpenSchedule={() => setScheduleOpen(true)}
      />

      {mode === 'day' && (
        <R21Sidebar
          dateLabel={date}
          greeting={greetingForHour(now)}
          userName={userName}
          sub={greetingCopy(inProgress.length, daysRemaining)}
          next={ceremonies.next}
          now={now}
          sprintLabel={sprintLabel}
          today={today}
          totalDays={sprintCtx?.totalDays ?? 0}
          railDays={railDays}
          view={isFocus ? 'focus' : 'daily'}
          hasLive={liveItems.length > 0}
          onPickDaily={() => setShowBoard(true)}
          onPickFocus={() => setShowBoard(false)}
          collapsed={sideCollapsed}
          onToggleCollapsed={() => setSideCollapsed(v => !v)}
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
              <span><span className="v">{Math.max(0, storyOnlyAll.length - 1)}</span> more in sprint</span>
              <span className="arr">↗</span>
            </button>
          </div>
        </div>

        <div className="r21-bodywrap">
          {mode === 'plan' ? (
            <PlanView onOpenItem={openItem} />
          ) : mode !== 'day' ? (
            <ModePlaceholder mode={mode} />
          ) : isFocus ? (
            <div className="r21-body is-focus">
              {focalTask && (
                <R21Focus
                  task={focalTask}
                  secondary={secondaryLive}
                  onOpenItem={openItem}
                  onPromoteSecondary={() => secondaryLive && setFocalId(secondaryLive.id)}
                />
              )}
            </div>
          ) : (
            <DailyView
              stories={stories}
              sprintName={sprintLabel}
              onOpenItem={openItem}
              outlookCapacity={data.outlookCapacity}
              helperNotes={data.helperNotes}
              standup={data.standup}
              today={today}
              totalDays={sprintCtx?.totalDays ?? 0}
              live={liveItems.length > 0}
              focalTitle={focalTask?.title}
              onRefresh={onRefresh}
              railCollapsed={railCollapsed}
              onToggleRailCollapsed={() => setRailCollapsed(v => !v)}
            />
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

/**
 * Discreet marker shown next to titles for items sprint-helper itself
 * created via MCP. Invisible to anyone else on the board.
 */
function SHPip({ shown }: { shown: boolean | undefined }) {
  if (!shown) return null;
  return (
    <span className="r12-sh-pip" title="Created by sprint-helper">
      SH
    </span>
  );
}

/**
 * Markdown renderer for activity body text. New entries SHOULD be written
 * as proper markdown (bullets, `code`, **bold**, paragraphs separated by
 * blank lines). `breaks: true` turns a lone newline into <br>, so legacy
 * entries that only got auto-prettified to single \n breaks still render
 * with their sentence-level line spacing. `html: false` blocks any raw
 * HTML from sneaking in.
 */
const md = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: true,
  typographer: false,
});

/**
 * Pre-pass for legacy session_log entries that are still one giant
 * paragraph. New entries SHOULD be written as real markdown
 * (paragraphs, bullets, code), but the DB has plenty of older
 * blob-style writes. We rescue them in two passes:
 *
 *   1. Convert "(1) ... (2) ... (3) ..." into a real markdown ordered
 *      list (`1. ... 2. ... 3. ...`). markdown-it renders these as an
 *      indented `<ol>` so they stand out from surrounding prose.
 *   2. Insert single `\n` at sentence boundaries. With markdown-it's
 *      `breaks: true` those render as `<br>` so prose-blob entries
 *      still read line by line instead of as a wall.
 *
 * Short entries (< 160 chars) and entries that already use markdown
 * (`\n\n` paragraphs, `- ` bullets, `# ` headings, code fences) are
 * left untouched — the writer either knew what they were doing or
 * doesn't need rescue.
 */
function prepEventBody(text: string): string {
  if (text.length < 160) return text;
  if (/(\n\n)|(^[\-*] )|(^#{1,6} )|(^```)|(\n[\-*] )/m.test(text)) return text;

  // Pass 1: sentence breaks (.!? + space + uppercase, "(", or backtick).
  // Backtick covers sentences starting with `code` spans.
  let out = text.replace(/([.!?])\s+(?=[A-Z(`])/g, '$1\n');
  // Pass 1b: colon/semicolon + " (N) " (intro-then-list pattern).
  out = out.replace(/([:;])\s+(?=\(\d+\)\s)/g, '$1\n');

  // Pass 2: turn "(N) " at start-of-line into a markdown ordered-list
  // item ("N. "). The first list item needs a blank line above it so
  // markdown-it starts a list; subsequent items just sit on their own
  // line. The list ends naturally on the first line that isn't "N. ".
  let inList = false;
  out = out
    .split('\n')
    .map(line => {
      const match = line.match(/^\((\d+)\)\s+(.*)$/);
      if (match) {
        const [, num, rest] = match;
        const prefix = inList ? '' : '\n';
        inList = true;
        return `${prefix}${num}. ${rest}`;
      }
      inList = false;
      return line;
    })
    .join('\n');

  return out;
}

/** First-sentence summary for collapsed activity rows; truncated at ~100 chars. */
function collapsedSummary(text: string): string {
  const trimmed = text.trim();
  const match = trimmed.match(/^[^.!?]+[.!?]/);
  const firstSentence = (match ? match[0] : trimmed).trim();
  return firstSentence.length > 100
    ? firstSentence.slice(0, 97).trimEnd() + '…'
    : firstSentence;
}

/**
 * One row in the recent-activity feed. Collapsed by default — shows the
 * first sentence as a summary. Click to expand the full body. Entries whose
 * body equals their summary skip the chevron and aren't toggleable.
 */
function ActivityEntry({ event }: { event: ApiSessionEvent }) {
  const [open, setOpen] = useState(false);
  const summary = collapsedSummary(event.text);
  const hasMore = event.text.trim().length > summary.length + 1;

  return (
    <div className={`r21-ev t-${event.type} ${open ? 'is-open' : ''}`}>
      <button
        type="button"
        className="r21-ev-head"
        onClick={() => hasMore && setOpen(o => !o)}
        aria-expanded={hasMore ? open : undefined}
        data-toggleable={hasMore ? 'true' : 'false'}
      >
        <span className="r21-ev-time">{fmtClockISO(event.createdAt)}</span>
        <span className="r21-ev-type">{EVENT_LABELS[event.type] ?? event.type}</span>
        <span className="r21-ev-summary">{summary}</span>
        {hasMore && <span className="r21-ev-chev">{open ? '▾' : '▸'}</span>}
      </button>
      {hasMore && open && (
        <div
          className="r21-ev-body"
          dangerouslySetInnerHTML={{ __html: md.render(prepEventBody(event.text)) }}
        />
      )}
    </div>
  );
}

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
  now,
  sprintLabel,
  today,
  totalDays,
  railDays,
  view,
  hasLive,
  onPickDaily,
  onPickFocus,
  collapsed,
  onToggleCollapsed,
}: {
  dateLabel: string;
  greeting: string;
  userName: string;
  sub: string;
  next: ApiPayload['ceremonies']['next'];
  /** Fresh client-side clock — recompute relative-time locally; don't trust the server's stale minutesUntil. */
  now: Date;
  sprintLabel: string;
  today: number;
  totalDays: number;
  railDays: Array<{ index: number; state: string; label: string }>;
  view: 'daily' | 'focus';
  hasLive: boolean;
  onPickDaily: () => void;
  onPickFocus: () => void;
  collapsed: boolean;
  onToggleCollapsed: () => void;
}) {
  return (
    <div className={`r21-sidewrap ${collapsed ? 'is-collapsed' : ''}`}>
      <button
        type="button"
        className="r21-sidewrap-toggle"
        onClick={onToggleCollapsed}
        title={collapsed ? 'Show the side panel' : 'Hide the side panel'}
        aria-label={collapsed ? 'Show the side panel' : 'Hide the side panel'}
      >
        {collapsed ? '›' : '‹'}
      </button>
      <aside className="r21-side">
        <div className="r21-side-date">{dateLabel}</div>
        <h1 className="r21-side-greet">{greeting}, <b>{userName}</b></h1>
        <p className="r21-side-sub">{sub}</p>

        <div className="r21-place" role="tablist" aria-label="View">
          <button
            type="button"
            role="tab"
            aria-selected={view === 'daily'}
            className={`r21-place-seg ${view === 'daily' ? 'is-active' : ''}`}
            onClick={onPickDaily}
          >
            Daily
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={view === 'focus'}
            disabled={!hasLive}
            className={`r21-place-seg ${view === 'focus' ? 'is-active' : ''}`}
            onClick={onPickFocus}
            title={hasLive ? 'Switch to Focus on your live task' : 'Focus is only available while a session is live'}
          >
            Focus
          </button>
        </div>

        {next && (
          <div className="r21-side-card">
            <span className="cap">Up next · {next.label}</span>
            <div className="row">
              <span className="when"><Mono>{fmtClockISO(next.startsAt)}</Mono></span>
              <span className="rel">{relUntil(minutesUntilFresh(next.startsAt, now))}</span>
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

/**
 * Recap card — shown only in the Daily view. Reads aloud well: yesterday's
 * tasks with a one-line summary, today's tasks with state. Empty side
 * collapses to a calm note instead of a stark gap. Lives at the top of Daily
 * so it's the first thing Moran sees when the delivery manager opens the
 * board.
 */
function StandupCard({ standup }: { standup: ApiPayload['standup'] }) {
  const { yesterday, today } = standup;
  if (yesterday.length === 0 && today.length === 0) {
    // First-time empty state: don't waste real estate.
    return (
      <div className="r21-standup is-empty">
        <span className="r21-standup-empty">
          No sessions logged yet — open one with Claude Code to start populating this card.
        </span>
      </div>
    );
  }

  const yDate = formatStandupDate(standup.yesterdayDate);
  const tDate = formatStandupDate(standup.todayDate);

  return (
    <section className="r21-standup" aria-label="Yesterday and today">
      <div className="r21-standup-cols">
        <div className="r21-standup-col">
          <h3 className="r21-standup-col-h">
            <span>Yesterday</span>
            <span className="r21-standup-col-meta">{yDate}</span>
          </h3>
          <StandupEntries entries={yesterday} emptyHint="Nothing logged yesterday." />
        </div>
        <div className="r21-standup-col">
          <h3 className="r21-standup-col-h">
            <span>Today</span>
            <span className="r21-standup-col-meta">{tDate}</span>
          </h3>
          <StandupEntries entries={today} emptyHint="No session yet today." />
        </div>
      </div>
    </section>
  );
}

function StandupEntries({
  entries,
  emptyHint,
}: {
  entries: ApiPayload['standup']['yesterday'];
  emptyHint: string;
}) {
  if (entries.length === 0) {
    return <p className="r21-standup-empty">{emptyHint}</p>;
  }
  return (
    <ul className="r21-standup-list">
      {entries.map(e => (
        <li key={e.workItemId} className={`r21-standup-item is-${e.state}`}>
          <div className="r21-standup-item-head">
            <span className="r21-standup-item-kind">Story</span>
            <span className="r21-standup-item-title">
              {extractTitleFromDisplayName(e.displayName)}
            </span>
            <StandupStateBadge state={e.state} minutes={e.minutesInWindow} />
          </div>
          {e.summary && <p className="r21-standup-item-summary">{e.summary}</p>}
          {e.tasks.length > 0 && (
            <ul className="r21-standup-tasks">
              {e.tasks.map(t => (
                <li key={t.workItemId} className={`r21-standup-task is-${standupTaskStateClass(t.adoState)}`}>
                  <span className={`r21-standup-task-state state-${standupTaskStateClass(t.adoState)}`}>
                    {t.adoState}
                  </span>
                  <span className="r21-standup-task-title">{t.title}</span>
                </li>
              ))}
            </ul>
          )}
        </li>
      ))}
    </ul>
  );
}

/** Map ADO state to the state-class language the rest of the UI uses. */
function standupTaskStateClass(adoState: string): 'going' | 'waiting' | 'blocked' | 'done' {
  const s = adoState.toLowerCase();
  if (s === 'blocked' || s === 'on hold') return 'blocked';
  if (s === 'closed' || s === 'done' || s === 'resolved' || s === 'completed' || s === 'removed') return 'done';
  if (s === 'active' || s === 'in progress' || s === 'doing' || s === 'committed') return 'going';
  return 'waiting';
}

function StandupStateBadge({ state }: { state: 'live' | 'paused' | 'closed'; minutes: number | null }) {
  if (state === 'live') return <span className="r21-standup-pill is-live">live</span>;
  // Closed/paused entries: don't show minutes here. Session-open duration is
  // a poor proxy for work time (sessions left open overnight bloat it),
  // and the summary line already says what got done.
  return null;
}

function extractTitleFromDisplayName(displayName: string): string {
  // displayName ships as `**title** (#id)` — strip the bold markers + id for
  // a clean visual line. The id is on the parent ADO link anyway.
  const m = displayName.match(/^\*\*(.+)\*\*\s*\(#(\d+)\)\s*$/);
  return m ? m[1] : displayName;
}

function formatMinutes(min: number): string {
  if (min < 60) return `${min}m`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

function formatStandupDate(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  if (!y || !m || !d) return iso;
  const date = new Date(y, m - 1, d);
  return date.toLocaleDateString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  });
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
  // Canonical CompletedWork on ADO — useful when comparing actual vs estimate
  // on closed work where Remaining has gone to 0/—. LOGGED above includes
  // uncommitted local time; COMPLETED is the number on the board.
  const completed = task.completedWork != null ? `${Math.round(task.completedWork)}h` : '—';
  const events = task.recentActivity;
  // State is truth; tag is fallback only when the type has no Blocked state.
  const taskBlocked = isBlockedState(task.state) || (task.type === 'Bug' && isBlocked(task.tags));
  const parentBlocked = parent
    ? isBlockedState(parent.state) || (parent.type === 'Bug' && isBlocked(task.parentTags))
    : false;

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
      {(taskBlocked || parentBlocked) && (
        <div className="r21-focal-blocked">
          <span className="r21-blocked-pill">blocked</span>
          <span className="r21-focal-blocked-meta">
            {taskBlocked ? 'this task is blocked' : 'parent story is blocked'}
          </span>
        </div>
      )}

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
          <span className="cap">COMPLETED</span>
          <span className={`val ${task.completedWork == null ? 'is-missing' : ''}`}>{completed}</span>
        </span>
        <span className="r21-num">
          <span className="cap">ESTIMATE</span>
          <span className="val">{estimateFor(task)}</span>
        </span>
        <span className="r21-num">
          <span className="cap">REMAINING</span>
          <span className={`val ${task.remainingWork == null ? 'is-missing' : ''}`}>{remaining}</span>
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
            events.map(e => <ActivityEntry key={e.id} event={e} />)
          )}
        </div>
      </div>
    </div>
  );
}

function DailyView({
  stories,
  sprintName,
  onOpenItem,
  outlookCapacity,
  helperNotes,
  standup,
  today,
  totalDays,
  live,
  focalTitle,
  onRefresh,
  railCollapsed,
  onToggleRailCollapsed,
}: {
  stories: ApiUserStoryGroup[];
  sprintName: string;
  onOpenItem: (id: string) => void;
  outlookCapacity: ApiOutlookCapacity | null;
  helperNotes: ApiHelperNotes;
  standup: ApiPayload['standup'];
  today: number;
  totalDays: number;
  live: boolean;
  focalTitle?: string;
  onRefresh: () => void;
  railCollapsed: boolean;
  onToggleRailCollapsed: () => void;
}) {
  // The stories column is the scroller for the "Live on…" jump button in
  // the rail. Capture it via ref so RailSprintTime can scroll the right
  // element + flash the live card.
  const storiesColRef = useRef<HTMLDivElement>(null);

  // Which story cards are currently expanded (show per-task EST/REM). Default
  // is collapsed for every card — Moran expands just the one he's diving into.
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const toggleExpanded = (id: string) =>
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const expandAll = () => setExpanded(new Set(stories.map(s => s.id)));
  const collapseAll = () => setExpanded(new Set());
  const anyExpanded = expanded.size > 0;

  // Which feature sections are collapsed (hide all the story cards under them).
  // Default is expanded for every feature — Moran collapses ones he's not
  // touching this sprint to reduce visual load.
  const [featuresCollapsed, setFeaturesCollapsed] = useState<Set<string>>(new Set());
  const toggleFeatureCollapsed = (id: string) =>
    setFeaturesCollapsed(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  // Group stories by their parent Feature/Epic. Features with active work
  // float to the top; stories with no feature fall to the bottom.
  const featureGroups = useMemo(() => {
    const map = new Map<string, { feature: ApiUserStoryGroup['feature'] | null; stories: ApiUserStoryGroup[] }>();
    for (const s of stories) {
      const key = s.feature?.id ?? '__no_feature__';
      if (!map.has(key)) map.set(key, { feature: s.feature ?? null, stories: [] });
      map.get(key)!.stories.push(s);
    }
    const groups = Array.from(map.values());
    groups.sort((a, b) => {
      // "No feature" group is always last.
      if (a.feature == null) return 1;
      if (b.feature == null) return -1;
      const aGoing = a.stories.reduce((sum, s) => sum + s.counts.inProgress, 0);
      const bGoing = b.stories.reduce((sum, s) => sum + s.counts.inProgress, 0);
      if (aGoing !== bGoing) return bGoing - aGoing;
      return b.stories.length - a.stories.length;
    });
    return groups;
  }, [stories]);

  return (
    <>
    <div className="r21-daily" ref={storiesColRef}>
      <div className="r21-daily-head">
        <div>
          <span className="r21-daily-cap">DAILY · {sprintName}</span>
          <h1 className="r21-daily-title">Your stories &amp; tasks</h1>
        </div>
        <div className="r21-daily-head-actions">
          {stories.length > 0 && (
            <button
              type="button"
              className="r21-daily-bulk"
              onClick={anyExpanded ? collapseAll : expandAll}
              title={anyExpanded ? 'Collapse every card' : 'Expand every card'}
            >
              {anyExpanded ? 'collapse all' : 'expand all'}
            </button>
          )}
        </div>
      </div>

      {/* Standup card — Daily-only. The first thing Moran wants on the screen
          when the delivery manager opens the board: yesterday's work + today's
          work, brief, optimized for speaking aloud. */}
      <StandupCard standup={standup} />

      {stories.length === 0 ? (
        <p className="r21-daily-empty">No stories in this sprint yet.</p>
      ) : (
        <div className="r21-daily-features">
          {featureGroups.map((g, idx) => {
            // Drop any story that IS its own feature — the section header
            // already represents it; the duplicate card was noise.
            const childStories = g.feature
              ? g.stories.filter(s => s.id !== g.feature!.id)
              : g.stories;
            const featureId = g.feature?.id;
            const featureState = featureDominantState(childStories);
            const isCollapsed = featureId ? featuresCollapsed.has(featureId) : false;
            const toggle = featureId ? () => toggleFeatureCollapsed(featureId) : undefined;
            return (
              <section
                className={`r21-daily-feature is-state-${featureState} ${isCollapsed ? 'is-collapsed' : ''}`}
                key={g.feature?.id ?? `none-${idx}`}
              >
                <header
                  className={`r21-daily-feature-head ${g.feature ? 'is-collapsible' : 'is-orphan'} is-state-${featureState}`}
                  {...(toggle ? {
                    role: 'button' as const,
                    tabIndex: 0,
                    onClick: toggle,
                    onKeyDown: (e: KeyboardEvent) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        toggle();
                      }
                    },
                    'aria-expanded': !isCollapsed,
                    title: isCollapsed ? 'Show stories under this feature' : 'Hide stories under this feature',
                  } : {})}
                >
                  {featureId && (
                    <span className="r21-daily-feature-caret" aria-hidden="true">
                      {isCollapsed ? '▸' : '▾'}
                    </span>
                  )}
                  <span className="r21-daily-feature-kind">{g.feature?.type ?? 'No feature'}</span>
                  {g.feature && <Mono className="r21-daily-feature-id">#{g.feature.id}</Mono>}
                  {g.feature && childStories.length > 0 && (
                    <span className={`r21-daily-feature-state state-${featureState}`}>
                      {featureStateLabel(featureState)}
                    </span>
                  )}
                  <h3 className="r21-daily-feature-title">
                    {g.feature?.title ?? 'Stories without a parent feature'}
                  </h3>
                  <span className="r21-daily-feature-meta">
                    <span className="r21-daily-feature-count">
                      {childStories.length} {childStories.length === 1 ? 'story' : 'stories'}
                    </span>
                    {featureId && (
                      <button
                        type="button"
                        className="r21-daily-feature-view"
                        onClick={(e) => {
                          e.stopPropagation();
                          onOpenItem(featureId);
                        }}
                        title="Open this feature in the drawer"
                      >
                        <span>View</span>
                        <span className="arr" aria-hidden="true">↗</span>
                      </button>
                    )}
                  </span>
                </header>
                {!isCollapsed && childStories.length > 0 && (
                  <div className="r21-daily-list">
                    {[...childStories]
                      .sort((a, b) => STORY_STATE_ORDER[storyDominantState(a)] - STORY_STATE_ORDER[storyDominantState(b)])
                      .map(s => (
                        <DailyStoryCard
                          key={s.id}
                          story={s}
                          expanded={expanded.has(s.id)}
                          onOpenItem={onOpenItem}
                          onToggleExpanded={() => toggleExpanded(s.id)}
                        />
                      ))}
                  </div>
                )}
              </section>
            );
          })}
        </div>
      )}
    </div>

    <aside className={`r22-rail ${railCollapsed ? 'is-collapsed' : ''}`} aria-label="At a glance">
      <button
        type="button"
        className="r22-rail-toggle"
        onClick={onToggleRailCollapsed}
        title={railCollapsed ? 'Show the side panel' : 'Hide the side panel'}
        aria-label={railCollapsed ? 'Show the side panel' : 'Hide the side panel'}
      >
        {railCollapsed ? '‹' : '›'}
      </button>
      {!railCollapsed && (
        <>
          <RailSprintTime
            capacity={outlookCapacity}
            today={today}
            totalDays={totalDays}
            live={live}
            focalTitle={focalTitle}
            scrollerRef={storiesColRef}
          />
          <RailNotes notes={helperNotes} onRefresh={onRefresh} />
        </>
      )}
    </aside>
    </>
  );
}

/* -------------------------------------------------------------------------- */
/*  Daily v2 rail cards (R22)                                                 */
/* -------------------------------------------------------------------------- */

function RailSprintTime({
  capacity,
  today,
  totalDays,
  live,
  focalTitle,
  scrollerRef,
}: {
  capacity: ApiOutlookCapacity | null;
  today: number;
  totalDays: number;
  live: boolean;
  focalTitle?: string;
  scrollerRef: React.RefObject<HTMLDivElement>;
}) {
  function jumpToLive() {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const card = scroller.querySelector('.r21-daily-card.is-live') as HTMLElement | null;
    if (!card) return;
    const section = card.closest('.r21-daily-feature');
    if (section && section.classList.contains('is-collapsed')) {
      const head = section.querySelector('.r21-daily-feature-head') as HTMLElement | null;
      if (head) head.click();
    }
    const top = card.getBoundingClientRect().top
              - scroller.getBoundingClientRect().top
              + scroller.scrollTop - 28;
    scroller.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
    card.classList.remove('r22-flash');
    void card.offsetWidth;
    card.classList.add('r22-flash');
    setTimeout(() => card.classList.remove('r22-flash'), 1600);
  }

  if (!capacity) {
    return (
      <section className="r22-rail-card r22-rail-sprint-time" aria-label="Sprint time">
        <div className="r22-rail-card-head">
          <span className="r22-rail-card-label">Sprint time</span>
          <span className="r22-rail-card-meta">day {today} / {totalDays || '—'}</span>
        </div>
        <p className="empty">Capacity data not available right now.</p>
      </section>
    );
  }

  const working = Math.round(capacity.workingHoursTotal);
  const available = Math.round(capacity.availableHours);
  const hasCalendar = capacity.hasUrl && !capacity.fetchError;
  // Working days are Sun-Thu in Moran's setup, so calendar days left
  // overcount — use the workingDaysRemaining the server computes.
  const workingDaysTotal = capacity.workingDays;
  const workingDaysLeft = capacity.workingDaysRemaining;
  const pctLeft =
    workingDaysTotal > 0
      ? Math.max(0, Math.min(100, Math.round((workingDaysLeft / workingDaysTotal) * 100)))
      : 0;

  return (
    <section className="r22-rail-card r22-rail-sprint-time" aria-label="Sprint time">
      <div className="r22-rail-card-head">
        <span className="r22-rail-card-label">Sprint time</span>
        <span className="r22-rail-card-meta">day {today} / {totalDays || '—'}</span>
      </div>
      <div className="hero">
        <span className="num">{available}</span>
        <span className="unit">h</span>
        <span className="suffix">{hasCalendar ? 'after meetings' : 'available'}</span>
      </div>
      <p className="of-line">of {working}h working this sprint</p>
      <div className="bar" aria-hidden="true">
        <i style={{ width: `${pctLeft}%` }} />
      </div>
      <p className="caption">
        {workingDaysLeft <= 0
          ? 'Last day of the sprint'
          : workingDaysLeft === 1
            ? '1 working day left in the sprint'
            : `${workingDaysLeft} working days left in the sprint`}
      </p>
      {live && focalTitle ? (
        <button type="button" className="live" onClick={jumpToLive} title="Jump to the story you're working on">
          <span className="dot" aria-hidden="true" />
          Live on <b>{focalTitle}</b>
          <span className="arr" aria-hidden="true">↗</span>
        </button>
      ) : (
        <span className="live is-quiet">
          <span className="dot" aria-hidden="true" />
          Nothing live right now
        </span>
      )}
    </section>
  );
}

function RailNotes({
  notes,
  onRefresh,
}: {
  notes: ApiHelperNotes;
  onRefresh: () => void;
}) {
  const [pending, setPending] = useState<Set<number>>(new Set());
  const [error, setError] = useState<string | null>(null);

  const visible = notes.notes.filter(n => !pending.has(n.id));
  const empty = !notes.summary && visible.length === 0;

  async function clear(note: ApiHelperNote) {
    setError(null);
    setPending(prev => new Set(prev).add(note.id));
    try {
      await dismissHelperNote(note.id);
      onRefresh();
    } catch (e) {
      setPending(prev => {
        const next = new Set(prev);
        next.delete(note.id);
        return next;
      });
      setError(e instanceof Error ? e.message : 'Could not clear that note');
    }
  }

  return (
    <section className="r22-rail-card r22-rail-notes" aria-label="Notes from your helper">
      <div className="r22-rail-card-head">
        <span className="r22-rail-card-label">Notes from your helper</span>
        {notes.summaryAt && <span className="r22-rail-card-meta">{relAgo(notes.summaryAt)}</span>}
      </div>
      {empty ? (
        <p className="empty">All quiet here — I'll jot notes as I notice things.</p>
      ) : (
        <>
          {notes.summary && <p className="summary">{notes.summary}</p>}
          {visible.length > 0 && (
            <ul className="list">
              {visible.map(n => (
                <li key={n.id} className="note">
                  <p>{n.body}</p>
                  <button
                    type="button"
                    className="note-check"
                    onClick={() => clear(n)}
                    title="Tick off — I've handled this"
                    aria-label="Tick off this note"
                  >
                    <svg viewBox="0 0 16 16" aria-hidden="true">
                      <path d="M3.5 8.5l3 3 6-7" stroke="currentColor" strokeWidth="1.7" fill="none" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
      {error && <p className="error">{error}</p>}
    </section>
  );
}

function DailyStoryCard({
  story,
  expanded,
  onOpenItem,
  onToggleExpanded,
}: {
  story: ApiUserStoryGroup;
  expanded: boolean;
  onOpenItem: (id: string) => void;
  onToggleExpanded: () => void;
}) {
  const sp = story.storyPoints != null ? `${fmtNum(story.storyPoints)}d` : '—';
  const eff = story.effort != null ? `${fmtNum(story.effort)}h` : '—';
  const taskCount = story.counts.inProgress + story.counts.upNext + story.counts.done;
  const dominant = storyDominantState(story);

  return (
    <article className={`r21-daily-card is-state-${dominant} ${expanded ? 'is-expanded' : ''} ${story.hasActiveSession ? 'is-live' : ''}`}>
      <button
        type="button"
        className="r21-daily-card-head"
        onClick={() => onOpenItem(story.id)}
      >
        <span className="r21-daily-card-headline">
          <span className="r21-daily-card-meta-row">
            <span className={`r21-daily-kind kind-${kindSlug(story.type)}`}>{story.type}</span>
            <Mono className="r21-daily-card-id">#{story.id}</Mono>
            <span className={`r21-daily-state state-${dominant}`}>{storyStateLabel(dominant)}</span>
          </span>
          <h2 className="r21-daily-card-title">
            {story.title}
            <SHPip shown={story.wasSHCreated} />
          </h2>
        </span>
        <span className="r21-daily-card-numbers">
          <span className="r21-daily-num">
            <span className="cap">SP</span>
            <span className={`val ${story.storyPoints == null ? 'is-missing' : ''}`}>{sp}</span>
          </span>
          <span className="r21-daily-num">
            <span className="cap">EFFORT</span>
            <span className={`val ${story.effort == null ? 'is-missing' : ''}`}>{eff}</span>
          </span>
        </span>
      </button>

      <div className="r21-daily-card-body">
        {story.descriptionPreview && (
          <p className="r21-daily-desc">{story.descriptionPreview}</p>
        )}

        {story.url && (
          <a
            className="r21-daily-card-ext"
            href={story.url}
            target="_blank"
            rel="noopener noreferrer"
            title="Open this story in Azure DevOps"
          >
            Open in Azure DevOps <span aria-hidden="true">↗</span>
          </a>
        )}

        <div className="r21-daily-counts">
          {story.counts.inProgress > 0 && (
            <span className="c-going"><span className="dot" /> {story.counts.inProgress} going</span>
          )}
          {story.counts.upNext > 0 && (
            <span className="c-waiting"><span className="dot" /> {story.counts.upNext} waiting</span>
          )}
          {story.counts.done > 0 && (
            <span className="c-done"><span className="dot" /> {story.counts.done} done</span>
          )}
          {taskCount === 0 && <span className="c-empty">no tasks under this story yet</span>}
        </div>

        {expanded && story.tasks.length > 0 && (
          <ul className="r21-daily-tasks">
            {story.tasks.map(t => {
              const sc = dailyStateClass(t.state, t.tags);
              const est = t.originalEstimate != null ? `${fmtNum(t.originalEstimate)}h` : '—';
              const rem = t.remainingWork != null ? `${fmtNum(t.remainingWork)}h` : '—';
              return (
                <li key={t.id}>
                  <button
                    type="button"
                    className={`r21-daily-task ${sc}`}
                    onClick={() => onOpenItem(t.id)}
                  >
                    <span className="r21-daily-task-dot" aria-hidden="true" />
                    <Mono className="r21-daily-task-id">#{t.id}</Mono>
                    <span className="r21-daily-task-title">
                      {t.title}
                      <SHPip shown={t.wasSHCreated} />
                    </span>
                    <span className="r21-daily-task-state">{dailyStateLabel(t.state, t.tags)}</span>
                    <span className="r21-daily-task-numbers">
                      <span className="r21-daily-task-num">
                        <span className="cap">EST</span>
                        <span className={`val ${t.originalEstimate == null ? 'is-missing' : ''}`}>{est}</span>
                      </span>
                      <span className="r21-daily-task-num">
                        <span className="cap">REM</span>
                        <span className={`val ${t.remainingWork == null ? 'is-missing' : ''}`}>{rem}</span>
                      </span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}

        {story.tasks.length > 0 && (
          <button
            type="button"
            className="r21-daily-toggle"
            onClick={onToggleExpanded}
            aria-expanded={expanded}
          >
            {expanded ? `▴  hide ${story.tasks.length} task${story.tasks.length === 1 ? '' : 's'}` : `▾  show ${story.tasks.length} task${story.tasks.length === 1 ? '' : 's'}`}
          </button>
        )}
      </div>
    </article>
  );
}

function fmtNum(n: number): string {
  const r = Math.round(n * 10) / 10;
  return Number.isInteger(r) ? String(Math.round(r)) : r.toString();
}

type StoryState = 'going' | 'waiting' | 'done' | 'blocked' | 'empty';

const STORY_STATE_ORDER: Record<StoryState, number> = { going: 0, blocked: 1, waiting: 2, empty: 3, done: 4 };

function isBlockedState(state: string): boolean {
  const s = state.toLowerCase();
  return s === 'blocked' || s === 'on hold';
}

function isBlocked(tags: string[] | undefined): boolean {
  if (!tags) return false;
  return tags.some(t => t.trim().toLowerCase() === 'blocked');
}

function classifyAdoState(state: string): 'going' | 'done' | 'waiting' | 'blocked' {
  const s = state.toLowerCase();
  if (s === 'blocked' || s === 'on hold') return 'blocked';
  if (s === 'active' || s === 'in progress' || s === 'doing' || s === 'committed') return 'going';
  if (s === 'done' || s === 'closed' || s === 'resolved' || s === 'completed' || s === 'removed') return 'done';
  return 'waiting';
}

function storyDominantState(s: ApiUserStoryGroup): StoryState {
  // State first — Blocked beats live session because we want to surface the block.
  const ownState = classifyAdoState(s.state);
  if (ownState === 'blocked') return 'blocked';
  // Story itself closed → whole card is done regardless of leftover tags.
  // Done has to beat the legacy Blocked-tag fallback below, because stories
  // unblocked + closed before the workitem_unblock tag-verify fix
  // (60b9f21) still carry a stale `Blocked` tag and shouldn't read as
  // blocked when the work is over.
  if (ownState === 'done') return 'done';
  // Legacy fallback: tag without state still counts as blocked for
  // in-flight items (only reachable when state isn't Blocked AND isn't
  // Done — i.e. waiting/going/empty).
  if (isBlocked(s.tags)) return 'blocked';
  // Live session — you're literally working on it now.
  if (s.hasActiveSession) return 'going';
  // Story itself active → show going even if child tasks haven't been flipped yet.
  if (ownState === 'going') return 'going';
  // Otherwise fall back to child task counts.
  if (s.counts.inProgress > 0) return 'going';
  if (s.counts.done > 0 && s.counts.upNext === 0) return 'done';
  if (s.counts.upNext > 0) return 'waiting';
  return 'empty';
}

function storyStateLabel(d: StoryState): string {
  if (d === 'going') return 'in work';
  if (d === 'blocked') return 'blocked';
  if (d === 'waiting') return 'not started';
  if (d === 'done') return 'closed';
  return 'no tasks';
}

/**
 * Bubble feature state up from its child stories. Surfacing priority:
 * blocked > going > waiting > done. A feature with mixed states reads as
 * "going" because work is in flight; only "all done" collapses to done.
 */
function featureDominantState(stories: ApiUserStoryGroup[]): StoryState {
  if (stories.length === 0) return 'empty';
  const dominants = stories.map(storyDominantState);
  if (dominants.some(d => d === 'blocked')) return 'blocked';
  if (dominants.some(d => d === 'going')) return 'going';
  if (dominants.every(d => d === 'done')) return 'done';
  if (dominants.some(d => d === 'waiting')) return 'waiting';
  return 'empty';
}

function featureStateLabel(d: StoryState): string {
  if (d === 'going') return 'in work';
  if (d === 'blocked') return 'blocked';
  if (d === 'waiting') return 'not started';
  if (d === 'done') return 'closed';
  return 'no stories';
}

function dailyStateClass(state: string, tags?: string[]): string {
  if (isBlockedState(state)) return 'is-blocked';
  const s = state.toLowerCase();
  // Done has to beat the legacy Blocked-tag fallback — items closed before
  // the 60b9f21 tag-verify fix can carry a stale `Blocked` tag.
  if (s === 'done' || s === 'closed' || s === 'resolved' || s === 'completed' || s === 'removed') return 'is-done';
  if (isBlocked(tags)) return 'is-blocked';
  if (s === 'active' || s === 'in progress' || s === 'doing' || s === 'committed') return 'is-going';
  return 'is-waiting';
}

function dailyStateLabel(state: string, tags?: string[]): string {
  const sc = dailyStateClass(state, tags);
  if (sc === 'is-blocked') return 'blocked';
  if (sc === 'is-going') return 'going';
  if (sc === 'is-done') return 'done';
  return 'waiting';
}

function kindSlug(type: string): string {
  const s = type.toLowerCase();
  if (s.includes('feature')) return 'feature';
  if (s.includes('epic')) return 'epic';
  if (s.includes('bug') || s.includes('issue')) return 'bug';
  if (s.includes('story')) return 'story';
  return 'other';
}

function fmtClockISO(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function relUntil(min: number): string {
  if (min === 0) return 'now';
  if (min > 0) {
    if (min < 60) return `in ${min}m`;
    const h = Math.floor(min / 60);
    const m = min % 60;
    return m === 0 ? `in ${h}h` : `in ${h}h ${m}m`;
  }
  // min < 0 — already started or already ended.
  const ago = -min;
  if (ago < 60) return `${ago}m ago`;
  const h = Math.floor(ago / 60);
  const m = ago % 60;
  return m === 0 ? `${h}h ago` : `${h}h ${m}m ago`;
}

function minutesUntilFresh(startsAtISO: string, now: Date): number {
  return Math.round((new Date(startsAtISO).getTime() - now.getTime()) / 60000);
}

/** "just now" / "20m ago" / "3h ago" / "2d ago" — for the helper-notes timestamp. */
function relAgo(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';
  const min = Math.floor((Date.now() - then) / 60000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
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
          <p className="ember-sub">Pulling your sprint from Azure DevOps. The first load after starting can take a moment — it's quick after that.</p>
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

