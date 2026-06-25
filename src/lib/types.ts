export interface SprintContext {
  num: number;
  startDate: Date;
  totalDays: number;
}

export interface RunningTask {
  id: string;
  title: string;
  story: string;
  elapsedSec: number;
  estimateMin: number;
  started: string;
  focused?: boolean;
}

export interface DoneTask {
  id: string;
  title: string;
  effort: string;
}

export interface UpNextTask {
  id: string;
  title: string;
  estimate: string;
}

export interface DashboardData {
  user: string;
  sprint: SprintContext;
  syncedMinAgo: number;
  pendingChanges: number;
  running: RunningTask[];
  doneToday: DoneTask[];
  upNext: UpNextTask[];
}

export interface SprintDay {
  index: number;
  label: string;
  state: 'past' | 'today' | 'future';
  /** True for Friday/Saturday — Moran's weekend (off). Rendered grayed. */
  isOff: boolean;
}
