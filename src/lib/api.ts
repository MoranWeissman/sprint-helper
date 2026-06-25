import { useEffect, useRef, useState } from 'react';

// Mirrors server/dashboard.ts → DashboardPayload exactly. Keep in sync manually
// until we extract a shared types package.
export interface ApiParent {
  id: string;
  title: string;
  type: string;
  state: string;
  url: string;
}

export type SessionEventType = 'focus' | 'progress' | 'blocker' | 'decision' | 'note';

export interface ApiSessionEvent {
  id: number;
  sessionId: string;
  workItemId: number;
  type: SessionEventType;
  text: string;
  createdAt: string;
}

export interface ApiActiveSession {
  id: string;
  startedAt: string;
}

export interface ApiHelperNote {
  id: number;
  body: string;
  createdAt: string;
  pinnedAt: string | null;
  workItemId: number | null;
}

export interface ApiHelperNotes {
  notes: ApiHelperNote[];
}

/** Outlook-calendar derived capacity for the current sprint. */
export interface ApiOutlookCapacity {
  sprintStart: string;
  sprintEnd: string;
  workingDays: number;
  workingDaysRemaining: number;
  workdayHours: number;
  workingHoursTotal: number;
  /** Working hours left from today on (workingDaysRemaining × workdayHours). */
  workingHoursRemaining: number;
  meetingHours: { busy: number; tentative: number; oof: number; weighted: number };
  availableHours: number;
  /** Real desk time still ahead — counts down as the sprint progresses. */
  availableHoursRemaining: number;
  plannedHours: number;
  /** plannedHours - availableHours. Positive = planned over capacity. */
  difference: number;
  /** False when no calendar URL is configured. */
  hasUrl: boolean;
  /** Non-empty when the ICS fetch failed. */
  fetchError?: string;
}

export interface ApiWorkItem {
  id: string;
  title: string;
  type: string;
  state: string;
  story: string;
  parent?: ApiParent;
  originalEstimate?: number;
  remainingWork?: number;
  completedWork?: number;
  descriptionPreview?: string;
  area?: string;
  /** Seconds tracked locally that ADO doesn't know about yet. */
  localUncapturedSeconds: number;
  /** Total seconds the timer ran across ALL sittings — the "LOGGED" value. */
  localLoggedSeconds: number;
  /** ISO timestamp of the currently-running timer's start, if any. */
  runningSince?: string;
  /** Live Claude Code session against this item, if one is open right now. */
  activeSession?: ApiActiveSession;
  /** Newest-first session events reported by Claude Code via MCP. */
  recentActivity: ApiSessionEvent[];
  /** Number of work sessions (open or closed) recorded against this item. */
  sessionCount: number;
  /** Parsed System.Tags. Contains "Blocked" when this task itself is tagged blocked. */
  tags?: string[];
  /** Parent story's tags — surfaced so a task can show its parent story is blocked. */
  parentTags?: string[];
  /** True when sprint-helper itself created this item via MCP. Local-only. */
  wasSHCreated?: boolean;
  url: string;
}

export interface ApiSprint {
  id: string;
  name: string;
  path: string;
  startDate: string;
  finishDate: string;
  totalDays: number;
}

export interface ApiSprintOption {
  id: string;
  name: string;
  path: string;
  startDate: string;
  finishDate: string;
  isCurrent: boolean;
}

export interface ApiUserStoryGroup {
  id: string;
  title: string;
  type: string;
  state: string;
  url: string;
  descriptionPreview?: string;
  area?: string;
  parentEstimate?: number;
  parentRemaining?: number;
  /** Story-level planning fields the POM delivery manager watches. */
  storyPoints?: number;
  effort?: number;
  /** The Feature / Epic above this story, if any. The Daily view groups by this. */
  feature?: { id: string; title: string; type: string };
  tasks: ApiWorkItem[];
  totalEstimateHours: number;
  completedHours: number;
  remainingHours: number;
  counts: { inProgress: number; upNext: number; done: number };
  /** Newest-first session events rolled up across child tasks. Capped at 5. */
  recentActivity: ApiSessionEvent[];
  /** True if any child task has a live Claude Code session right now. */
  hasActiveSession: boolean;
  /** Parsed System.Tags on the story. Contains "Blocked" when tagged blocked. */
  tags?: string[];
  /** True when sprint-helper itself created this story via MCP. Local-only. */
  wasSHCreated?: boolean;
}

