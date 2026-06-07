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

export type BacklogLevel = 'year' | 'quarter' | 'backlog';

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

  return { currentSprint, nextSprint, nextSprintCapacity, openStories, backlogStories };
}

function toCockpitIteration(it: Iteration): CockpitIteration {
  return {
    name: it.name,
    path: it.path,
    startDate: it.startDate,
    finishDate: it.finishDate,
  };
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

/**
 * Classify a work item's iteration path as backlog vs sprint.
 *
 * Moran's tree shape (verified 2026-06-03 from the iteration picker):
 *   IDP - DevOps                       → backlog (area root, no year)
 *   IDP - DevOps\Backlog               → backlog (literal segment)
 *   IDP - DevOps\2026                  → year
 *   IDP - DevOps\2026\Q1               → quarter
 *   IDP - DevOps\2026\Q1\26_03         → sprint (anything below quarter)
 *
 * Returns null if the path is empty/unparseable.
 */
function classifyIterationLevel(path: string): BacklogLevel | 'sprint' | null {
  if (!path) return null;
  const segments = path.split('\\').filter(Boolean);
  if (segments.length === 0) return null;

  // Any segment literally named "Backlog" → backlog (top wins).
  if (segments.some(s => /^backlog$/i.test(s))) return 'backlog';

  // Single segment = just the area root, no year/quarter chosen → backlog.
  if (segments.length === 1) return 'backlog';

  const last = segments[segments.length - 1];

  // Last segment is a 4-digit year → year-level bucket.
  if (/^\d{4}$/.test(last)) return 'year';

  // Last segment is Q1..Q4 → quarter-level bucket.
  if (/^Q\d+$/i.test(last)) return 'quarter';

  // Anything else (a named sprint like 26_11) is a concrete sprint.
  return 'sprint';
}

function isSprintLevel(path: string): boolean {
  return classifyIterationLevel(path) === 'sprint';
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
