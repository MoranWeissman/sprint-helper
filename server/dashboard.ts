/**
 * Dashboard read API — turns ADO data into the shape the React dashboard wants.
 *
 * Slice 1.5: real sprint context + real work items. Time tracking
 * (running/done-today/standup) is still mocked because we don't yet have
 * local persistence — that lands in slices 1.7 and 2.
 */
import {
  getCurrentIteration,
  getIterationByName,
  getMyWorkItems,
  listAllIterations,
  type Iteration,
  type WorkItem,
} from './ado';
import { loadAdoConfig } from './config';

export interface DashboardWorkItem {
  id: string;
  title: string;
  type: string;
  state: string;
  story: string;
  parent?: {
    id: string;
    title: string;
    type: string;
    state: string;
    url: string;
  };
  originalEstimate?: number;
  remainingWork?: number;
  completedWork?: number;
  url: string;
}

export interface SprintOption {
  id: string;
  name: string;
  path: string;
  startDate: string;
  finishDate: string;
  isCurrent: boolean;
}

export interface UserStoryGroup {
  /** Parent work item id. May be a User Story, Feature, or Bug depending on team setup. */
  id: string;
  title: string;
  type: string;            // typically "User Story" but could be "Feature", "Bug", etc.
  state: string;
  url: string;
  /** Tasks (or other child items) assigned to the user that belong to this parent. */
  tasks: DashboardWorkItem[];
  /** Aggregate effort across this group's tasks (in hours). */
  totalEstimateHours: number;
  completedHours: number;
  remainingHours: number;
  /** Counts for quick glance. */
  counts: { inProgress: number; upNext: number; done: number };
}

export interface DashboardPayload {
  user: string;
  sprint: {
    id: string;
    name: string;
    path: string;
    startDate: string;
    finishDate: string;
    totalDays: number;
  } | null;
  sprintOptions: SprintOption[];
  workItems: {
    inProgress: DashboardWorkItem[];
    upNext: DashboardWorkItem[];
    done: DashboardWorkItem[];
  };
  /** Tasks grouped by parent user story (or other parent type) — for the
   *  story-centric focus view. Stories with no children are still included
   *  if they're themselves assigned to the user. */
  userStories: UserStoryGroup[];
  capacity: {
    remainingHours: number;
    completedHours: number;
    totalEstimateHours: number;
  };
  fetchedAt: string;
}

// State buckets vary by process template; cover the common ones.
const DONE_STATES = new Set(['Done', 'Closed', 'Resolved', 'Completed', 'Removed']);
const ACTIVE_STATES = new Set(['Active', 'In Progress', 'Committed', 'Doing']);

export interface BuildOptions {
  /** When set, fetches a specific sprint (by iteration name) instead of the current one. */
  sprintName?: string;
}

export async function buildDashboard(opts: BuildOptions = {}): Promise<DashboardPayload> {
  const cfg = await loadAdoConfig();

  // Resolve the iteration we want. If a name is given, pull that one; else current.
  const [requestedIteration, currentIteration, allIterations] = await Promise.all([
    opts.sprintName ? getIterationByName(opts.sprintName) : Promise.resolve(null as Iteration | null),
    getCurrentIteration(),
    listAllIterations().catch(() => []),
  ]);
  const iteration: Iteration | null = requestedIteration ?? currentIteration;

  const sprintOptions: SprintOption[] = allIterations.map(it => ({
    id: it.id,
    name: it.name,
    path: it.path,
    startDate: it.startDate,
    finishDate: it.finishDate,
    isCurrent: currentIteration?.id === it.id,
  }));

  if (!iteration) {
    return {
      user: cfg.user,
      sprint: null,
      sprintOptions,
      workItems: { inProgress: [], upNext: [], done: [] },
      userStories: [],
      capacity: { remainingHours: 0, completedHours: 0, totalEstimateHours: 0 },
      fetchedAt: new Date().toISOString(),
    };
  }

  const items = await getMyWorkItems(iteration.path);

  const inProgress: DashboardWorkItem[] = [];
  const upNext: DashboardWorkItem[] = [];
  const done: DashboardWorkItem[] = [];

  for (const w of items) {
    const projected = projectWorkItem(w);
    if (DONE_STATES.has(w.state)) done.push(projected);
    else if (ACTIVE_STATES.has(w.state)) inProgress.push(projected);
    else upNext.push(projected);
  }

  // Capacity numbers from ADO's effort fields (1 point = 1 hour in this team's convention).
  const capacity = items.reduce(
    (acc, w) => {
      acc.remainingHours += w.remainingWork ?? 0;
      acc.completedHours += w.completedWork ?? 0;
      acc.totalEstimateHours += w.originalEstimate ?? 0;
      return acc;
    },
    { remainingHours: 0, completedHours: 0, totalEstimateHours: 0 },
  );

  const totalDays = sprintDays(iteration.startDate, iteration.finishDate);

  const userStories = groupByParent(items, [...inProgress, ...upNext, ...done]);

  return {
    user: cfg.user,
    sprint: {
      id: iteration.id,
      name: iteration.name,
      path: iteration.path,
      startDate: iteration.startDate,
      finishDate: iteration.finishDate,
      totalDays,
    },
    sprintOptions,
    workItems: { inProgress, upNext, done },
    userStories,
    capacity,
    fetchedAt: new Date().toISOString(),
  };
}

