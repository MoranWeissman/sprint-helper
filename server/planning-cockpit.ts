/**
 * Plan cockpit backend.
 *
 * Builds the data the Plan page's planning-ceremony cockpit needs:
 *   - currentSprint + nextSprint iteration metadata so the UI knows what
 *     "Carry to next sprint" actually means;
 *   - openStories: stories in the current sprint that aren't done, with
 *     their not-done child tasks attached;
 *   - backlogStories: stories assigned to Moran that sit on year-level,
 *     quarter-level, or "Backlog"-tagged iteration paths (so they aren't
 *     in any specific sprint yet).
 *
 * No writes — pure read + compute. The action endpoints (move-to-iteration,
 * mark-done) live separately and reuse server/writes.ts.
 */
import { buildDashboardCached } from './dashboard-cache';
import { computeCapacity } from './capacity';
import {
  getCurrentIteration,
  listAllIterations,
  listMyOpenStoriesNotInSprint,
  listMyOpenTasksNotInSprint,
  type Iteration,
  type WorkItem,
} from './ado';

const DONE_STATES = new Set(['Done', 'Closed', 'Resolved', 'Completed', 'Removed']);
// States that mean "this story isn't going to happen" — never offer them to pull.
// Belt-and-suspenders alongside the WIQL exclusion in listMyOpenStoriesNotInSprint.
const DEAD_STATES = new Set(['done', 'closed', 'resolved', 'completed', 'removed', 'canceled', 'cancelled', 'cut']);
// Features / Epics aren't "stories to close out" — they're containers. Skip them.
const FEATURE_LIKE_TYPES = new Set(['feature', 'epic']);

function displayNameFor(id: number | string, title: string): string {
  return `**${title}** (#${id})`;
}

export interface CockpitIteration {
  name: string;
  path: string;
  startDate: string;
  finishDate: string;
}

export interface CockpitOpenTask {
  id: number;
  title: string;
  displayName: string;
  state: string;
  type: string;
  originalEstimate?: number;
  remainingWork?: number;
}

export interface CockpitOpenStory {
  id: number;
  title: string;
  displayName: string;
  /** Real work-item type (User Story / Bug / …) so the UI badges it correctly. */
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
  openTasks: CockpitOpenTask[];
}

// Iteration-path classification lives in a dependency-free leaf module to
// avoid a cycle (dashboard ↔ dashboard-cache ↔ planning-cockpit). Re-exported
// here so this module's existing consumers keep importing from one place.
export {
  classifyIterationLevel,
  isSprintLevel,
  type BacklogLevel,
} from './iteration-paths';
import { classifyIterationLevel, isSprintLevel } from './iteration-paths';
import type { BacklogLevel } from './iteration-paths';

export interface CockpitBacklogStory {
  id: number;
  title: string;
  displayName: string;
  type: string;
  state: string;
  iterationPath: string;
  level: BacklogLevel;
  storyPoints?: number;
  effort?: number;
  originalEstimate?: number;
  remainingWork?: number;
  feature?: { id: number; title: string; displayName: string };
}

export interface CockpitTopUpTask {
  id: number;
  title: string;
  displayName: string;
  state: string;
  type: string;
  remainingWork?: number;
  originalEstimate?: number;
}

export interface CockpitTopUpStory {
  id: number;
  title: string;
  displayName: string;
  type: string;
  state: string;
  /** Where the story lives now: a sprint name (e.g. "26_12") or "Backlog". */
  locationLabel: string;
  /** Sum of open-task remaining (or estimate) hours — what a full pull adds. */
  pullableHours: number;
  openTasks: CockpitTopUpTask[];
}

/**
 * Group open out-of-sprint TASKS under their parent open STORIES, for the
 * "top up this sprint" section. Pure — caller supplies both already-fetched
 * lists, so this is testable with no ADO.
 *
 * Only tasks ever move (Moran's carryover rule); the story stays put. A story
 * with no open tasks is still returned (so "see all my stories" holds) with
 * pullableHours 0 — the UI shows it greyed with no pull button.
 */
