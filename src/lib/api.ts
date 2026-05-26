import { useEffect, useState } from 'react';

// Mirrors server/dashboard.ts → DashboardPayload exactly. Keep in sync manually
// until we extract a shared types package.
export interface ApiParent {
  id: string;
  title: string;
  type: string;
  state: string;
  url: string;
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
  tasks: ApiWorkItem[];
  totalEstimateHours: number;
  completedHours: number;
  remainingHours: number;
  counts: { inProgress: number; upNext: number; done: number };
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
  fetchedAt: string;
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

  useEffect(() => {
    let cancelled = false;
    setState({ status: 'loading' });
    const url = sprintName
      ? `/api/dashboard?sprint=${encodeURIComponent(sprintName)}`
      : '/api/dashboard';
    fetch(url, { cache: 'no-store' })
      .then(async r => {
        const body = (await r.json()) as ApiPayload | ApiError;
        if (cancelled) return;
        if ('error' in body) {
          setState({ status: 'error', error: body.error, command: body.command });
        } else {
          setState({ status: 'ok', data: body });
        }
      })
      .catch(err => {
        if (cancelled) return;
        setState({ status: 'error', error: err instanceof Error ? err.message : String(err) });
      });
    return () => {
      cancelled = true;
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
