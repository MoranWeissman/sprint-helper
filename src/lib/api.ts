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
}

export interface ApiHelperNotes {
  summary: string | null;
  summaryAt: string | null;
  notes: ApiHelperNote[];
}

/** Outlook-calendar derived capacity for the current sprint. */
export interface ApiOutlookCapacity {
  sprintStart: string;
  sprintEnd: string;
  workingDays: number;
  workdayHours: number;
  workingHoursTotal: number;
  meetingHours: { busy: number; tentative: number; oof: number; weighted: number };
  realDeskHours: number;
  plannedHours: number;
  /** plannedHours - realDeskHours. Positive = planned over capacity. */
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

export interface ApiStandupEntry {
  workItemId: number;
  /** Pre-formatted `**title** (#id)` ready to echo. */
  displayName: string;
  parentStoryTitle: string | null;
  summary: string | null;
  minutesInWindow: number | null;
  state: 'live' | 'paused' | 'closed';
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

export function useWorkItem(id: string | null): WorkItemFetchState {
  const [state, setState] = useState<WorkItemFetchState>({ status: 'idle' });
  useEffect(() => {
    if (!id) {
      setState({ status: 'idle' });
      return;
    }
    let cancelled = false;
    setState({ status: 'loading' });
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
  }, [id]);
  return state;
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
  originalEstimate?: number;
  remainingWork?: number;
}

export async function updateWorkItem(
  workItemId: string,
  payload: WorkItemEditPayload,
): Promise<{ applied: { state?: string; originalEstimate?: number; remainingWork?: number } }> {
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
  kind: 'task' | 'story';
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
/*  Helper's notes                                                            */
/* -------------------------------------------------------------------------- */

export async function dismissHelperNote(id: number): Promise<void> {
  const r = await fetch(`/api/helper-note/${id}/dismiss`, { method: 'POST' });
  const body = await r.json().catch(() => ({}));
  if (!r.ok || (body && 'error' in body)) {
    throw new Error((body && body.error) || 'Could not clear that note');
  }
}
