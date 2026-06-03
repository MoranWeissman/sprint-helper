// src/components/PlanView.tsx
import { useEffect, useState } from 'react';
import {
  fetchCockpit,
  fetchPlanningGaps,
  markWorkItemDone,
  moveWorkItemToIteration,
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
  /** Called when the gap list contains items SH itself created (for the retro hook later). */
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
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(data));
  } catch {
    /* fail silently */
  }
}

function clearPersistedScan(): void {
  try {
    localStorage.removeItem(LS_KEY);
  } catch {
    /* ignore */
  }
}

/**
 * Plan mode — the planning ceremony cockpit.
 *
 * Layout:
 *   - Header: current sprint → next sprint
 *   - Open stories in the current sprint, each with its not-done child tasks
 *     and per-task move/close actions
 *   - Pull from backlog (year / quarter / Backlog stories)  [coming next]
 *   - New story creation  [coming next]
 *   - Gaps (sanity check) — the existing gap scanner, collapsed by default,
 *     with a persistent prompt panel
 */
export function PlanView({ onScanComplete }: PlanViewProps) {
  const [cockpit, setCockpit] = useState<CockpitState>({ status: 'loading' });
  const [actingOn, setActingOn] = useState<number | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const refreshCockpit = async () => {
    setCockpit({ status: 'loading' });
    try {
      const data = await fetchCockpit();
      setCockpit({ status: 'ok', data });
    } catch (err) {
      setCockpit({ status: 'error', error: err instanceof Error ? err.message : 'unknown error' });
    }
  };

  useEffect(() => {
    void refreshCockpit();
  }, []);

  const onMoveTask = async (taskId: number, nextSprintPath: string) => {
    setActingOn(taskId);
    setActionError(null);
    try {
      await moveWorkItemToIteration(taskId, nextSprintPath);
      await refreshCockpit();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Move failed');
    } finally {
      setActingOn(null);
    }
  };

  const onCloseTask = async (taskId: number) => {
    setActingOn(taskId);
    setActionError(null);
    try {
      await markWorkItemDone(taskId);
      await refreshCockpit();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Close failed');
    } finally {
      setActingOn(null);
    }
  };

  const onPullBacklog = async (storyId: number, nextSprintPath: string) => {
    setActingOn(storyId);
    setActionError(null);
    try {
      await moveWorkItemToIteration(storyId, nextSprintPath);
      await refreshCockpit();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Pull failed');
    } finally {
      setActingOn(null);
    }
  };

  return (
    <div className="r12-plan">
      <CockpitHeader cockpit={cockpit} />

      {actionError && (
        <div className="r12-plan-error" role="alert">
          {actionError} <button onClick={() => setActionError(null)}>dismiss</button>
        </div>
      )}

      <CockpitOpenStoriesSection
        cockpit={cockpit}
        actingOn={actingOn}
        onMoveTask={onMoveTask}
        onCloseTask={onCloseTask}
      />

      <CockpitBacklogSection
        cockpit={cockpit}
        actingOn={actingOn}
        onPullStory={onPullBacklog}
      />

      <GapSection onScanComplete={onScanComplete} />
    </div>
  );
}

function CockpitHeader({ cockpit }: { cockpit: CockpitState }) {
  if (cockpit.status !== 'ok') {
    return (
      <div className="r12-cockpit-head">
        <h2 className="r12-plan-h">Plan</h2>
        <p className="r12-cockpit-sub">
          {cockpit.status === 'loading' ? 'Loading…' : cockpit.status === 'error' ? `Couldn't load — ${cockpit.error}` : ''}
        </p>
      </div>
    );
  }
  const { currentSprint, nextSprint } = cockpit.data;
  return (
    <div className="r12-cockpit-head">
      <h2 className="r12-plan-h">Plan</h2>
      <p className="r12-cockpit-sub">
        {currentSprint ? <>current: <strong>{currentSprint.name}</strong></> : <>no current sprint</>}
        {nextSprint ? <> · next: <strong>{nextSprint.name}</strong></> : <> · no next sprint scheduled</>}
      </p>
    </div>
  );
}

