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
  getWorkItemsWithParents,
  listAllIterations,
  listMyOpenTasksNotInSprint,
  type Iteration,
  type WorkItem,
} from './ado';
import { computeCapacity, type Capacity } from './capacity';
import {
  computeUpcomingCeremonies,
  modeForCeremony,
  type ModeId,
  type UpcomingCeremony,
} from './ceremony';
import { loadAdoConfig } from './config';
import { getHelperNotes, type HelperNotes } from './helper-notes';
import { buildStandup, workedItemIdsForStandup, type StandupBlock } from './standup';
import {
  getActiveSessionMap,
  getRecentEventsMap,
  getSessionCountMap,
  type Session,
  type SessionEvent,
} from './sessions';
import {
  getLocalLoggedMap,
  getPendingChangesCount,
  getRunningStartsMap,
  getUncapturedSecondsMap,
} from './timers';
import { getSHCreatedIdSet } from './sh-created';
import { isSprintLevel } from './iteration-paths';

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
  /**
   * Total seconds the timer actually ran on this item across ALL sittings
   * (running + paused + synced). This is the "LOGGED" value — real session
   * time — and unlike localUncapturedSeconds it does NOT drop a sitting once
   * it's paused. Kept separate from capacity math so it can't reinflate it.
   */
  localLoggedSeconds: number;
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
  /** Parsed System.Tags. Includes "Blocked" when this task itself is tagged blocked. */
  tags?: string[];
  /** Parent story's tags — used so a task can show its parent story is blocked. */
  parentTags?: string[];
  /**
   * True when this work item was created via the MCP `task_create` /
   * `story_create` tools. Local-only marker; the dashboard renders a
   * discreet "SH" pip so Moran can see what sprint-helper is on the
   * hook for keeping honest.
   */
  wasSHCreated?: boolean;
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
  /** Parsed System.Tags on the story (or self-as-story) itself. Includes "Blocked" when tagged blocked. */
  tags?: string[];
  /** Same marker as DashboardWorkItem.wasSHCreated — surfaced on stories too. */
  wasSHCreated?: boolean;
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
  /**
   * Outlook-derived "hours available after meetings" for the sprint vs planned
   * task hours. Null when there's no sprint yet. When no calendar URL is set,
   * hasUrl=false and meeting subtractions are skipped (available = working
   * hours total).
   */
  outlookCapacity: Capacity | null;
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
  /**
   * What Moran did yesterday and what he's on today, pulled from the
   * sessions DB. Surfaced only in the Daily view (the morning-standup
   * card). Read-only summary — no edits in the dashboard.
   */
  standup: StandupBlock;
  /** Open tasks left behind in a previous sprint, for the Daily carry-forward banner. Null when none. */
  carryForward: CarryForwardSummary | null;
  fetchedAt: string;
}

// State buckets vary by process template; cover the common ones.
const DONE_STATES = new Set(['Done', 'Closed', 'Resolved', 'Completed', 'Removed']);
const ACTIVE_STATES = new Set(['Active', 'In Progress', 'Committed', 'Doing']);

export interface BuildOptions {
  /** When set, fetches a specific sprint (by iteration name) instead of the current one. */
  sprintName?: string;
}

export interface TaskMetaEntry {
  title: string;
  parentId: number | null;
  parentTitle: string | null;
  type: string;
  state: string;
}

export interface CarryForwardSummary {
  /** Open tasks stranded in a previous sprint, ready to pull into the current one. */
  taskIds: number[];
  /** taskIds.length — convenience for the banner copy. */
  count: number;
  /** The sprint label most stranded tasks sit in, e.g. "26_12". */
  fromSprintLabel: string;
}