export type CeremonyId = 'daily' | 'preplan' | 'plan' | 'demo' | 'retro';
export type ModeId = 'day' | 'preplan' | 'plan' | 'demo' | 'retro';

export interface ApiUpcomingCeremony {
  id: CeremonyId;
  label: string;
  startsAt: string;        // ISO
  minutesUntil: number;
  isSuggested: boolean;
}

export interface ApiStandupTask {
  workItemId: number;
  title: string;
  /** Raw ADO state ("Active" / "Blocked" / "Done" / etc.). */
  adoState: string;
}

export interface ApiStandupEntry {
  /** The story this row is about. (Sessions on Tasks roll up to their parent Story.) */
  workItemId: number;
  /** Pre-formatted `**title** (#id)` ready to echo. */
  displayName: string;
  summary: string | null;
  minutesInWindow: number | null;
  state: 'live' | 'paused' | 'closed';
  /** The story's real Azure DevOps state — drives the status pill. */
  storyState?: string;
  /** Tasks under this story that had session activity in the window. */
  tasks: ApiStandupTask[];
}

export interface ApiStandupBlock {
  yesterdayDate: string;
  todayDate: string;
  yesterday: ApiStandupEntry[];
  today: ApiStandupEntry[];
}

export interface ApiPayload {
  user: string;
  sprint: ApiSprint | null;
  sprintOptions: ApiSprintOption[];
  workItems: {
    inProgress: ApiWorkItem[];
    upNext: ApiWorkItem[];
    done: ApiWorkItem[];
  };
  userStories: ApiUserStoryGroup[];
  capacity: {
    remainingHours: number;
    completedHours: number;
    totalEstimateHours: number;
  };
  /** Outlook-calendar derived capacity, null when there's no sprint. */
  outlookCapacity: ApiOutlookCapacity | null;
  pendingChanges: number;
  /** Number of live Claude Code sessions reporting in right now. */
  activeSessions: number;
  /** The assistant's read on the sprint: a living summary + a few open nudges. */
  helperNotes: ApiHelperNotes;
  /** What got worked yesterday + what's open today, for the morning standup. */
  standup: ApiStandupBlock;
  /** Unfinished tasks left behind in a previous sprint, offered to pull in. Null when none. */
  carryForward: {
    taskIds: number[];
    tasks: { id: number; title: string }[];
    count: number;
    fromSprintLabel: string;
  } | null;
  ceremonies: {
    upcoming: ApiUpcomingCeremony[];
    next: ApiUpcomingCeremony | null;
    suggestedModeId: ModeId | null;
  };
  fetchedAt: string;
}

/** Schedule API — same vocabulary as the mode ids, with `daily` for the Daily event. */
export type CeremonyRecurrence =
  | { kind: 'weekdays'; time: string }
  | { kind: 'sprint_relative'; weekOfSprint: 1 | 2; dayOfWeek: number; time: string };

export interface CeremonyConfig {
  id: CeremonyId;
  label: string;
  enabled: boolean;
  recurrence: CeremonyRecurrence;
}

export interface CeremonySchedule {
  version: 1;
  ceremonies: CeremonyConfig[];
}

export async function getSchedule(): Promise<CeremonySchedule> {
  const r = await fetch('/api/schedule', { cache: 'no-store' });
  const body = await r.json();
  if (!r.ok || 'error' in body) throw new Error(body.error ?? 'Could not load schedule');
  return body as CeremonySchedule;
}

