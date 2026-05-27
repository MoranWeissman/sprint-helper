/**
 * Timer service — orchestrates local timer state + ADO writes.
 * The Vite API endpoints and (future) MCP server both call into this layer.
 */
import {
  getTimerSnapshot,
  markEntriesSynced,
  pauseTimer,
  recordFailedSync,
  startTimer,
  type TimerSnapshot,
} from './timers';
import { pushCompletedWork, transitionToDone } from './writes';

export interface TimerActionResult {
  snapshot: TimerSnapshot;
  /** What we just did, for the client to render confirmation. */
  action: 'started' | 'already_running' | 'paused' | 'not_running' | 'synced' | 'marked_done';
  syncedSeconds?: number;
  newCompletedHours?: number;
  newState?: string;
  /** Non-fatal warning surfaced to the UI (e.g., state transition failed but effort pushed). */
  warning?: string;
}

export function start(workItemId: number): TimerActionResult {
  const before = getTimerSnapshot(workItemId);
  if (before.running) return { snapshot: before, action: 'already_running' };
  startTimer(workItemId);
  return { snapshot: getTimerSnapshot(workItemId), action: 'started' };
}

export function pause(workItemId: number): TimerActionResult {
  const before = getTimerSnapshot(workItemId);
  if (!before.running) return { snapshot: before, action: 'not_running' };
  pauseTimer(workItemId);
  return { snapshot: getTimerSnapshot(workItemId), action: 'paused' };
}

/** Push local unsynced effort to ADO. No state transition. */
export async function sync(workItemId: number): Promise<TimerActionResult> {
  // Pause first so any in-flight session contributes to the sync.
  pauseTimer(workItemId);
  const snap = getTimerSnapshot(workItemId);
  if (snap.unsyncedSeconds === 0) {
    return { snapshot: snap, action: 'synced', syncedSeconds: 0 };
  }
  try {
    const { newCompletedHours } = await pushCompletedWork(workItemId, snap.unsyncedSeconds);
    markEntriesSynced(workItemId);
    return {
      snapshot: getTimerSnapshot(workItemId),
      action: 'synced',
      syncedSeconds: snap.unsyncedSeconds,
      newCompletedHours,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    recordFailedSync(workItemId, 'effort', { seconds: snap.unsyncedSeconds }, msg);
    throw err;
  }
}

/** Sync effort + transition state. The all-the-way-done action. */
export async function markDone(workItemId: number): Promise<TimerActionResult> {
  const syncResult = await sync(workItemId);
  try {
    const newState = await transitionToDone(workItemId);
    return {
      ...syncResult,
      action: 'marked_done',
      newState,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    recordFailedSync(workItemId, 'state', { target: 'done' }, msg);
    return {
      ...syncResult,
      action: 'marked_done',
      warning: `Effort synced, but state transition failed: ${msg}`,
    };
  }
}
