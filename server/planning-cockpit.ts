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
import {
  getCurrentIteration,
  getMyWorkItems,
  listAllIterations,
  type Iteration,
  type WorkItem,
} from './ado';

const DONE_STATES = new Set(['Done', 'Closed', 'Resolved', 'Completed', 'Removed']);

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

export interface CockpitPayload {
  currentSprint: CockpitIteration | null;
  nextSprint: CockpitIteration | null;
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

  return { currentSprint, nextSprint, openStories, backlogStories };
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

/** Backlog level test based on path depth + literal "Backlog" segment. */
function classifyIterationLevel(path: string): BacklogLevel | 'sprint' | null {
  if (!path) return null;
  const segments = path.split('\\').filter(Boolean);
  if (segments.length === 0) return null;
  const last = segments[segments.length - 1];
  if (/backlog/i.test(last)) return 'backlog';
  // Year segment: ends with a 4-digit year.
  if (/^\d{4}$/.test(last) && segments.length <= 2) return 'year';
  // Quarter segment: ends with Q<digit>.
  if (/^Q\d+$/i.test(last)) return 'quarter';
  // Anything else (named sprint like 26_11) is a real sprint iteration.
  return 'sprint';
}

function isSprintLevel(path: string): boolean {
  return classifyIterationLevel(path) === 'sprint';
}

async function collectBacklogStories(
  currentIteration: Iteration | null,
): Promise<CockpitBacklogStory[]> {
  // Find all candidate iteration paths (year / quarter / backlog) the team
  // uses, then fetch @Me work items under each.
  const all = await listAllIterations();
  const candidateLevels = new Map<string, BacklogLevel>();
  for (const it of all) {
    const lvl = classifyIterationLevel(it.path);
    if (lvl && lvl !== 'sprint') candidateLevels.set(it.path, lvl);
  }
  // listAllIterations only returns iterations with startDate + finishDate.
  // Year and quarter "buckets" usually have those too; if Moran's team
  // doesn't, we may need a separate query. Live with what's exposed first.

  const out: CockpitBacklogStory[] = [];
  for (const [path, level] of candidateLevels) {
    if (currentIteration && path === currentIteration.path) continue;
    const items: WorkItem[] = await getMyWorkItems(path);
    for (const w of items) {
      // Only Stories at backlog level — Tasks belong to their parent story,
      // and Features/Epics aren't planning-ceremony candidates.
      if (w.type !== 'User Story') continue;
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
  }

  // Sort: by level (backlog first, then quarter, then year), then by id desc
  // (newest first within a bucket).
  const levelOrder: Record<BacklogLevel, number> = { backlog: 0, quarter: 1, year: 2 };
  out.sort((a, b) => {
    const lvl = levelOrder[a.level] - levelOrder[b.level];
    if (lvl !== 0) return lvl;
    return b.id - a.id;
  });
  return out;
}