function CockpitOpenStoriesSection({
  cockpit,
  actingOn,
  onMoveTask,
  onCloseTask,
}: {
  cockpit: CockpitState;
  actingOn: number | null;
  onMoveTask: (taskId: number, nextSprintPath: string) => Promise<void>;
  onCloseTask: (taskId: number) => Promise<void>;
}) {
  if (cockpit.status !== 'ok') return null;
  const { currentSprint, nextSprint, openStories } = cockpit.data;
  if (openStories.length === 0) {
    return (
      <section className="r12-cockpit-section">
        <h3 className="r12-cockpit-h">Open stories in {currentSprint?.name ?? 'current sprint'}</h3>
        <div className="r12-cockpit-empty">Nothing open — everything in this sprint is done.</div>
      </section>
    );
  }
  return (
    <section className="r12-cockpit-section">
      <h3 className="r12-cockpit-h">Open stories in {currentSprint?.name ?? 'current sprint'}</h3>
      <ul className="r12-cockpit-stories">
        {openStories.map(s => (
          <CockpitOpenStoryCard
            key={s.id}
            story={s}
            nextSprintPath={nextSprint?.path ?? null}
            nextSprintName={nextSprint?.name ?? null}
            actingOn={actingOn}
            onMoveTask={onMoveTask}
            onCloseTask={onCloseTask}
          />
        ))}
      </ul>
    </section>
  );
}

function CockpitOpenStoryCard({
  story,
  nextSprintPath,
  nextSprintName,
  actingOn,
  onMoveTask,
  onCloseTask,
}: {
  story: ApiCockpitOpenStory;
  nextSprintPath: string | null;
  nextSprintName: string | null;
  actingOn: number | null;
  onMoveTask: (taskId: number, nextSprintPath: string) => Promise<void>;
  onCloseTask: (taskId: number) => Promise<void>;
}) {
  return (
    <li className="r12-cockpit-story">
      <div className="r12-cockpit-story-head">
        <span className="r12-cockpit-story-title" dangerouslySetInnerHTML={{ __html: linkifyDisplayName(story.displayName) }} />
        <span className="r12-cockpit-story-meta">
          {story.doneTaskCount}/{story.totalTaskCount} tasks done
          {story.effort != null && story.effort > 0 ? ` · ${Math.round(story.effort)}h planned` : ''}
        </span>
        {story.feature && (
          <span className="r12-cockpit-story-feature" dangerouslySetInnerHTML={{ __html: linkifyDisplayName(story.feature.displayName) }} />
        )}
      </div>
      {story.openTasks.length === 0 ? (
        <div className="r12-cockpit-no-open-tasks">No open tasks — story is waiting on something else.</div>
      ) : (
        <ul className="r12-cockpit-tasks">
          {story.openTasks.map(t => (
            <CockpitOpenTaskRow
              key={t.id}
              task={t}
              nextSprintPath={nextSprintPath}
              nextSprintName={nextSprintName}
              busy={actingOn === t.id}
              onMove={onMoveTask}
              onClose={onCloseTask}
            />
          ))}
        </ul>
      )}
    </li>
  );
}

function CockpitOpenTaskRow({
  task,
  nextSprintPath,
  nextSprintName,
  busy,
  onMove,
  onClose,
}: {
  task: ApiCockpitOpenTask;
  nextSprintPath: string | null;
  nextSprintName: string | null;
  busy: boolean;
  onMove: (taskId: number, nextSprintPath: string) => Promise<void>;
  onClose: (taskId: number) => Promise<void>;
}) {
  const stateClass = `is-${classifyState(task.state)}`;
  return (
    <li className={`r12-cockpit-task ${stateClass}`}>
      <span className="r12-cockpit-task-state">{task.state}</span>
      <span className="r12-cockpit-task-title" dangerouslySetInnerHTML={{ __html: linkifyDisplayName(task.displayName) }} />
      <span className="r12-cockpit-task-hours">
        {task.remainingWork != null ? `${Math.round(task.remainingWork)}h left` : '—'}
      </span>
      <span className="r12-cockpit-task-actions">
        {nextSprintPath ? (
          <button
            type="button"
            className="r12-cockpit-act r12-cockpit-act-move"
            disabled={busy}
            onClick={() => {
              if (!window.confirm(`Move "${task.title}" to ${nextSprintName ?? 'next sprint'}?`)) return;
              void onMove(task.id, nextSprintPath);
            }}
          >
            → {nextSprintName ?? 'next'}
          </button>
        ) : (
          <span className="r12-cockpit-act-disabled" title="No next sprint scheduled — create one in Azure DevOps first.">
            → next (n/a)
          </span>
        )}
        <button
          type="button"
          className="r12-cockpit-act r12-cockpit-act-done"
          disabled={busy}
          onClick={() => {
            if (!window.confirm(`Mark "${task.title}" done? This closes it in Azure DevOps.`)) return;
            void onClose(task.id);
          }}
        >
          ✓ done
        </button>
      </span>
    </li>
  );
}