export async function putSchedule(schedule: CeremonySchedule): Promise<CeremonySchedule> {
  const r = await fetch('/api/schedule', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(schedule),
  });
  const body = await r.json();
  if (!r.ok || 'error' in body) throw new Error(body.error ?? 'Could not save schedule');
  return body as CeremonySchedule;
}

export interface ApiError {
  error: string;
  command?: string;
}

export type FetchState =
  | { status: 'loading' }
  | { status: 'ok'; data: ApiPayload }
  | { status: 'error'; error: string; command?: string };

// How often the live board re-fetches on its own. Tuned for "feels live"
// without hammering: the read is served from the server's cache.
const DASHBOARD_AUTO_REFRESH_MS = 15_000;

export function useDashboardData(sprintName?: string): { state: FetchState; refresh: () => void } {
  const [state, setState] = useState<FetchState>({ status: 'loading' });
  const [nonce, setNonce] = useState(0);
  // True once we've scheduled a follow-up refetch for the current stale chain,
  // so a chain of stale responses can't spin into an infinite refetch loop.
  const staleRetryRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    // Keep the rendered dashboard while a refresh is in flight; only flash the
    // loading shell on the initial mount or after an error.
    setState(prev => (prev.status === 'ok' ? prev : { status: 'loading' }));
    const url = sprintName
      ? `/api/dashboard?sprint=${encodeURIComponent(sprintName)}`
      : '/api/dashboard';
    fetch(url, { cache: 'no-store' })
      .then(async r => {
        const body = (await r.json()) as ApiPayload | ApiError;
        const stale = r.headers.get('X-Cache') === 'stale';
        if (cancelled) return;
        if ('error' in body) {
          setState({ status: 'error', error: body.error, command: body.command });
          return;
        }
        setState({ status: 'ok', data: body });
        if (stale) {
          // The server is refreshing in the background — pick up the fresh
          // data after it lands. Only retry once per stale chain.
          if (!staleRetryRef.current) {
            staleRetryRef.current = true;
            retryTimer = setTimeout(() => {
              if (!cancelled) setNonce(n => n + 1);
            }, 3000);
          }
        } else {
          staleRetryRef.current = false;
        }
      })
      .catch(err => {
        if (cancelled) return;
        setState({ status: 'error', error: err instanceof Error ? err.message : String(err) });
      });
    return () => {
      cancelled = true;
      if (retryTimer) clearTimeout(retryTimer);
    };
  }, [nonce, sprintName]);

  // Quiet auto-refresh so the live board (Daily + Focus) keeps itself current
  // without a manual reload. Reads the server's short-lived cache, so it's
  // cheap. Pauses while the tab is hidden, and refreshes once on return so a
  // tab you come back to is never stale.
  useEffect(() => {
    const tick = () => {
      if (typeof document !== 'undefined' && document.hidden) return;
      setNonce(n => n + 1);
    };
    const id = setInterval(tick, DASHBOARD_AUTO_REFRESH_MS);
    const onVisible = () => {
      if (typeof document !== 'undefined' && !document.hidden) setNonce(n => n + 1);
    };
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', onVisible);
    }
    return () => {
      clearInterval(id);
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', onVisible);
      }
    };
  }, []);

  return { state, refresh: () => setNonce(n => n + 1) };
}

/* -------------------------------------------------------------------------- */
/*  Work item detail                                                          */
/* -------------------------------------------------------------------------- */

export interface ApiWorkItemRef {
  id: number;
  title: string;
  type: string;
  state: string;
  url: string;
  rel?: string;
}