/**
 * Group tasks by their parent user story. Items without a parent become their
 * own group (so a User Story assigned directly to the user without sub-tasks
 * still shows up). Stories are sorted: those with in-progress tasks first,
 * then by descending in-progress count.
 */
function groupByParent(rawItems: WorkItem[], projected: DashboardWorkItem[]): UserStoryGroup[] {
  // Index projected items by id for easy lookup with effort numbers.
  const byId = new Map(projected.map(p => [p.id, p]));

  // Bucket by parent id (or by self id if no parent — i.e. orphan items).
  const buckets = new Map<string, { parent: ParentInfo; tasks: DashboardWorkItem[] }>();

  for (const raw of rawItems) {
    const projectedItem = byId.get(String(raw.id));
    if (!projectedItem) continue;

    let parent: ParentInfo;
    if (raw.parentId && raw.parentTitle) {
      parent = {
        id: String(raw.parentId),
        title: raw.parentTitle,
        type: raw.parentType ?? 'User Story',
        state: raw.parentState ?? '',
        url: raw.parentUrl ?? '',
      };
    } else {
      // No parent — treat the item itself as its own "story".
      parent = {
        id: String(raw.id),
        title: raw.title,
        type: raw.type,
        state: raw.state,
        url: humanUrl(raw.url),
      };
    }
    const key = parent.id;
    if (!buckets.has(key)) buckets.set(key, { parent, tasks: [] });
    buckets.get(key)!.tasks.push(projectedItem);
  }

  // Roll up effort + counts per bucket.
  const groups: UserStoryGroup[] = Array.from(buckets.values()).map(({ parent, tasks }) => {
    const totalEstimateHours = tasks.reduce((s, t) => s + (t.originalEstimate ?? 0), 0);
    const completedHours = tasks.reduce((s, t) => s + (t.completedWork ?? 0), 0);
    const remainingHours = tasks.reduce((s, t) => s + (t.remainingWork ?? 0), 0);
    const counts = {
      inProgress: tasks.filter(t => ACTIVE_STATES.has(t.state)).length,
      upNext: tasks.filter(t => !ACTIVE_STATES.has(t.state) && !DONE_STATES.has(t.state)).length,
      done: tasks.filter(t => DONE_STATES.has(t.state)).length,
    };
    return {
      id: parent.id,
      title: parent.title,
      type: parent.type,
      state: parent.state,
      url: parent.url,
      tasks,
      totalEstimateHours,
      completedHours,
      remainingHours,
      counts,
    };
  });

  // Sort: stories with in-progress tasks first, more in-progress → higher;
  // ties broken by tasks-remaining (more work → earlier).
  groups.sort((a, b) => {
    if (b.counts.inProgress !== a.counts.inProgress) return b.counts.inProgress - a.counts.inProgress;
    return b.remainingHours - a.remainingHours;
  });

  return groups;
}

interface ParentInfo {
  id: string;
  title: string;
  type: string;
  state: string;
  url: string;
}

function projectWorkItem(w: WorkItem): DashboardWorkItem {
  const lastIterSegment = w.iterationPath.split('\\').pop() ?? w.iterationPath;
  const story = w.parentTitle
    ? `${w.parentTitle} · ${lastIterSegment}`
    : `${w.type} · ${lastIterSegment}`;
  return {
    id: String(w.id),
    title: w.title,
    type: w.type,
    state: w.state,
    story,
    parent: w.parentId && w.parentTitle
      ? {
          id: String(w.parentId),
          title: w.parentTitle,
          type: w.parentType ?? 'User Story',
          state: w.parentState ?? '',
          url: w.parentUrl ?? '',
        }
      : undefined,
    originalEstimate: w.originalEstimate,
    remainingWork: w.remainingWork,
    completedWork: w.completedWork,
    url: humanUrl(w.url),
  };
}

/** ADO `url` field points at the REST API; convert to the human-facing URL. */
function humanUrl(restUrl: string): string {
  // restUrl looks like https://dev.azure.com/<org>/_apis/wit/workItems/<id>
  const m = restUrl.match(/^(https:\/\/dev\.azure\.com\/[^/]+)\/_apis\/wit\/workItems\/(\d+)/);
  if (!m) return restUrl;
  return `${m[1]}/_workitems/edit/${m[2]}`;
}

function sprintDays(startISO: string, finishISO: string): number {
  const start = new Date(startISO);
  const finish = new Date(finishISO);
  const ms = finish.getTime() - start.getTime();
  return Math.max(1, Math.round(ms / (1000 * 60 * 60 * 24)) + 1);
}
