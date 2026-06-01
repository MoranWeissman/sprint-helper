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
import {
  computeUpcomingCeremonies,
  modeForCeremony,
  type ModeId,
  type UpcomingCeremony,
} from './ceremony';
import { loadAdoConfig } from './config';
import { getHelperNotes, type HelperNotes } from './helper-notes';
import {
  getActiveSessionMap,
  getRecentEventsMap,
  getSessionCountMap,
  type Session,
  type SessionEvent,
} from './sessions';
import {
  getPendingChangesCount,
  getRunningStartsMap,
  getUncapturedSecondsMap,
} from './timers';

export type { SessionEvent, SessionEventType, Session } from './sessions';

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
  /** ADO's CompletedWork — purely what the server has stored. */
  completedWork?: number;
  /** Short plain-text preview for the expand panel. */
  descriptionPreview?: string;
  /** Last segment of the area path. */
  area?: string;
  /**
   * Seconds tracked locally that aren't reflected in ADO yet (closed
   * unsynced entries + any currently-running session's elapsed at fetch time).
   */
  localUncapturedSeconds: number;
  /** ISO timestamp of the running session's start, if a timer is currently running. */
  runningSince?: string;
  /**
   * Claude Code session against this item, if one is active right now. The MCP
   * plugin opens these via `session_start`; the Day dashboard surfaces them so
   * Moran can see Claude Code is actively reporting in.
   */
  activeSession?: { id: string; startedAt: string };
  /** Newest-first session events (focus / summary / blocker / decision / note). */
  recentActivity: SessionEvent[];
  /** Number of work sessions (open or closed) recorded against this item. */
  sessionCount: number;
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
  /** Short plain-text preview for the expand panel. */
  descriptionPreview?: string;
  area?: string;
  /** Direct effort fields on the parent itself (separate from rolled-up task hours). */
  parentEstimate?: number;
  parentRemaining?: number;
  /** Story-level planning fields the POM delivery manager watches. */
  storyPoints?: number;
  effort?: number;
  /** The Feature / Epic above this story, if there is one (or this item is itself a Feature/Epic). */
  feature?: { id: string; title: string; type: string };
  /** Tasks (or other child items) assigned to the user that belong to this parent. */
  tasks: DashboardWorkItem[];
  /** Aggregate effort across this group's tasks (in hours). */
  totalEstimateHours: number;
  completedHours: number;
  remainingHours: number;
  /** Counts for quick glance. */
  counts: { inProgress: number; upNext: number; done: number };
  /**
   * Newest-first session events rolled up across the story's tasks. Capped at
   * 5 — full history is on individual tasks.
   */
  recentActivity: SessionEvent[];
  /** True if any child task has a live Claude Code session right now. */
  hasActiveSession: boolean;
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
  /** Count of local edits that haven't reached ADO yet. */
  pendingChanges: number;
  /** Number of live Claude Code sessions reporting in right now. */
  activeSessions: number;
  /** The assistant's read on the sprint: a living summary + a few open nudges. */
  helperNotes: HelperNotes;
  /**
   * Upcoming ceremony occurrences within the next ~2 weeks, plus a
   * "suggested" mode if any is happening right now (15 min before → 60 min
   * after start). The dashboard uses this to highlight the right tab.
   */
  ceremonies: {
    upcoming: UpcomingCeremony[];
    next: UpcomingCeremony | null;
    suggestedModeId: ModeId | null;
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
      pendingChanges: getPendingChangesCount(),
      activeSessions: 0,
      helperNotes: getHelperNotes(),
      ceremonies: buildCeremonyBlock(null, null),
      fetchedAt: new Date().toISOString(),
    };
  }

  const items = await getMyWorkItems(iteration.path);

  // Pull local timer state. Each map is keyed by numeric work item id.
  const uncaptured = getUncapturedSecondsMap();
  const running = getRunningStartsMap();

  // Pull MCP session state — active sessions + recent events per work item.
  const itemIds = items.map(w => w.id);
  const activeSessions = getActiveSessionMap();
  const recentEvents = getRecentEventsMap(itemIds, 5);
  const sessionCounts = getSessionCountMap(itemIds);

  const inProgress: DashboardWorkItem[] = [];
  const upNext: DashboardWorkItem[] = [];
  const done: DashboardWorkItem[] = [];

  for (const w of items) {
    const projected = projectWorkItem(w, uncaptured, running, activeSessions, recentEvents, sessionCounts);
    if (DONE_STATES.has(w.state)) done.push(projected);
    else if (ACTIVE_STATES.has(w.state)) inProgress.push(projected);
    else upNext.push(projected);
  }

  // Capacity: ADO effort fields + local-uncaptured seconds (so the dashboard
  // shows what the user actually worked, even before they sync).
  const capacity = items.reduce(
    (acc, w) => {
      const localHours = (uncaptured.get(w.id) ?? 0) / 3600;
      acc.remainingHours += w.remainingWork ?? 0;
      acc.completedHours += (w.completedWork ?? 0) + localHours;
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
    pendingChanges: getPendingChangesCount(),
    activeSessions: activeSessions.size,
    helperNotes: getHelperNotes(),
    ceremonies: buildCeremonyBlock(
      new Date(iteration.startDate),
      new Date(iteration.finishDate),
    ),
    fetchedAt: new Date().toISOString(),
  };
}