export interface ApiWorkItemDetail {
  id: number;
  rev: number;
  type: string;
  title: string;
  state: string;
  assignedTo?: string;
  iterationPath: string;
  areaPath: string;
  description?: string;
  acceptanceCriteria?: string;
  reproSteps?: string;
  tags?: string;
  priority?: number;
  createdDate: string;
  createdBy?: string;
  changedDate: string;
  changedBy?: string;
  originalEstimate?: number;
  remainingWork?: number;
  completedWork?: number;
  parent?: ApiWorkItemRef;
  children: ApiWorkItemRef[];
  related: ApiWorkItemRef[];
  webUrl: string;
}

export interface ApiWorkItemComment {
  id: number;
  text: string;
  createdBy?: string;
  createdDate: string;
}

export interface ApiWorkItemDetailResponse {
  item: ApiWorkItemDetail;
  comments: ApiWorkItemComment[];
}

export type WorkItemFetchState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ok'; data: ApiWorkItemDetailResponse }
  | { status: 'error'; error: string };

export function useWorkItem(id: string | null): { state: WorkItemFetchState; refresh: () => void } {
  const [state, setState] = useState<WorkItemFetchState>({ status: 'idle' });
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    if (!id) {
      setState({ status: 'idle' });
      return;
    }
    let cancelled = false;
    // Keep the rendered item while a refresh is in flight; only show the
    // loading shell on first open or after an error.
    setState(prev => (prev.status === 'ok' ? prev : { status: 'loading' }));
    fetch(`/api/workitem/${encodeURIComponent(id)}`, { cache: 'no-store' })
      .then(async r => {
        const body = await r.json();
        if (cancelled) return;
        if ('error' in body) setState({ status: 'error', error: body.error });
        else setState({ status: 'ok', data: body });
      })
      .catch(err => {
        if (cancelled) return;
        setState({ status: 'error', error: err instanceof Error ? err.message : String(err) });
      });
    return () => {
      cancelled = true;
    };
  }, [id, nonce]);
  return { state, refresh: () => setNonce(n => n + 1) };
}

/** Friendly first-name extracted from an email (jane.doe@x → "Jane"). */
export function nameFromEmail(email: string): string {
  const local = email.split('@')[0] ?? email;
  const first = local.split(/[._-]/)[0] ?? local;
  return first.charAt(0).toUpperCase() + first.slice(1);
}

/* -------------------------------------------------------------------------- */
/*  Work item edits                                                           */
/* -------------------------------------------------------------------------- */

export type StateBucket = 'waiting' | 'going' | 'done';

export interface WorkItemEditPayload {
  state?: StateBucket;
  // Original Estimate is intentionally NOT editable here — it's set once at
  // creation. The server route refuses it. Closing (state: 'done') goes through
  // markWorkItemDone, which carries the real hours.
  remainingWork?: number;
}

export async function updateWorkItem(
  workItemId: string,
  payload: WorkItemEditPayload,
): Promise<{ applied: { state?: string; remainingWork?: number } }> {
  const r = await fetch(`/api/workitem/${encodeURIComponent(workItemId)}/edit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const body = await r.json();
  if (!r.ok || 'error' in body) {
    throw new Error(body.error ?? 'Edit failed');
  }
  return body;
}

/** Block a work item (Task / User Story). Returns the new ADO state. */
export async function postWorkItemBlock(workItemId: string): Promise<{ state: string }> {
  return postBlockAction(workItemId, 'block');
}

/** Clear a block on a work item. Returns the new ADO state. */
export async function postWorkItemUnblock(workItemId: string): Promise<{ state: string }> {
  return postBlockAction(workItemId, 'unblock');
}

async function postBlockAction(
  workItemId: string,
  action: 'block' | 'unblock',
): Promise<{ state: string }> {
  const r = await fetch(`/api/workitem/${encodeURIComponent(workItemId)}/${action}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  });
  const body = await r.json();
  if (!r.ok || 'error' in body) {
    throw new Error(body.error ?? `${action} failed`);
  }
  return body;
}

/* -------------------------------------------------------------------------- */
/*  Planning gaps                                                             */
/* -------------------------------------------------------------------------- */