/**
 * Build the id→metadata map the standup recap uses to resolve each worked
 * item's title, type, parent and — crucially — its live Azure state.
 *
 * Two passes. The first records every sprint item the user owns. The second
 * fills in parent stories that aren't their own item row, using the parent
 * fields each child task already carries. That second pass matters because
 * sessions are usually logged on the child Tasks, so a worked Story shows up
 * only as `parentState` on its tasks. Without it the recap can't see a closed
 * parent story and falls back to showing it as "going" — the bug Moran hit
 * with "Prod addons ArgoCD ready to start migration". A real item row is
 * authoritative; the parent-derived fallback only fills a gap, never
 * overwrites a story present in its own right.
 */
export function buildTaskMeta(items: WorkItem[]): Map<number, TaskMetaEntry> {
  const taskMeta = new Map<number, TaskMetaEntry>();
  mergeIntoTaskMeta(taskMeta, items);
  return taskMeta;
}

/**
 * Turn the raw "my open tasks not in the current sprint" list into the banner
 * summary. Keeps only tasks whose iteration path is a real PREVIOUS sprint —
 * backlog / year / quarter items are scheduling, not carry-over, and stay on
 * the Plan page. Returns null when nothing qualifies (banner renders nothing).
 */
export function summarizeCarryForward(
  outOfSprintTasks: WorkItem[],
  pastSprintPaths: Set<string>,
): CarryForwardSummary | null {
  // Only tasks in a real named sprint that started BEFORE the current one.
  // The `pastSprintPaths` membership is what keeps FUTURE sprints out — a task
  // the user parked in a not-yet-started sprint during planning must never be
  // pulled backward into the current sprint by this banner. `isSprintLevel`
  // additionally drops any backlog/year/quarter path that slipped into the set.
  const stranded = outOfSprintTasks.filter(
    t => isSprintLevel(t.iterationPath) && pastSprintPaths.has(t.iterationPath),
  );
  if (stranded.length === 0) return null;

  // Label with the MOST RECENT past sprint the stranded tasks sit in (the
  // pastSprintPaths set is ordered newest-first by the caller). Reads naturally
  // as "N tasks from 26_12" even when a few straggle in from an older sprint.
  const strandedPaths = new Set(stranded.map(t => t.iterationPath));
  const newestPath = [...pastSprintPaths].find(p => strandedPaths.has(p));
  const labelPath = newestPath ?? stranded[0].iterationPath;
  const fromSprintLabel = labelPath.split('\\').filter(Boolean).pop() ?? labelPath;

  return { taskIds: stranded.map(t => t.id), count: stranded.length, fromSprintLabel };
}

/**
 * Add `items` (and their parent stories) into an existing taskMeta map, using
 * the same two-pass rule as buildTaskMeta. Shared so the dashboard can fold in
 * extra items worked outside the current sprint without duplicating the logic.
 * An item already present is NOT overwritten — the first writer (current-sprint
 * data) stays authoritative over a later best-effort fetch.
 */