function buildCeremonyBlock(
  sprintStart: Date | null,
  sprintFinish: Date | null,
): DashboardPayload['ceremonies'] {
  const now = new Date();
  const upcoming = computeUpcomingCeremonies({ sprintStart, sprintFinish, now });
  const suggested = upcoming.find(u => u.isSuggested) ?? null;
  // "next" is either the suggested one (so the UI surfaces what's happening
  // right now), or the first non-elapsed future occurrence.
  const next = suggested ?? upcoming.find(u => u.minutesUntil >= 0) ?? null;
  return {
    upcoming,
    next,
    suggestedModeId: suggested ? modeForCeremony(suggested.id) : null,
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
      const parentTypeLower = (raw.parentType ?? '').toLowerCase();
      // If the parent IS a Feature/Epic, treat the parent itself as the feature.
      // Otherwise, the feature is the grandparent (if any).
      const feature = FEATURE_LIKE_TYPES.has(parentTypeLower)
        ? { id: String(raw.parentId), title: raw.parentTitle, type: raw.parentType ?? 'Feature' }
        : raw.grandparentId
          ? {
              id: String(raw.grandparentId),
              title: raw.grandparentTitle ?? '',
              type: raw.grandparentType ?? 'Feature',
            }
          : undefined;
      parent = {
        id: String(raw.parentId),
        title: raw.parentTitle,
        type: raw.parentType ?? 'User Story',
        state: raw.parentState ?? '',
        url: raw.parentUrl ?? '',
        descriptionPreview: htmlPreview(raw.parentDescription),
        area: lastPathSegment(raw.parentAreaPath ?? ''),
        parentEstimate: raw.parentOriginalEstimate,
        parentRemaining: raw.parentRemainingWork,
        storyPoints: raw.parentStoryPoints,
        effort: raw.parentEffort,
        feature,
      };
    } else {
      // No parent — treat the item itself as its own "story".
      const typeLower = raw.type.toLowerCase();
      const feature = FEATURE_LIKE_TYPES.has(typeLower)
        ? { id: String(raw.id), title: raw.title, type: raw.type }
        : undefined;
      parent = {
        id: String(raw.id),
        title: raw.title,
        type: raw.type,
        state: raw.state,
        url: humanUrl(raw.url),
        descriptionPreview: htmlPreview(raw.description),
        area: lastPathSegment(raw.areaPath),
        parentEstimate: raw.originalEstimate,
        parentRemaining: raw.remainingWork,
        storyPoints: raw.storyPoints,
        effort: raw.effort,
        feature,
      };
    }
    const key = parent.id;
    if (!buckets.has(key)) buckets.set(key, { parent, tasks: [] });
    buckets.get(key)!.tasks.push(projectedItem);
  }

  // Roll up effort + counts per bucket. Local-uncaptured time is added
  // into completedHours and subtracted from remainingHours so the story
  // reflects reality even before changes are pushed to ADO.
  const groups: UserStoryGroup[] = Array.from(buckets.values()).map(({ parent, tasks }) => {
    const totalEstimateHours = tasks.reduce((s, t) => s + (t.originalEstimate ?? 0), 0);
    const completedHours = tasks.reduce(
      (s, t) => s + (t.completedWork ?? 0) + t.localUncapturedSeconds / 3600,
      0,
    );
    const remainingHours = tasks.reduce(
      (s, t) => s + Math.max(0, (t.remainingWork ?? 0) - t.localUncapturedSeconds / 3600),
      0,
    );
    const counts = {
      inProgress: tasks.filter(t => ACTIVE_STATES.has(t.state)).length,
      upNext: tasks.filter(t => !ACTIVE_STATES.has(t.state) && !DONE_STATES.has(t.state)).length,
      done: tasks.filter(t => DONE_STATES.has(t.state)).length,
    };
    // Roll up activity: merge per-task events, sort by recency, cap at 5.
    const recentActivity = tasks
      .flatMap(t => t.recentActivity)
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
      .slice(0, 5);
    const hasActiveSession = tasks.some(t => t.activeSession != null);
    return {
      id: parent.id,
      title: parent.title,
      type: parent.type,
      state: parent.state,
      url: parent.url,
      descriptionPreview: parent.descriptionPreview,
      area: parent.area,
      parentEstimate: parent.parentEstimate,
      parentRemaining: parent.parentRemaining,
      storyPoints: parent.storyPoints,
      effort: parent.effort,
      feature: parent.feature,
      tasks,
      totalEstimateHours,
      completedHours,
      remainingHours,
      counts,
      recentActivity,
      hasActiveSession,
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
  descriptionPreview?: string;
  area?: string;
  parentEstimate?: number;
  parentRemaining?: number;
  storyPoints?: number;
  effort?: number;
  feature?: { id: string; title: string; type: string };
}

const FEATURE_LIKE_TYPES = new Set(['feature', 'epic']);

function projectWorkItem(
  w: WorkItem,
  uncaptured: Map<number, number>,
  running: Map<number, string>,
  activeSessions: Map<number, Session>,
  recentEvents: Map<number, SessionEvent[]>,
  sessionCounts: Map<number, number>,
): DashboardWorkItem {
  const lastIterSegment = w.iterationPath.split('\\').pop() ?? w.iterationPath;
  const story = w.parentTitle
    ? `${w.parentTitle} · ${lastIterSegment}`
    : `${w.type} · ${lastIterSegment}`;
  const session = activeSessions.get(w.id);
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
    descriptionPreview: htmlPreview(w.description),
    area: lastPathSegment(w.areaPath),
    localUncapturedSeconds: uncaptured.get(w.id) ?? 0,
    runningSince: running.get(w.id),
    activeSession: session ? { id: session.id, startedAt: session.startedAt } : undefined,
    recentActivity: recentEvents.get(w.id) ?? [],
    sessionCount: sessionCounts.get(w.id) ?? 0,
    url: humanUrl(w.url),
  };
}

/** Strip HTML tags + entities, collapse whitespace, truncate to 280 chars. */
function htmlPreview(html: string | undefined): string | undefined {
  if (!html) return undefined;
  const text = html
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<\/p>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return undefined;
  return text.length > 280 ? text.slice(0, 277).trimEnd() + '…' : text;
}

function lastPathSegment(path: string): string | undefined {
  if (!path) return undefined;
  const seg = path.split('\\').pop();
  return seg && seg !== path ? seg : undefined;
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