export interface ApiPlanningGapAnchor {
  isColdStart: boolean;
  siblingMedianActual: number | null;
  siblingSampleCount: number;
  calibrationOverallRatio: number | null;
  summary: string;
}

export interface ApiPlanningGapRef {
  workItemId: number;
  title: string;
  displayName: string;
  type: string;
}

export interface ApiPlanningGap {
  kind: 'task' | 'story' | 'feature' | 'epic';
  workItemId: number;
  title: string;
  displayName: string;
  missing: string[];
  parent: ApiPlanningGapRef | null;
  feature: ApiPlanningGapRef | null;
  anchor: ApiPlanningGapAnchor;
}

export interface ApiPlanningGapsResponse {
  fetchedAt: string;
  totalGaps: number;
  gaps: ApiPlanningGap[];
  prompt: string;
}

export async function fetchPlanningGaps(): Promise<ApiPlanningGapsResponse> {
  const r = await fetch('/api/planning/gaps', { cache: 'no-store' });
  const body = await r.json();
  if (!r.ok || 'error' in body) throw new Error(body.error ?? 'Could not load planning gaps');
  return body as ApiPlanningGapsResponse;
}

/* -------------------------------------------------------------------------- */
/*  Planning cockpit                                                          */
/* -------------------------------------------------------------------------- */

export interface ApiCockpitIteration {
  name: string;
  path: string;
  startDate: string;
  finishDate: string;
}

export interface ApiCockpitOpenTask {
  id: number;
  title: string;
  displayName: string;
  state: string;
  type: string;
  originalEstimate?: number;
  remainingWork?: number;
}

export interface ApiCockpitOpenStory {
  id: number;
  title: string;
  displayName: string;
  type: string;
  state: string;
  totalEstimateHours: number;
  completedHours: number;
  remainingHours: number;
  storyPoints?: number;
  effort?: number;
  feature?: { id: number; title: string; displayName: string };
  doneTaskCount: number;
  totalTaskCount: number;
  openTasks: ApiCockpitOpenTask[];
}

export type ApiBacklogLevel = 'year' | 'quarter' | 'backlog';

export interface ApiCockpitBacklogStory {
  id: number;
  title: string;
  displayName: string;
  type: string;
  state: string;
  iterationPath: string;
  level: ApiBacklogLevel;
  storyPoints?: number;
  effort?: number;
  originalEstimate?: number;
  remainingWork?: number;
  feature?: { id: number; title: string; displayName: string };
}

export interface ApiCockpitCapacity {
  workingHoursTotal: number;
  availableHours: number;
  meetingHours: number;
  hasUrl: boolean;
}

export interface ApiCockpitTopUpTask {
  id: number;
  title: string;
  displayName: string;
  state: string;
  type: string;
  remainingWork?: number;
  originalEstimate?: number;
}

export interface ApiCockpitTopUpStory {
  id: number;
  title: string;
  displayName: string;
  type: string;
  state: string;
  /** Where the story lives now: a sprint name (e.g. "26_12") or "Backlog". */
  locationLabel: string;
  /** Sum of open-task hours — what a full pull adds to the current sprint. */
  pullableHours: number;
  /** True when the whole story (not just its tasks) may be pulled into the current sprint. */
  canPullStory: boolean;
  openTasks: ApiCockpitTopUpTask[];
}

export interface ApiCockpitPayload {
  currentSprint: ApiCockpitIteration | null;
  nextSprint: ApiCockpitIteration | null;
  nextSprintCapacity: ApiCockpitCapacity | null;
  currentSprintCapacity: ApiCockpitCapacity | null;
  currentSprintCommittedHours: number;
  openStories: ApiCockpitOpenStory[];
  backlogStories: ApiCockpitBacklogStory[];
  topUpStories: ApiCockpitTopUpStory[];
}