export function groupTopUp(stories: WorkItem[], tasks: WorkItem[]): CockpitTopUpStory[] {
  const liveStories = stories.filter(s => !DEAD_STATES.has(s.state.trim().toLowerCase()));
  const byParent = new Map<number, WorkItem[]>();
  for (const t of tasks) {
    if (DEAD_STATES.has(t.state.trim().toLowerCase())) continue;
    if (t.parentId == null) continue;
    const list = byParent.get(t.parentId) ?? [];
    list.push(t);
    byParent.set(t.parentId, list);
  }

  const out: CockpitTopUpStory[] = liveStories.map(s => {
    const childTasks = byParent.get(s.id) ?? [];
    const openTasks: CockpitTopUpTask[] = childTasks.map(t => ({
      id: t.id,
      title: t.title,
      displayName: displayNameFor(t.id, t.title),
      state: t.state,
      type: t.type,
      remainingWork: t.remainingWork,
      originalEstimate: t.originalEstimate,
    }));
    const pullableHours = Math.round(
      openTasks.reduce((sum, t) => sum + (t.remainingWork ?? t.originalEstimate ?? 0), 0),
    );
    return {
      id: s.id,
      title: s.title,
      displayName: displayNameFor(s.id, s.title),
      type: s.type,
      state: s.state,
      locationLabel: topUpLocationLabel(s.iterationPath),
      pullableHours,
      openTasks,
    };
  });

  // Stories with pullable hours first (most hours first); task-less stories last.
  out.sort((a, b) => {
    if ((a.pullableHours > 0) !== (b.pullableHours > 0)) return a.pullableHours > 0 ? -1 : 1;
    if (b.pullableHours !== a.pullableHours) return b.pullableHours - a.pullableHours;
    return b.id - a.id;
  });
  return out;
}

function topUpLocationLabel(iterationPath: string): string {
  if (isSprintLevel(iterationPath)) return iterationPath.split('\\').pop() ?? iterationPath;
  return 'Backlog';
}

/**
 * Real desk time for the next sprint, after Outlook meetings — what the Plan
 * meter measures "pulled work" against. null when there's no next sprint.
 */
export interface CockpitCapacity {
  /** working_days × workday_hours for the next sprint window (before meetings). */
  workingHoursTotal: number;
  /** workingHoursTotal minus meetings from Outlook (busy + OOF; tentative ignored). */
  availableHours: number;
  /** Meeting hours subtracted (0 when no calendar is connected). */
  meetingHours: number;
  /** False when no Outlook calendar URL is configured — then available == working hours. */
  hasUrl: boolean;
}

export interface CockpitPayload {
  currentSprint: CockpitIteration | null;
  nextSprint: CockpitIteration | null;
  nextSprintCapacity: CockpitCapacity | null;
  openStories: CockpitOpenStory[];
  backlogStories: CockpitBacklogStory[];
  topUpStories: CockpitTopUpStory[];
}

export async function buildCockpitPayload(): Promise<CockpitPayload> {
  const [{ payload }, currentIteration, allIterations] = await Promise.all([
    buildDashboardCached(),
    getCurrentIteration(),
    listAllIterations(),
  ]);

  const currentSprint: CockpitIteration | null = currentIteration
    ? toCockpitIteration(currentIteration)
    : null;
  const nextSprint: CockpitIteration | null = pickNextSprint(currentIteration, allIterations);

  // Open stories — from the dashboard's already-built userStories. We trust
  // the dashboard's grouping (stories + child tasks); just filter to
  // not-done stories and not-done child tasks.
  const openStories: CockpitOpenStory[] = [];
  for (const g of payload.userStories) {
    if (DONE_STATES.has(g.state)) continue;
    if (FEATURE_LIKE_TYPES.has(g.type.toLowerCase())) continue; // not a close-out story
    const openTasks: CockpitOpenTask[] = g.tasks
      .filter(t => !DONE_STATES.has(t.state))
      .map(t => ({
        id: Number(t.id),
        title: t.title,
        displayName: displayNameFor(Number(t.id), t.title),
        state: t.state,
        type: t.type,
        originalEstimate: t.originalEstimate,
        remainingWork: t.remainingWork,
      }));
    if (openTasks.length === 0 && g.counts.done === 0) {
      // Story has no children at all yet — still surface it; the DM will
      // want to talk about whether tasks need to be created.
    }
    openStories.push({
      id: Number(g.id),
      title: g.title,
      displayName: displayNameFor(Number(g.id), g.title),
      type: g.type,
      state: g.state,
      totalEstimateHours: g.totalEstimateHours,
      completedHours: g.completedHours,
      remainingHours: g.remainingHours,
      storyPoints: g.storyPoints,
      effort: g.effort,
      feature: g.feature
        ? {
            id: Number(g.feature.id),
            title: g.feature.title,
            displayName: displayNameFor(Number(g.feature.id), g.feature.title),
          }
        : undefined,
      doneTaskCount: g.counts.done,
      totalTaskCount: g.counts.inProgress + g.counts.upNext + g.counts.done,
      openTasks,
    });
  }

  // Backlog — query items NOT in the current sprint. We pull a wider net
  // than getMyWorkItems(currentIterationPath), so we look at the org's
  // backlog conventions: year-level, quarter-level, or Backlog literal.
  // Use an iterationPath wildcard at the team-area level if possible;
  // otherwise loop iterations.
  const backlogStories: CockpitBacklogStory[] = await collectBacklogStories(currentIteration);

  // Top-up — every open out-of-sprint story with its open tasks, so Moran can
  // pull task hours into the CURRENT (running) sprint any time.
  const topUpStories: CockpitTopUpStory[] = await collectTopUpStories(currentIteration);

  // Real desk time for the next sprint, after Outlook meetings — so the Plan
  // meter measures against hours Moran actually has, not raw working hours.
  let nextSprintCapacity: CockpitCapacity | null = null;
  if (nextSprint) {
    const cap = await computeCapacity({
      sprintStart: new Date(nextSprint.startDate),
      sprintEnd: new Date(nextSprint.finishDate),
      plannedHours: 0,
    });
    nextSprintCapacity = {
      workingHoursTotal: cap.workingHoursTotal,
      availableHours: cap.availableHours,
      meetingHours: cap.meetingHours.weighted,
      hasUrl: cap.hasUrl,
    };
  }

  return { currentSprint, nextSprint, nextSprintCapacity, openStories, backlogStories, topUpStories };
}