export function mergeIntoTaskMeta(taskMeta: Map<number, TaskMetaEntry>, items: WorkItem[]): void {
  for (const w of items) {
    if (taskMeta.has(w.id)) continue;
    taskMeta.set(w.id, {
      title: w.title,
      parentId: w.parentId ?? null,
      parentTitle: w.parentTitle ?? null,
      type: w.type,
      state: w.state,
    });
  }
  for (const w of items) {
    if (w.parentId == null || taskMeta.has(w.parentId)) continue;
    taskMeta.set(w.parentId, {
      title: w.parentTitle ?? `#${w.parentId}`,
      parentId: w.grandparentId ?? null,
      parentTitle: w.grandparentTitle ?? null,
      type: w.parentType ?? 'User Story',
      state: w.parentState ?? '',
    });
  }
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
      outlookCapacity: null,
      pendingChanges: getPendingChangesCount(),
      activeSessions: 0,
      helperNotes: getHelperNotes(),
      ceremonies: buildCeremonyBlock(null, null),
      standup: buildStandup({ taskMeta: new Map() }),
      carryForward: null,
      fetchedAt: new Date().toISOString(),
    };
  }

  const items = await getMyWorkItems(iteration.path);

  // Pull local timer state. Each map is keyed by numeric work item id.
  const uncaptured = getUncapturedSecondsMap();
  const localLogged = getLocalLoggedMap();
  const running = getRunningStartsMap();
  const shCreatedIds = getSHCreatedIdSet();

  // Pull MCP session state — active sessions + recent events per work item.
  const itemIds = items.map(w => w.id);
  const activeSessions = getActiveSessionMap();
  const recentEvents = getRecentEventsMap(itemIds, 5);
  const sessionCounts = getSessionCountMap(itemIds);

  const inProgress: DashboardWorkItem[] = [];
  const upNext: DashboardWorkItem[] = [];
  const done: DashboardWorkItem[] = [];

  for (const w of items) {
    const projected = projectWorkItem(w, uncaptured, localLogged, running, activeSessions, recentEvents, sessionCounts);
    if (shCreatedIds.has(w.id)) projected.wasSHCreated = true;
    if (DONE_STATES.has(w.state)) done.push(projected);
    else if (ACTIVE_STATES.has(w.state)) inProgress.push(projected);
    else upNext.push(projected);
  }

  // Capacity rolls up TASKS only. User Stories / Features / Epics carry
  // aggregate effort fields that are rollups of their child tasks; counting
  // them alongside the tasks themselves double-counts. (Moran caught this
  // 2026-06-02 when a sprint summary showed 316h logged against 82h
  // estimated — Stories contributed 91h of "extra" rolled-up time.)
  const capacity = items.reduce(
    (acc, w) => {
      if (w.type !== 'Task') return acc;
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

  // R12: project SH-created marker onto story groups, same source of truth as
  // the per-task projection above.
  for (const g of userStories) {
    if (shCreatedIds.has(Number(g.id))) g.wasSHCreated = true;
  }

  // R10b: when a non-Task item (User Story / Feature / Epic) is itself in
  // one of the flat workItems lists — typically because Moran opened a
  // session on the Story directly — its own effort fields are usually
  // blank (Moran's process tracks hours on child tasks, not stories).
  // Fill in a rollup from the matching userStories[] bucket so the Focus
  // view shows meaningful Estimate / Logged / Remaining instead of blanks.
  const rollupByParentId = new Map<
    string,
    { totalEstimateHours: number; completedHours: number; remainingHours: number }
  >();
  for (const g of userStories) {
    rollupByParentId.set(g.id, {
      totalEstimateHours: g.totalEstimateHours,
      completedHours: g.completedHours,
      remainingHours: g.remainingHours,
    });
  }
  for (const slim of [...inProgress, ...upNext, ...done]) {
    if (slim.type === 'Task') continue;
    const rollup = rollupByParentId.get(slim.id);
    if (!rollup) continue;
    if (slim.originalEstimate == null && rollup.totalEstimateHours > 0) {
      slim.originalEstimate = rollup.totalEstimateHours;
    }
    if (slim.completedWork == null && rollup.completedHours > 0) {
      slim.completedWork = rollup.completedHours;
    }
    if (slim.remainingWork == null && rollup.remainingHours > 0) {
      slim.remainingWork = rollup.remainingHours;
    }
  }

  // Outlook capacity is best-effort: never break the dashboard if the calendar
  // fetch hiccups. computeCapacity catches its own fetch errors and surfaces
  // them via `fetchError`; this outer try is belt-and-suspenders.
  let outlookCapacity: Capacity | null = null;
  try {
    outlookCapacity = await computeCapacity({
      sprintStart: new Date(iteration.startDate),
      sprintEnd: new Date(iteration.finishDate),
      plannedHours: capacity.remainingHours,
    });
  } catch {
    outlookCapacity = null;
  }

  // Build the standup block — pulls yesterday + today entries from the
  // sessions DB, joined to task titles + parent story titles for display.
  const taskMeta = buildTaskMeta(items);
  // The recap can surface work logged against items NOT in the current sprint
  // (e.g. a task still sitting in last sprint, not yet pulled forward). Those
  // are absent from `taskMeta`, so without help the recap shows a bare `#id`.
  // Fetch just the missing worked items (+ their parents) and fold them in so
  // the recap reads real names regardless of which sprint the work lives in.
  const missingWorkedIds = workedItemIdsForStandup().filter(id => !taskMeta.has(id));
  if (missingWorkedIds.length > 0) {
    try {
      const extra = await getWorkItemsWithParents(missingWorkedIds);
      mergeIntoTaskMeta(taskMeta, extra);
    } catch {
      // Best-effort enrichment — if the fetch fails the recap still renders
      // with bare ids rather than breaking the whole dashboard.
    }
  }
  const standup = buildStandup({ taskMeta });

  // Open tasks left behind in a previous sprint — the Daily banner offers to
  // pull them into the current one. Best-effort: a query failure must not break
  // the dashboard, so fall back to null (no banner).
  let carryForward: CarryForwardSummary | null = null;
  try {
    // Paths of sprints that started strictly before the viewed sprint, newest
    // first — so the banner only ever offers genuinely PAST work, never tasks
    // parked in a future sprint during planning.
    const pastSprintPaths = new Set(
      allIterations
        .filter(it => it.startDate && iteration.startDate && it.startDate < iteration.startDate)
        .sort((a, b) => b.startDate.localeCompare(a.startDate))
        .map(it => it.path),
    );
    const outOfSprintTasks = await listMyOpenTasksNotInSprint(iteration.path);
    carryForward = summarizeCarryForward(outOfSprintTasks, pastSprintPaths);
  } catch {
    carryForward = null;
  }

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
    outlookCapacity,
    pendingChanges: getPendingChangesCount(),
    activeSessions: activeSessions.size,
    helperNotes: getHelperNotes(),
    ceremonies: buildCeremonyBlock(
      new Date(iteration.startDate),
      new Date(iteration.finishDate),
    ),
    standup,
    carryForward,
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
export function groupByParent(rawItems: WorkItem[], projected: DashboardWorkItem[]): UserStoryGroup[] {
  // Index projected items by id for easy lookup with effort numbers.
  const byId = new Map(projected.map(p => [p.id, p]));

  // A bucket = one story row. `header` is the story/bug/feature item itself
  // (when it's in the payload), `tasks` are its child Tasks. Keeping them
  // separate is what stops a User Story being filed as a "task" under its
  // Feature — only Tasks roll up; everything else heads its own row.
  interface Bucket {
    parent: ParentInfo;
    /** True once parent came from the item itself (richer) vs synthesized from a child task. */
    parentResolved: boolean;
    /** The story/bug item itself, if present in the payload (drives its own session/activity). */
    header: DashboardWorkItem | null;
    tasks: DashboardWorkItem[];
  }
  const buckets = new Map<string, Bucket>();

  for (const raw of rawItems) {
    const projectedItem = byId.get(String(raw.id));
    if (!projectedItem) continue;

    const typeLower = raw.type.toLowerCase();
    const hasParent = !!(raw.parentId && raw.parentTitle);
    // Only a Task rolls up under its parent story. A User Story / Bug / Feature
    // is its own row even when it has a parent (the parent is its Feature, not
    // a story it belongs to).
    const rollsUpToParent = typeLower === 'task' && hasParent;

    if (rollsUpToParent) {
      const parentTypeLower = (raw.parentType ?? '').toLowerCase();
      // If the parent IS a Feature/Epic, treat the parent itself as the feature.
      // Otherwise, the feature is the grandparent (if any).
      const feature = FEATURE_LIKE_TYPES.has(parentTypeLower)
        ? { id: String(raw.parentId), title: raw.parentTitle!, type: raw.parentType ?? 'Feature' }
        : raw.grandparentId
          ? {
              id: String(raw.grandparentId),
              title: raw.grandparentTitle ?? '',
              type: raw.grandparentType ?? 'Feature',
            }
          : undefined;
      const parent: ParentInfo = {
        id: String(raw.parentId),
        title: raw.parentTitle!,
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
        tags: raw.parentTags,
      };
      const existing = buckets.get(parent.id);
      if (existing) existing.tasks.push(projectedItem);
      else buckets.set(parent.id, { parent, parentResolved: false, header: null, tasks: [projectedItem] });
    } else {
      // The item heads its own row. If it's itself a Feature it heads a feature
      // section; otherwise its feature is its parent (so stories still group
      // under features in the daily view).
      const parentTypeLower = (raw.parentType ?? '').toLowerCase();
      const feature = FEATURE_LIKE_TYPES.has(typeLower)
        ? { id: String(raw.id), title: raw.title, type: raw.type }
        : hasParent && FEATURE_LIKE_TYPES.has(parentTypeLower)
          ? { id: String(raw.parentId), title: raw.parentTitle!, type: raw.parentType ?? 'Feature' }
          : undefined;
      const parent: ParentInfo = {
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
        tags: raw.tags,
      };
      const existing = buckets.get(parent.id);
      if (existing) {
        // A child task created this bucket first; now fill in the real header.
        existing.parent = parent;
        existing.parentResolved = true;
        existing.header = projectedItem;
      } else if (typeLower === 'task') {
        // Orphan Task (no parent): it IS the row's single task, like before.
        buckets.set(parent.id, { parent, parentResolved: true, header: null, tasks: [projectedItem] });
      } else {
        // Story / Bug / Feature: the header, not a task under itself.
        buckets.set(parent.id, { parent, parentResolved: true, header: projectedItem, tasks: [] });
      }
    }
  }

  // Roll up effort + counts per bucket. Local-uncaptured time is added
  // into completedHours and subtracted from remainingHours so the story
  // reflects reality even before changes are pushed to ADO. Hours sum
  // over TASK-type children only — Story / Feature / Epic children carry
  // rollup numbers that double-count if added in (see capacity reducer
  // above).
  const groups: UserStoryGroup[] = Array.from(buckets.values()).map(({ parent, header, tasks }) => {
    const taskOnly = tasks.filter(t => t.type === 'Task');
    const totalEstimateHours = taskOnly.reduce((s, t) => s + (t.originalEstimate ?? 0), 0);
    const completedHours = taskOnly.reduce(
      (s, t) => s + (t.completedWork ?? 0) + t.localUncapturedSeconds / 3600,
      0,
    );
    const remainingHours = taskOnly.reduce(
      (s, t) => s + Math.max(0, (t.remainingWork ?? 0) - t.localUncapturedSeconds / 3600),
      0,
    );
    const counts = {
      inProgress: tasks.filter(t => ACTIVE_STATES.has(t.state)).length,
      upNext: tasks.filter(t => !ACTIVE_STATES.has(t.state) && !DONE_STATES.has(t.state)).length,
      done: tasks.filter(t => DONE_STATES.has(t.state)).length,
    };
    // Session + activity also reflect work logged on the story itself (the
    // header), not just its child tasks — so a session opened directly on a
    // story still marks it live and shows in its feed.
    const signalItems = header ? [header, ...tasks] : tasks;
    const recentActivity = signalItems
      .flatMap(t => t.recentActivity)
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
      .slice(0, 5);
    const hasActiveSession = signalItems.some(t => t.activeSession != null);
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
      tags: parent.tags,
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
  tags?: string[];
}

const FEATURE_LIKE_TYPES = new Set(['feature', 'epic']);

function projectWorkItem(
  w: WorkItem,
  uncaptured: Map<number, number>,
  localLogged: Map<number, number>,
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
    localLoggedSeconds: localLogged.get(w.id) ?? 0,
    runningSince: running.get(w.id),
    activeSession: session ? { id: session.id, startedAt: session.startedAt } : undefined,
    recentActivity: recentEvents.get(w.id) ?? [],
    sessionCount: sessionCounts.get(w.id) ?? 0,
    tags: w.tags,
    parentTags: w.parentTags,
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
