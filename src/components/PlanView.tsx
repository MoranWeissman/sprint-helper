// src/components/PlanView.tsx — Plan v2 (header + meter + numbered steps + unified rows)
import { useEffect, useMemo, useState } from 'react';
import {
  fetchCockpit,
  fetchPlanningGaps,
  markWorkItemDone,
  moveWorkItemToIteration,
  type ApiCockpitBacklogStory,
  type ApiCockpitOpenStory,
  type ApiCockpitOpenTask,
  type ApiCockpitPayload,
  type ApiPlanningGap,
  type ApiPlanningGapsResponse,
} from '../lib/api';

type ScanState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ok'; data: ApiPlanningGapsResponse }
  | { status: 'error'; error: string };

type CockpitState =
  | { status: 'loading' }
  | { status: 'ok'; data: ApiCockpitPayload }
  | { status: 'error'; error: string };

interface PlanViewProps {
  onOpenItem?: (id: string) => void;
  onScanComplete?: (gapCount: number) => void;
}

const LS_KEY = 'sh.plan.lastScan';

function readPersistedScan(): ApiPlanningGapsResponse | null {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as ApiPlanningGapsResponse;
  } catch {
    return null;
  }
}
function writePersistedScan(data: ApiPlanningGapsResponse): void {
  try { localStorage.setItem(LS_KEY, JSON.stringify(data)); } catch { /* ignore */ }
}
function clearPersistedScan(): void {
  try { localStorage.removeItem(LS_KEY); } catch { /* ignore */ }
}

/**
 * Working days (Sun-Thu) between two ISO date strings, inclusive of both ends.
 * Mirrors the server's DEFAULT_WORKING_DAYS = [0,1,2,3,4].
 */
function workingDaysBetween(startISO: string, endISO: string): number {
  const start = new Date(startISO);
  const end = new Date(endISO);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return 0;
  const cursor = new Date(start);
  cursor.setHours(0, 0, 0, 0);
  const stop = new Date(end);
  stop.setHours(23, 59, 59, 999);
  let count = 0;
  while (cursor <= stop) {
    const day = cursor.getDay();
    if (day >= 0 && day <= 4) count++;
    cursor.setDate(cursor.getDate() + 1);
  }
  return count;
}

const WORKDAY_HOURS = 9;