/**
 * Open stories assigned to Moran that aren't in the current sprint, each with
 * its open tasks — for the "top up this sprint" section. Best-effort: a fetch
 * failure returns [] so the rest of the Plan page still renders.
 */
async function collectTopUpStories(
  currentIteration: Iteration | null,
): Promise<CockpitTopUpStory[]> {
  if (!currentIteration) return [];
  try {
    const [stories, tasks] = await Promise.all([
      listMyOpenStoriesNotInSprint(currentIteration.path),
      listMyOpenTasksNotInSprint(currentIteration.path),
    ]);
    return groupTopUp(stories, tasks);
  } catch {
    return [];
  }
}

function toCockpitIteration(it: Iteration): CockpitIteration {
  return {
    name: it.name,
    path: it.path,
    startDate: it.startDate,
    finishDate: it.finishDate,
  };
}

/**
 * The next sprint after the current one — the one a planning session is
 * building. Shared so the gap scan can target the sprint being planned
 * rather than the one being closed.
 */
export async function resolveNextSprint(): Promise<CockpitIteration | null> {
  const [current, all] = await Promise.all([getCurrentIteration(), listAllIterations().catch(() => [])]);
  return pickNextSprint(current, all);
}

function pickNextSprint(current: Iteration | null, all: Iteration[]): CockpitIteration | null {
  if (!current) return null;
  // Iterations are already sorted by startDate ascending in listAllIterations.
  // "Next" = the first one whose startDate strictly follows current.startDate.
  const after = all
    .filter(it => it.startDate > current.startDate)
    .filter(it => isSprintLevel(it.path));
  if (after.length === 0) return null;
  return toCockpitIteration(after[0]);
}

async function collectBacklogStories(
  currentIteration: Iteration | null,
): Promise<CockpitBacklogStory[]> {
  // One WIQL query: every open User Story assigned to @Me that isn't in the
  // current sprint. Classification of year / quarter / backlog / other-sprint
  // happens here in TS based on the iteration path each item carries back.
  if (!currentIteration) return [];
  const items: WorkItem[] = await listMyOpenStoriesNotInSprint(currentIteration.path);

  const out: CockpitBacklogStory[] = [];
  for (const w of items) {
    // Skip stories that are done / canceled — you can't pull a dead story.
    if (DEAD_STATES.has(w.state.trim().toLowerCase())) continue;
    const level = classifyIterationLevel(w.iterationPath);
    // Items in OTHER specific sprints (past or future) aren't backlog
    // candidates — they're scheduled work for a different sprint.
    if (level === 'sprint' || level == null) continue;
    out.push({
      id: w.id,
      title: w.title,
      displayName: displayNameFor(w.id, w.title),
      type: w.type,
      state: w.state,
      iterationPath: w.iterationPath,
      level,
      storyPoints: w.storyPoints,
      effort: w.effort,
      originalEstimate: w.originalEstimate,
      remainingWork: w.remainingWork,
      feature: w.parentId && w.parentTitle
        ? {
            id: w.parentId,
            title: w.parentTitle,
            displayName: displayNameFor(w.parentId, w.parentTitle),
          }
        : undefined,
    });
  }

  // Sort: by level (backlog literal first, then quarter, then year), then
  // by id desc (newest first within a bucket).
  const levelOrder: Record<BacklogLevel, number> = { backlog: 0, quarter: 1, year: 2 };
  out.sort((a, b) => {
    const lvl = levelOrder[a.level] - levelOrder[b.level];
    if (lvl !== 0) return lvl;
    return b.id - a.id;
  });
  return out;
}
