/**
 * Pre-plan page — pure logic + payload builder + local state I/O.
 *
 * This page is Moran's PRIVATE prep for the bi-weekly pre-plan meeting. Nothing
 * here writes to Azure DevOps. Calls/goals/links live in the settings table.
 * See docs/superpowers/specs/2026-06-25-preplan-page-design.md.
 */

export type PrePlanCall = 'on-track' | 'at-risk' | 'carries-over';

export interface PrePlanCard {
  id: string;
  displayName: string;
  remainingHours: number;
  blocked: boolean;
  lastActivityAt: string | null;
  call: PrePlanCall;
  callIsSuggested: boolean;
  goalIndex: number | null;
}

export interface PrePlanRoomLine {
  openStoriesRemainingHours: number;
  roomHours: number;
  hasCapacity: boolean;
}

export interface PrePlanCoverageGoal {
  index: number;
  text: string;
  storyCount: number;
}

export interface PrePlanPayload {
  sprintName: string;
  goals: string[];
  cards: PrePlanCard[];
  coverage: PrePlanCoverageGoal[];
  room: PrePlanRoomLine;
}

export interface PrePlanState {
  goals: string[];
  stories: Record<string, { call?: PrePlanCall; goalIndex?: number | null }>;
}

const MS_PER_DAY = 1000 * 60 * 60 * 24;
const IDLE_WORKING_DAYS_THRESHOLD = 3;

/** Working days (Sun–Thu) elapsed from `from` to `to`. Fri(5)/Sat(6) skipped. */
export function workingDaysBetween(from: Date, to: Date): number {
  if (to <= from) return 0;
  let count = 0;
  // Walk whole days from the day after `from` through `to`.
  const cursor = new Date(from.getTime());
  while (cursor.getTime() < to.getTime()) {
    cursor.setTime(cursor.getTime() + MS_PER_DAY);
    const dow = cursor.getDay(); // 0=Sun … 6=Sat
    if (dow !== 5 && dow !== 6) count++;
  }
  return count;
}

/**
 * Suggest a call from facts the page can read honestly on ONE story. Never
 * returns 'carries-over' (a deliberate planning act, not a guess) and never
 * uses sprint-wide room (shared across stories — see the spec).
 */
export function suggestCall(opts: {
  blocked: boolean;
  lastActivityAt: string | null;
  remainingHours: number;
  now: Date;
  idleWorkingDaysThreshold?: number;
}): 'on-track' | 'at-risk' {
  const threshold = opts.idleWorkingDaysThreshold ?? IDLE_WORKING_DAYS_THRESHOLD;
  if (opts.blocked) return 'at-risk';
  if (opts.remainingHours <= 0) return 'on-track';
  if (opts.lastActivityAt == null) return 'at-risk'; // hours remain, nothing logged
  const idle = workingDaysBetween(new Date(opts.lastActivityAt), opts.now);
  return idle >= threshold ? 'at-risk' : 'on-track';
}

const STOPWORDS = new Set([
  'the', 'a', 'an', 'to', 'of', 'in', 'on', 'for', 'and', 'or', 'from', 'with',
  'is', 'are', 'be', 'this', 'that', 'it', 'as', 'at', 'by', 'we', 'our',
]);

function tokenize(s: string): Set<string> {
  return new Set(
    s
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter(t => t.length > 1 && !STOPWORDS.has(t)),
  );
}

/**
 * Suggest which pasted goal a story serves, by token overlap. Returns null when
 * the best overlap is weak — a wrong link is worse than none (suggest-then-confirm).
 */
export function suggestGoalIndex(storyTitle: string, goals: string[]): number | null {
  if (goals.length === 0) return null;
  const titleTokens = tokenize(storyTitle);
  if (titleTokens.size === 0) return null;
  let bestIdx = -1;
  let bestOverlap = 0;
  goals.forEach((g, i) => {
    const gTokens = tokenize(g);
    let overlap = 0;
    for (const t of gTokens) if (titleTokens.has(t)) overlap++;
    if (overlap > bestOverlap) {
      bestOverlap = overlap;
      bestIdx = i;
    }
  });
  // Require at least 2 shared meaningful words to call it a match.
  return bestOverlap >= 2 ? bestIdx : null;
}

/** Per-goal story counts, in goal order. Empty when there are no goals. */
export function summarizeCoverage(
  cards: Array<{ goalIndex: number | null }>,
  goals: string[],
): PrePlanCoverageGoal[] {
  return goals.map((text, index) => ({
    index,
    text,
    storyCount: cards.filter(c => c.goalIndex === index).length,
  }));
}