export function PlanView({ onOpenItem, onScanComplete }: PlanViewProps) {
  const [cockpit, setCockpit] = useState<CockpitState>({ status: 'loading' });
  const [actingOn, setActingOn] = useState<number | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  // Session-local tally of effort/hours pulled into the next sprint via the
  // pull buttons. Resets when Plan re-mounts. The meter reads this against
  // the next-sprint capacity to show "how much of your time you've spent."
  const [pulledHoursThisSession, setPulledHoursThisSession] = useState(0);

  const toggleExpanded = (id: number) =>
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const refreshCockpit = async () => {
    setCockpit({ status: 'loading' });
    try {
      const data = await fetchCockpit();
      setCockpit({ status: 'ok', data });
    } catch (err) {
      setCockpit({ status: 'error', error: err instanceof Error ? err.message : 'unknown error' });
    }
  };

  useEffect(() => { void refreshCockpit(); }, []);

  const nextSprintCap = useMemo(() => {
    if (cockpit.status !== 'ok') return 0;
    const ns = cockpit.data.nextSprint;
    if (!ns) return 0;
    return workingDaysBetween(ns.startDate, ns.finishDate) * WORKDAY_HOURS;
  }, [cockpit]);

  const onMoveTask = async (task: ApiCockpitOpenTask, nextSprintPath: string) => {
    setActingOn(task.id);
    setActionError(null);
    try {
      await moveWorkItemToIteration(task.id, nextSprintPath);
      const credit = task.remainingWork ?? task.originalEstimate ?? 0;
      if (credit > 0) setPulledHoursThisSession(h => h + credit);
      await refreshCockpit();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Move failed');
    } finally {
      setActingOn(null);
    }
  };

  const onCloseTask = async (taskId: number, completedHours: number) => {
    setActingOn(taskId);
    setActionError(null);
    try {
      await markWorkItemDone(taskId, completedHours);
      await refreshCockpit();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Close failed');
    } finally {
      setActingOn(null);
    }
  };

  const onPullBacklog = async (story: ApiCockpitBacklogStory, nextSprintPath: string) => {
    setActingOn(story.id);
    setActionError(null);
    try {
      await moveWorkItemToIteration(story.id, nextSprintPath);
      const credit = story.effort ?? 0;
      if (credit > 0) setPulledHoursThisSession(h => h + credit);
      await refreshCockpit();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Pull failed');
    } finally {
      setActingOn(null);
    }
  };

  return (
    <div className="r12-plan">
      <PlanHeader
        cockpit={cockpit}
        pulledHours={pulledHoursThisSession}
        capHours={nextSprintCap}
      />

      {actionError && (
        <div className="plan2-error" role="alert">
          {actionError}
          <button onClick={() => setActionError(null)}>dismiss</button>
        </div>
      )}

      <CloseOutSection
        cockpit={cockpit}
        actingOn={actingOn}
        expanded={expanded}
        onToggleExpanded={toggleExpanded}
        onMoveTask={onMoveTask}
        onCloseTask={onCloseTask}
        onOpenItem={onOpenItem}
      />

      <PullBacklogSection
        cockpit={cockpit}
        actingOn={actingOn}
        onPullStory={onPullBacklog}
        onOpenItem={onOpenItem}
      />

      <SanityCheckSection onScanComplete={onScanComplete} />
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  HEADER + METER                                                            */
/* -------------------------------------------------------------------------- */

function PlanHeader({
  cockpit,
  pulledHours,
  capHours,
}: {
  cockpit: CockpitState;
  pulledHours: number;
  capHours: number;
}) {
  const current = cockpit.status === 'ok' ? cockpit.data.currentSprint : null;
  const next = cockpit.status === 'ok' ? cockpit.data.nextSprint : null;

  const titleCap = current && next
    ? `Planning · ${current.name} → ${next.name}`
    : current
      ? `Planning · ${current.name}`
      : 'Planning';

  const subText = next
    ? <>Close out what's open, then pull from the backlog into <b>{next.name}</b>.</>
    : <>No next sprint scheduled yet — schedule one in Azure DevOps to enable pulling.</>;

  const cap = Math.max(0, Math.round(capHours));
  const pulled = Math.max(0, Math.round(pulledHours));
  const left = cap - pulled;

  let verdictText = '0h pulled';
  let verdictClass: 'is-room' | 'is-near' | 'is-over' = 'is-room';
  let fillOver = false;
  if (cap > 0) {
    if (pulled > cap) { verdictText = `${pulled - cap}h over`; verdictClass = 'is-over'; fillOver = true; }
    else if (left <= 8) { verdictText = `${left}h left`; verdictClass = 'is-near'; }
    else { verdictText = `${left}h to spare`; verdictClass = 'is-room'; }
  } else {
    verdictText = '— no cap yet';
    verdictClass = 'is-room';
  }
  const pct = cap > 0 ? Math.min(100, Math.round((pulled / cap) * 100)) : 0;

  return (
    <div className="plan2-head">
      <div className="plan2-head-title">
        <span className="plan2-cap">{titleCap}</span>
        <h1 className="plan2-h">Plan the next sprint</h1>
        <p className="plan2-sub">{subText}</p>
      </div>
      <div className="plan2-meter">
        <div className="plan2-meter-top">
          <span className="plan2-meter-label">
            {next ? `${next.name} commitment` : 'Next sprint commitment'}
          </span>
          <span className={`plan2-meter-verdict ${verdictClass}`}>{verdictText}</span>
        </div>
        <div className="plan2-meter-bar">
          <span className={`plan2-meter-fill ${fillOver ? 'is-over' : ''}`} style={{ width: `${pct}%` }} />
        </div>
        <div className="plan2-meter-foot">
          <span>pulled <span className="n big">{pulled}h</span></span>
          <span>of <span className="n">{cap}h</span> available</span>
        </div>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  STEP 1 — CLOSE OUT current sprint                                         */
/* -------------------------------------------------------------------------- */

function CloseOutSection({
  cockpit,
  actingOn,
  expanded,
  onToggleExpanded,
  onMoveTask,
  onCloseTask,
  onOpenItem,
}: {
  cockpit: CockpitState;
  actingOn: number | null;
  expanded: Set<number>;
  onToggleExpanded: (id: number) => void;
  onMoveTask: (task: ApiCockpitOpenTask, nextSprintPath: string) => Promise<void>;
  onCloseTask: (taskId: number, completedHours: number) => Promise<void>;
  onOpenItem?: (id: string) => void;
}) {
  if (cockpit.status === 'loading') {
    return (
      <section className="plan2-section">
        <SectionHead step={1} title="Close out current sprint" />
        <div className="plan2-empty">Loading…</div>
      </section>
    );
  }
  if (cockpit.status === 'error') {
    return (
      <section className="plan2-section">
        <SectionHead step={1} title="Close out current sprint" />
        <div className="plan2-empty">Couldn't load — {cockpit.error}</div>
      </section>
    );
  }
  const { currentSprint, nextSprint, openStories } = cockpit.data;
  const taskRemaining = openStories.reduce((s, st) => s + st.openTasks.length, 0);

  return (
    <section className="plan2-section">
      <SectionHead
        step={1}
        title={currentSprint ? `Close out ${currentSprint.name}` : 'Close out current sprint'}
        note={openStories.length > 0
          ? <><span className="n">{openStories.length}</span> {openStories.length === 1 ? 'story' : 'stories'} open · <span className="n">{taskRemaining}</span> {taskRemaining === 1 ? 'task' : 'tasks'} remaining</>
          : null}
      />
      {openStories.length === 0 ? (
        <div className="plan2-empty">Nothing open — everything in this sprint is done.</div>
      ) : (
        <ul className="plan2-rows">
          {openStories.map(story => (
            <CloseOutStoryRow
              key={story.id}
              story={story}
              isExpanded={expanded.has(story.id)}
              onToggle={() => onToggleExpanded(story.id)}
              actingOn={actingOn}
              nextSprintPath={nextSprint?.path ?? null}
              nextSprintName={nextSprint?.name ?? null}
              onMoveTask={onMoveTask}
              onCloseTask={onCloseTask}
              onOpenItem={onOpenItem}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

function CloseOutStoryRow({
  story,
  isExpanded,
  onToggle,
  actingOn,
  nextSprintPath,
  nextSprintName,
  onMoveTask,
  onCloseTask,
  onOpenItem,
}: {
  story: ApiCockpitOpenStory;
  isExpanded: boolean;
  onToggle: () => void;
  actingOn: number | null;
  nextSprintPath: string | null;
  nextSprintName: string | null;
  onMoveTask: (task: ApiCockpitOpenTask, nextSprintPath: string) => Promise<void>;
  onCloseTask: (taskId: number, completedHours: number) => Promise<void>;
  onOpenItem?: (id: string) => void;
}) {
  const stateClass = classifyState(story.state);
  const tasksLabel = `${story.doneTaskCount}/${story.totalTaskCount}`;
  return (
    <li className={`plan2-row is-story is-${stateClass} ${isExpanded ? 'is-open' : ''}`}>
      <button
        type="button"
        className="plan2-row-main"
        onClick={onToggle}
        aria-expanded={isExpanded}
      >
        <span className="plan2-chevron" aria-hidden="true">▸</span>
        <KindBadge kind="story" />
        <StateChip state={story.state} />
        <span className="plan2-title">
          <span className="t">{story.title}</span>
          <span className="id">#{story.id}</span>
        </span>
        <span className="plan2-meta">
          <span className="plan2-stat">
            <span className="l">tasks</span>
            <span className="v">{tasksLabel}</span>
          </span>
          {story.effort != null && story.effort > 0 && (
            <span className="plan2-stat is-secondary">
              <span className="l">effort</span>
              <span className="v">{Math.round(story.effort)}h</span>
            </span>
          )}
        </span>
        {story.feature && (
          <span className="plan2-feature">
            {story.feature.title} <span className="id">#{story.feature.id}</span>
          </span>
        )}
      </button>
      {isExpanded && (
        <div className="plan2-children">
          <ul className="plan2-subrows">
            {story.openTasks.length === 0 ? (
              <li className="plan2-subrow-empty">No open tasks — story is waiting on something else.</li>
            ) : (
              story.openTasks.map(task => (
                <CloseOutTaskRow
                  key={task.id}
                  task={task}
                  busy={actingOn === task.id}
                  nextSprintPath={nextSprintPath}
                  nextSprintName={nextSprintName}
                  onMoveTask={onMoveTask}
                  onCloseTask={onCloseTask}
                  onOpenItem={onOpenItem}
                />
              ))
            )}
          </ul>
        </div>
      )}
    </li>
  );
}

function CloseOutTaskRow({
  task,
  busy,
  nextSprintPath,
  nextSprintName,
  onMoveTask,
  onCloseTask,
  onOpenItem,
}: {
  task: ApiCockpitOpenTask;
  busy: boolean;
  nextSprintPath: string | null;
  nextSprintName: string | null;
  onMoveTask: (task: ApiCockpitOpenTask, nextSprintPath: string) => Promise<void>;
  onCloseTask: (taskId: number, completedHours: number) => Promise<void>;
  onOpenItem?: (id: string) => void;
}) {
  const stateClass = classifyState(task.state);
  const rem = task.remainingWork != null ? `${Math.round(task.remainingWork)}h` : '—';
  const remMissing = task.remainingWork == null;
  return (
    <li className={`plan2-subrow plan2-row is-${stateClass}`}>
      <KindBadge kind="task" />
      <StateChip state={task.state} />
      <button
        type="button"
        className="plan2-title plan2-title-btn"
        onClick={() => onOpenItem?.(String(task.id))}
        disabled={!onOpenItem}
        title="Open task details"
      >
        <span className="t">{task.title}</span>
        <span className="id">#{task.id}</span>
      </button>
      <span className="plan2-meta">
        <span className="plan2-stat">
          <span className="l">remaining</span>
          <span className={`v ${remMissing ? 'is-missing' : ''}`}>{rem}</span>
        </span>
      </span>
      <span className="plan2-actions">
        {nextSprintPath ? (
          <button
            type="button"
            className="plan2-act plan2-act-pull"
            disabled={busy}
            onClick={() => {
              if (!window.confirm(`Move "${task.title}" to ${nextSprintName ?? 'next sprint'}?`)) return;
              void onMoveTask(task, nextSprintPath);
            }}
          >
            → {nextSprintName ?? 'next'}
          </button>
        ) : (
          <button type="button" className="plan2-act" disabled title="No next sprint scheduled.">
            → next (n/a)
          </button>
        )}
        <button
          type="button"
          className="plan2-act plan2-act-done"
          disabled={busy}
          onClick={() => {
            const def = task.originalEstimate ?? task.remainingWork ?? null;
            const raw = window.prompt(
              `Mark "${task.title}" done.\nHow many hours did it actually take? Saved to Azure DevOps as Completed.`,
              def != null ? String(def) : '',
            );
            if (raw == null) return; // cancelled
            const hours = Number(raw.trim());
            if (!Number.isFinite(hours) || hours <= 0 || hours > 999) {
              window.alert('Enter the hours it took as a number greater than 0 (max 999).');
              return;
            }
            void onCloseTask(task.id, hours);
          }}
        >
          ✓ done
        </button>
      </span>
    </li>
  );
}

/* -------------------------------------------------------------------------- */
/*  STEP 2 — PULL from backlog                                                */
/* -------------------------------------------------------------------------- */

function PullBacklogSection({
  cockpit,
  actingOn,
  onPullStory,
  onOpenItem,
}: {
  cockpit: CockpitState;
  actingOn: number | null;
  onPullStory: (story: ApiCockpitBacklogStory, nextSprintPath: string) => Promise<void>;
  onOpenItem?: (id: string) => void;
}) {
  if (cockpit.status !== 'ok') return null;
  const { nextSprint, backlogStories } = cockpit.data;
  const nextName = nextSprint?.name ?? 'next sprint';

  if (backlogStories.length === 0) {
    return (
      <section className="plan2-section">
        <SectionHead step={2} title={`Pull into ${nextName}`} note="meter updates as you pull" />
        <div className="plan2-empty">Nothing in your backlog — clean slate.</div>
      </section>
    );
  }

  const groups = [
    { level: 'backlog' as const, label: 'Backlog', stories: backlogStories.filter(s => s.level === 'backlog') },
    { level: 'quarter' as const, label: 'Quarter', stories: backlogStories.filter(s => s.level === 'quarter') },
    { level: 'year' as const, label: 'Year', stories: backlogStories.filter(s => s.level === 'year') },
  ].filter(g => g.stories.length > 0);

  return (
    <section className="plan2-section">
      <SectionHead step={2} title={`Pull into ${nextName}`} note="meter updates as you pull" />
      {groups.map(group => (
        <div key={group.level}>
          <div className="plan2-level">
            <span className="plan2-level-name">{group.label}</span>
            <span className="plan2-level-line" />
            <span className="plan2-level-count">{group.stories.length}</span>
          </div>
          <ul className="plan2-rows">
            {group.stories.map(story => (
              <PullBacklogRow
                key={story.id}
                story={story}
                busy={actingOn === story.id}
                nextSprintPath={nextSprint?.path ?? null}
                nextSprintName={nextSprint?.name ?? null}
                onPull={onPullStory}
                onOpenItem={onOpenItem}
              />
            ))}
          </ul>
        </div>
      ))}
    </section>
  );
}

function PullBacklogRow({
  story,
  busy,
  nextSprintPath,
  nextSprintName,
  onPull,
  onOpenItem,
}: {
  story: ApiCockpitBacklogStory;
  busy: boolean;
  nextSprintPath: string | null;
  nextSprintName: string | null;
  onPull: (story: ApiCockpitBacklogStory, nextSprintPath: string) => Promise<void>;
  onOpenItem?: (id: string) => void;
}) {
  const stateClass = classifyState(story.state);
  const kind = story.type.toLowerCase() === 'bug' ? 'bug' : 'story';
  const points = story.storyPoints;
  const effort = story.effort;
  const pointsMissing = points == null || points === 0;
  const effortMissing = effort == null || effort === 0;

  return (
    <li className={`plan2-row is-${stateClass}`}>
      <div className="plan2-row-main">
        <span className="plan2-chevron is-spacer" aria-hidden="true">▸</span>
        <KindBadge kind={kind} />
        <StateChip state={story.state} />
        <button
          type="button"
          className="plan2-title plan2-title-btn"
          onClick={() => onOpenItem?.(String(story.id))}
          disabled={!onOpenItem}
          title="Open story details"
        >
          <span className="t">{story.title}</span>
          <span className="id">#{story.id}</span>
        </button>
        <span className="plan2-meta">
          <span className="plan2-stat">
            <span className="l">points</span>
            <span className={`v ${pointsMissing ? 'is-missing' : ''}`}>{pointsMissing ? '—' : points}</span>
          </span>
          <span className="plan2-stat is-secondary">
            <span className="l">effort</span>
            <span className={`v ${effortMissing ? 'is-missing' : ''}`}>{effortMissing ? '—' : `${Math.round(effort!)}h`}</span>
          </span>
        </span>
        {story.feature && (
          <span className="plan2-feature">
            {story.feature.title} <span className="id">#{story.feature.id}</span>
          </span>
        )}
        <span className="plan2-actions">
          {nextSprintPath ? (
            <button
              type="button"
              className="plan2-act plan2-act-pull"
              disabled={busy}
              onClick={() => {
                if (!window.confirm(`Pull "${story.title}" into ${nextSprintName ?? 'next sprint'}?`)) return;
                void onPull(story, nextSprintPath);
              }}
            >
              → {nextSprintName ?? 'next'}
            </button>
          ) : (
            <button type="button" className="plan2-act" disabled title="No next sprint scheduled.">
              → next (n/a)
            </button>
          )}
        </span>
      </div>
    </li>
  );
}

/* -------------------------------------------------------------------------- */
/*  STEP 3 — SANITY CHECK (gaps + prompt panel)                                */
/* -------------------------------------------------------------------------- */

function SanityCheckSection({ onScanComplete }: { onScanComplete?: (n: number) => void }) {
  const [state, setState] = useState<ScanState>(() => {
    const persisted = readPersistedScan();
    return persisted ? { status: 'ok', data: persisted } : { status: 'idle' };
  });
  const [copied, setCopied] = useState(false);

  const runScan = async () => {
    setState({ status: 'loading' });
    try {
      const data = await fetchPlanningGaps();
      setState({ status: 'ok', data });
      writePersistedScan(data);
      onScanComplete?.(data.totalGaps);
    } catch (err) {
      setState({ status: 'error', error: err instanceof Error ? err.message : 'unknown error' });
    }
  };

  const onClear = () => {
    clearPersistedScan();
    setState({ status: 'idle' });
    setCopied(false);
  };

  useEffect(() => {
    if (state.status !== 'ok' || !copied) return;
    const t = setTimeout(() => setCopied(false), 2200);
    return () => clearTimeout(t);
  }, [copied, state.status]);

  const onCopy = async () => {
    if (state.status !== 'ok') return;
    try {
      await navigator.clipboard.writeText(state.data.prompt);
      setCopied(true);
    } catch {
      const pre = document.getElementById('plan2-prompt-pre');
      if (pre) {
        const range = document.createRange();
        range.selectNodeContents(pre);
        const sel = window.getSelection();
        sel?.removeAllRanges();
        sel?.addRange(range);
      }
    }
  };

  const total = state.status === 'ok' ? state.data.totalGaps : null;

  return (
    <section className="plan2-section">
      <div className="plan2-sec-head">
        <span className="plan2-step">3</span>
        <h2 className="plan2-sec-title">
          Sanity-check estimates
          {total != null && total > 0 && <span className="plan2-badge">{total}</span>}
        </h2>
        <button
          className="plan2-scan"
          onClick={runScan}
          disabled={state.status === 'loading'}
        >
          {state.status === 'loading' ? 'Scanning…' : 'Scan for gaps'}
        </button>
      </div>
      <p className="plan2-gap-intro">
        Sprint items missing an estimate. The dashboard finds them; the conversation in Claude Code fills them in.
      </p>

      {state.status === 'error' && (
        <div className="plan2-error" role="alert">
          Couldn't load the gap list — {state.error}.
          <button onClick={runScan}>Try again</button>
        </div>
      )}

      {state.status === 'ok' && state.data.totalGaps === 0 && (
        <div className="plan2-empty">
          Every Task and Story in the current sprint has its planning fields filled in.
          <button className="plan2-prompt-btn" onClick={onClear} style={{ marginLeft: 12 }}>Clear scan</button>
        </div>
      )}

      {state.status === 'ok' && state.data.totalGaps > 0 && (
        <>
          <GapGroups gaps={state.data.gaps} />
          <section className="plan2-prompt" aria-label="Generated prompt for Claude Code">
            <header className="plan2-prompt-head">
              <span className="plan2-prompt-cap">Prompt for Claude Code</span>
              <div className="plan2-prompt-actions">
                <button className="plan2-prompt-btn is-primary" onClick={onCopy}>
                  {copied ? 'Copied ✓' : 'Copy'}
                </button>
                <button className="plan2-prompt-btn" onClick={onClear} title="Clear the saved scan — next scan starts fresh">
                  Clear
                </button>
              </div>
            </header>
            <pre id="plan2-prompt-pre" className="plan2-prompt-pre">{state.data.prompt}</pre>
            <p className="plan2-prompt-hint">
              Stays here until you clear it — copy the prompt, hand it over, come back to verify.
            </p>
          </section>
        </>
      )}
    </section>
  );
}

function GapGroups({ gaps }: { gaps: ApiPlanningGap[] }) {
  const groups = new Map<string, { label: string; featureId: number | null; gaps: ApiPlanningGap[] }>();
  for (const g of gaps) {
    const featureId = g.kind === 'story' ? g.feature?.workItemId ?? null : g.parent?.workItemId ?? null;
    const label = g.kind === 'story'
      ? (g.feature?.title ?? 'Stories (no feature)')
      : (g.parent?.title ?? 'Tasks (no parent story)');
    const key = `${label}#${featureId ?? 'none'}`;
    const bucket = groups.get(key) ?? { label, featureId, gaps: [] };
    bucket.gaps.push(g);
    groups.set(key, bucket);
  }
  return (
    <>
      {[...groups.values()].map(group => (
        <div className="plan2-gap-group" key={`${group.label}-${group.featureId ?? 'none'}`}>
          <h3 className="plan2-gap-group-h">
            {group.label}
            {group.featureId != null && <> <span className="id">#{group.featureId}</span></>}
          </h3>
          <ul className="plan2-gaps">
            {group.gaps.map(g => (
              <li className="plan2-gap" key={`${g.kind}-${g.workItemId}`}>
                <div className="plan2-gap-top">
                  <span className={`plan2-gap-kind k-${g.kind}`}>{g.kind}</span>
                  <span className="plan2-gap-name">
                    {g.title} <span className="id">#{g.workItemId}</span>
                  </span>
                </div>
                <div className="plan2-gap-missing">
                  Missing <b>{g.missing.join(', ')}</b>
                </div>
                <div className={`plan2-gap-anchor ${g.anchor.isColdStart ? 'is-cold' : ''}`}>
                  {g.anchor.summary}
                </div>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </>
  );
}

/* -------------------------------------------------------------------------- */
/*  Small helpers                                                              */
/* -------------------------------------------------------------------------- */

function SectionHead({ step, title, note }: { step: number; title: string; note?: React.ReactNode }) {
  return (
    <div className="plan2-sec-head">
      <span className="plan2-step">{step}</span>
      <h2 className="plan2-sec-title">{title}</h2>
      {note && <span className="plan2-sec-note">{note}</span>}
    </div>
  );
}

function StateChip({ state }: { state: string }) {
  return <span className="plan2-state">{state}</span>;
}

function KindBadge({ kind }: { kind: 'story' | 'task' | 'bug' }) {
  if (kind === 'task') {
    return (
      <span className="plan2-kind k-task" title="Task">
        <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.2" aria-hidden="true">
          <rect x="2.5" y="2.5" width="9" height="9" rx="2" />
          <path d="M4.6 7.2l1.6 1.6 3-3.4" />
        </svg>
        Task
      </span>
    );
  }
  if (kind === 'bug') {
    return (
      <span className="plan2-kind k-bug" title="Bug">
        <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.2" aria-hidden="true">
          <ellipse cx="7" cy="7.8" rx="2.8" ry="3.2" />
          <line x1="7" y1="4.6" x2="7" y2="7" />
          <line x1="4.3" y1="3.6" x2="5.4" y2="5" />
          <line x1="9.7" y1="3.6" x2="8.6" y2="5" />
          <line x1="3.9" y1="7.4" x2="2.4" y2="7" />
          <line x1="10.1" y1="7.4" x2="11.6" y2="7" />
          <line x1="3.9" y1="9.4" x2="2.6" y2="10.4" />
          <line x1="10.1" y1="9.4" x2="11.4" y2="10.4" />
        </svg>
        Bug
      </span>
    );
  }
  return (
    <span className="plan2-kind k-story" title="User Story">
      <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.2" aria-hidden="true">
        <rect x="2.2" y="2.5" width="9.6" height="9" rx="1.5" />
        <line x1="4.4" y1="5.4" x2="9.6" y2="5.4" />
        <line x1="4.4" y1="7.6" x2="8.2" y2="7.6" />
      </svg>
      Story
    </span>
  );
}

function classifyState(state: string): 'going' | 'waiting' | 'done' | 'blocked' {
  const s = state.toLowerCase();
  if (s === 'blocked' || s === 'on hold') return 'blocked';
  if (['active', 'in progress', 'doing', 'committed'].includes(s)) return 'going';
  if (['done', 'closed', 'resolved', 'completed', 'removed'].includes(s)) return 'done';
  return 'waiting';
}