function CockpitBacklogSection({
  cockpit,
  actingOn,
  onPullStory,
}: {
  cockpit: CockpitState;
  actingOn: number | null;
  onPullStory: (storyId: number, nextSprintPath: string) => Promise<void>;
}) {
  if (cockpit.status !== 'ok') return null;
  const { nextSprint, backlogStories } = cockpit.data;
  if (backlogStories.length === 0) {
    return (
      <section className="r12-cockpit-section">
        <h3 className="r12-cockpit-h">Pull from backlog</h3>
        <div className="r12-cockpit-empty">Nothing in backlog assigned to you — clean slate.</div>
      </section>
    );
  }
  // Group by level (backlog literal first, then quarter, then year).
  const groups = [
    { level: 'backlog' as const, label: 'Backlog', stories: backlogStories.filter(s => s.level === 'backlog') },
    { level: 'quarter' as const, label: 'Quarter', stories: backlogStories.filter(s => s.level === 'quarter') },
    { level: 'year' as const, label: 'Year', stories: backlogStories.filter(s => s.level === 'year') },
  ].filter(g => g.stories.length > 0);
  return (
    <section className="r12-cockpit-section">
      <h3 className="r12-cockpit-h">Pull from backlog</h3>
      {groups.map(group => (
        <div key={group.level} className="r12-cockpit-backlog-group">
          <h4 className="r12-cockpit-backlog-level">{group.label} ({group.stories.length})</h4>
          <ul className="r12-cockpit-backlog-list">
            {group.stories.map(s => (
              <li key={s.id} className="r12-cockpit-backlog-row">
                <span className="r12-cockpit-backlog-title" dangerouslySetInnerHTML={{ __html: linkifyDisplayName(s.displayName) }} />
                <span className="r12-cockpit-backlog-meta">
                  {s.storyPoints != null && s.storyPoints > 0 ? `${s.storyPoints} SP · ` : ''}
                  {s.effort != null && s.effort > 0 ? `${Math.round(s.effort)}h effort` : 'no effort yet'}
                </span>
                <span className="r12-cockpit-backlog-iter" title={s.iterationPath}>
                  {lastIterSegment(s.iterationPath)}
                </span>
                <span className="r12-cockpit-task-actions">
                  {nextSprint ? (
                    <button
                      type="button"
                      className="r12-cockpit-act r12-cockpit-act-move"
                      disabled={actingOn === s.id}
                      onClick={() => {
                        if (!window.confirm(`Pull "${s.title}" into ${nextSprint.name}?`)) return;
                        void onPullStory(s.id, nextSprint.path);
                      }}
                    >
                      → {nextSprint.name}
                    </button>
                  ) : (
                    <span className="r12-cockpit-act-disabled" title="No next sprint scheduled.">
                      → next (n/a)
                    </span>
                  )}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </section>
  );
}

function lastIterSegment(path: string): string {
  const parts = path.split('\\').filter(Boolean);
  return parts.length === 0 ? path : parts[parts.length - 1];
}

function classifyState(state: string): 'going' | 'waiting' | 'done' | 'blocked' {
  const s = state.toLowerCase();
  if (s === 'blocked' || s === 'on hold') return 'blocked';
  if (['active', 'in progress', 'doing', 'committed'].includes(s)) return 'going';
  if (['done', 'closed', 'resolved', 'completed'].includes(s)) return 'done';
  return 'waiting';
}

/* -------------------------------------------------------------------------- */
/*  Gap section (sanity check) — persistent prompt panel from prior commit    */
/* -------------------------------------------------------------------------- */

function GapSection({ onScanComplete }: { onScanComplete?: (n: number) => void }) {
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
    if (state.status !== 'ok') return;
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 2200);
    return () => clearTimeout(t);
  }, [copied, state.status]);

  const onCopy = async () => {
    if (state.status !== 'ok') return;
    try {
      await navigator.clipboard.writeText(state.data.prompt);
      setCopied(true);
    } catch {
      const pre = document.getElementById('r12-plan-prompt-pre');
      if (pre) {
        const range = document.createRange();
        range.selectNodeContents(pre);
        const sel = window.getSelection();
        sel?.removeAllRanges();
        sel?.addRange(range);
      }
    }
  };

  return (
    <details className="r12-cockpit-section r12-cockpit-gap-wrap" open={state.status === 'ok' && state.data.totalGaps > 0}>
      <summary className="r12-cockpit-h r12-cockpit-gap-summary">
        Gaps (sanity check)
        {state.status === 'ok' && state.data.totalGaps > 0 && (
          <span className="r12-cockpit-gap-badge">{state.data.totalGaps}</span>
        )}
      </summary>
      <div className="r12-cockpit-gap-body">
        <p className="r12-cockpit-gap-intro">
          Find sprint items that don't have an estimate yet. The dashboard discovers them; the
          conversation in Claude Code fills them in.
        </p>
        <button className="r12-plan-scan" onClick={runScan} disabled={state.status === 'loading'}>
          {state.status === 'loading' ? 'Scanning…' : 'Scan for gaps'}
        </button>

        {state.status === 'error' && (
          <div className="r12-plan-error" role="alert">
            Couldn't load the gap list — {state.error}. <button onClick={runScan}>Try again</button>
          </div>
        )}

        {state.status === 'ok' && state.data.totalGaps === 0 && (
          <div className="r12-plan-empty">
            Every Task and Story in the current sprint has its planning fields filled in. Nothing to do here.
            <button className="r12-plan-clear-inline" onClick={onClear}>Clear scan</button>
          </div>
        )}

        {state.status === 'ok' && state.data.totalGaps > 0 && (
          <>
            <div className="r12-plan-actions">
              <span className="r12-plan-count">
                {state.data.totalGaps} {state.data.totalGaps === 1 ? 'item' : 'items'} need effort
              </span>
            </div>

            <GapList gaps={state.data.gaps} />

            <section className="r12-plan-prompt-panel" aria-label="Generated prompt for Claude Code">
              <header className="r12-plan-prompt-head">
                <span className="r12-plan-prompt-cap">Prompt for Claude Code</span>
                <div className="r12-plan-prompt-actions">
                  <button className="r12-plan-copy" onClick={onCopy}>
                    {copied ? 'Copied ✓' : 'Copy'}
                  </button>
                  <button className="r12-plan-clear" onClick={onClear} title="Clear the saved scan — next scan will start fresh">
                    Clear
                  </button>
                </div>
              </header>
              <pre id="r12-plan-prompt-pre" className="r12-plan-prompt">{state.data.prompt}</pre>
              <p className="r12-plan-prompt-hint">
                This panel stays here until you clear it — copy the prompt, hand it to a chat,
                come back later to verify.
              </p>
            </section>
          </>
        )}
      </div>
    </details>
  );
}

function GapList({ gaps }: { gaps: ApiPlanningGap[] }) {
  const groups = new Map<string, { label: string; gaps: ApiPlanningGap[] }>();
  for (const g of gaps) {
    const key = g.kind === 'story'
      ? (g.feature?.displayName ?? 'Stories (no feature)')
      : (g.parent?.displayName ?? 'Tasks (no parent story)');
    const bucket = groups.get(key) ?? { label: key, gaps: [] };
    bucket.gaps.push(g);
    groups.set(key, bucket);
  }
  return (
    <div className="r12-plan-groups">
      {[...groups.values()].map(group => (
        <section className="r12-plan-group" key={group.label}>
          <h3 className="r12-plan-group-h" dangerouslySetInnerHTML={{ __html: linkifyDisplayName(group.label) }} />
          <ul className="r12-plan-gaps">
            {group.gaps.map(g => (
              <li className="r12-plan-gap" key={`${g.kind}-${g.workItemId}`}>
                <div className="r12-plan-gap-head">
                  <span className={`r12-plan-kind r12-plan-kind-${g.kind}`}>{g.kind}</span>
                  <span className="r12-plan-gap-name" dangerouslySetInnerHTML={{ __html: linkifyDisplayName(g.displayName) }} />
                </div>
                <div className="r12-plan-gap-missing">
                  Missing: {g.missing.join(', ')}
                </div>
                <div className={`r12-plan-anchor ${g.anchor.isColdStart ? 'is-cold' : ''}`}>
                  {g.anchor.summary}
                </div>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

function linkifyDisplayName(s: string): string {
  let out = s.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/\(#(\d+)\)/g, '<span class="r12-id">#$1</span>');
  return out;
}