export async function fetchCockpit(): Promise<ApiCockpitPayload> {
  const r = await fetch('/api/planning/cockpit', { cache: 'no-store' });
  const body = await r.json();
  if (!r.ok || 'error' in body) throw new Error(body.error ?? 'Could not load planning cockpit');
  return body as ApiCockpitPayload;
}

/* ----------------------------- Pre-plan page ----------------------------- */

export type ApiPrePlanCall = 'on-track' | 'at-risk' | 'carries-over';

export interface ApiPrePlanCard {
  id: string;
  displayName: string;
  remainingHours: number;
  blocked: boolean;
  lastActivityAt: string | null;
  call: ApiPrePlanCall;
  callIsSuggested: boolean;
  goalIndex: number | null;
}

export interface ApiPrePlanRoomLine {
  openStoriesRemainingHours: number;
  roomHours: number;
  hasCapacity: boolean;
}

export interface ApiPrePlanCoverageGoal {
  index: number;
  text: string;
  storyCount: number;
}

export interface ApiPrePlanPayload {
  sprintName: string;
  goals: string[];
  cards: ApiPrePlanCard[];
  coverage: ApiPrePlanCoverageGoal[];
  room: ApiPrePlanRoomLine;
}

export async function fetchPrePlan(): Promise<ApiPrePlanPayload> {
  const r = await fetch('/api/preplan', { cache: 'no-store' });
  const body = await r.json();
  if (!r.ok || 'error' in body) throw new Error(body.error ?? 'Could not load the pre-plan page');
  return body as ApiPrePlanPayload;
}

export async function savePrePlan(body: {
  goals?: string[];
  story?: { id: string; call?: ApiPrePlanCall; goalIndex?: number | null };
}): Promise<ApiPrePlanPayload> {
  const r = await fetch('/api/preplan', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const resBody = await r.json();
  if (!r.ok || 'error' in resBody) throw new Error(resBody.error ?? 'Could not save the pre-plan changes');
  return resBody as ApiPrePlanPayload;
}

export async function moveWorkItemToIteration(workItemId: number, iterationPath: string): Promise<void> {
  const r = await fetch(`/api/workitem/${workItemId}/edit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ iterationPath }),
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok || (body && 'error' in body)) {
    throw new Error((body && body.error) || 'Could not move the work item');
  }
}

export async function markWorkItemDone(workItemId: number, completedHours: number): Promise<void> {
  const r = await fetch(`/api/workitem/${workItemId}/edit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ state: 'done', completedHours }),
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok || (body && 'error' in body)) {
    throw new Error((body && body.error) || 'Could not close the work item');
  }
}

/* -------------------------------------------------------------------------- */
/*  Helper's notes                                                            */
/* -------------------------------------------------------------------------- */

async function postNoteAction(id: number, action: 'dismiss' | 'pin' | 'unpin'): Promise<void> {
  const r = await fetch(`/api/helper-note/${id}/${action}`, { method: 'POST' });
  const body = await r.json().catch(() => ({}));
  if (!r.ok || (body && 'error' in body)) {
    throw new Error((body && body.error) || `Could not ${action} that note`);
  }
}

export async function dismissHelperNote(id: number): Promise<void> {
  await postNoteAction(id, 'dismiss');
}

export async function pinHelperNote(id: number): Promise<void> {
  await postNoteAction(id, 'pin');
}

export async function unpinHelperNote(id: number): Promise<void> {
  await postNoteAction(id, 'unpin');
}

/* -------------------------------------------------------------------------- */
/*  Carry-forward                                                             */
/* -------------------------------------------------------------------------- */

export async function postCarryForward(taskIds: number[]): Promise<{ moved: number; failed: number[] }> {
  const res = await fetch('/api/carry-forward', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ taskIds }),
  });
  if (!res.ok) throw new Error(`carry-forward failed: ${res.status}`);
  return (await res.json()) as { moved: number; failed: number[] };
}
