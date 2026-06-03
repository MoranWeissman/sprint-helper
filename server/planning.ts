/**
 * Plan mode backend (R12 Thread 3).
 *
 * Finds sprint items missing effort fields, grouped by feature/story.
 * Attaches a deterministic anchor proposal per gap (median sibling actual
 * from `estimate_anchor` when siblings exist; cold-start flag otherwise).
 * Assembles a verbose paste-ready Claude Code prompt that the dashboard's
 * "Copy prompt" button hands to Moran.
 *
 * No ADO writes. No mutations anywhere — pure read + compute + format.
 */
import { buildDashboardCached } from './dashboard-cache';
import { buildEstimateAnchor } from './estimate-anchor';
import type {
  UserStoryGroup,
  DashboardWorkItem,
} from './dashboard';

export type GapKind = 'task' | 'story' | 'feature' | 'epic';

export interface PlanningGap {
  kind: GapKind;
  workItemId: number;
  title: string;
  /** Pre-formatted `**title** (#id)` — echo verbatim. */
  displayName: string;
  /** Which planning fields are blank. */
  missing: string[];
  /** Parent for grouping + anchor lookup. */
  parent: {
    workItemId: number;
    title: string;
    displayName: string;
    type: string;
  } | null;
  /** Feature/Epic above the story-level item, if any (skipped when self-ref). */
  feature: {
    workItemId: number;
    title: string;
    displayName: string;
    type: string;
  } | null;
  /** Deterministic anchor proposal pulled from estimate_anchor. */
  anchor: GapAnchor;
}

export interface GapAnchor {
  /** True when no historical sibling data exists — chat conversation needed. */
  isColdStart: boolean;
  /** Median actual hours of closed siblings under the same parent. */
  siblingMedianActual: number | null;
  /** Count of closed siblings the median came from. */
  siblingSampleCount: number;
  /** Moran's overall ratio of actual/estimate (>1 = he underestimates). */
  calibrationOverallRatio: number | null;
  /** Human-friendly sentence the UI can render inline. */
  summary: string;
}

export interface PlanningGapsResult {
  fetchedAt: string;
  totalGaps: number;
  gaps: PlanningGap[];
  /** Paste-ready Claude Code prompt assembled from the gap list. */
  prompt: string;
}

function makeDisplayName(workItemId: number, title: string): string {
  return `**${title}** (#${workItemId})`;
}

/** Classify a raw ADO work item type into the kinds Plan mode cares about. */
function kindFor(adoType: string): GapKind {
  const t = adoType.toLowerCase();
  if (t === 'task') return 'task';
  if (t === 'feature') return 'feature';
  if (t === 'epic') return 'epic';
  return 'story';
}

/**
 * Human-friendly label for a kind — what the prompt should say. Capitalized
 * because it leads each gap line, and we read the prompt out loud sometimes.
 */
function kindLabel(kind: GapKind): string {
  switch (kind) {
    case 'task': return 'Task';
    case 'feature': return 'Feature';
    case 'epic': return 'Epic';
    case 'story': return 'Story';
  }
}

function taskMissing(task: DashboardWorkItem): string[] {
  const missing: string[] = [];
  if (task.originalEstimate == null) missing.push('OriginalEstimate');
  if (task.remainingWork == null) missing.push('RemainingWork');
  return missing;
}

/**
 * Per-type planning fields. Only User Stories are flagged in Plan mode.
 * Effort (hours) is the single field the POM delivery manager reads at
 * the Story level — Story Points are derived from Effort whenever Effort
 * is written, so an item with Effort set is never a planning gap even if
 * points are absent or drifted. The sync sweep heals drift; on-edit
 * derivation prevents new drift. Features and Epics: planning fields
 * optional in Moran's tenant (decision 2026-06-03). Tasks: handled
 * separately by taskMissing().
 */
export function storyMissing(g: UserStoryGroup): string[] {
  if (kindFor(g.type) !== 'story') return [];
  if (g.effort == null) return ['Effort'];
  return [];
}

/**
 * Build a one-line summary the dashboard can show inline next to the gap.
 * Plain English; no banned words.
 */
function summarizeAnchor(parts: Omit<GapAnchor, 'summary'>): string {
  if (parts.isColdStart) {
    return 'No closed siblings under this parent yet — needs a real conversation, not a quick accept.';
  }
  if (parts.siblingMedianActual != null && parts.siblingSampleCount > 0) {
    return `Past tasks under this parent ran about ${parts.siblingMedianActual}h actual on average (${parts.siblingSampleCount} closed). The anchor proposes about ${parts.siblingMedianActual}h.`;
  }
  if (parts.calibrationOverallRatio != null) {
    return `No closed siblings under this parent, but tasks overall run about ${parts.calibrationOverallRatio}× their estimate. The anchor will use that calibration as a fallback.`;
  }
  return 'No historical anchor available. Needs a real conversation.';
}

async function buildAnchor(parentId: number | null): Promise<GapAnchor> {
  if (parentId == null) {
    const base = {
      isColdStart: true,
      siblingMedianActual: null,
      siblingSampleCount: 0,
      calibrationOverallRatio: null,
    };
    return { ...base, summary: summarizeAnchor(base) };
  }
  try {
    const a = await buildEstimateAnchor({ parentId });
    // Median sibling ACTUAL — anchor proposes against the parent's own history.
    const actuals = a.siblings.map(s => s.actual).sort((x, y) => x - y);
    const median = actuals.length > 0 ? round2(actuals[Math.floor(actuals.length / 2)]) : null;
    const base = {
      isColdStart: a.isColdStart,
      siblingMedianActual: median,
      siblingSampleCount: a.siblings.length,
      calibrationOverallRatio: a.calibration.overallRatio,
    };
    return { ...base, summary: summarizeAnchor(base) };
  } catch {
    const base = {
      isColdStart: true,
      siblingMedianActual: null,
      siblingSampleCount: 0,
      calibrationOverallRatio: null,
    };
    return { ...base, summary: summarizeAnchor(base) };
  }
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Find planning gaps across the current sprint. Tasks count as a gap when
 * OriginalEstimate OR RemainingWork is missing; stories/features/epics
 * count when StoryPoints (stories only) OR Effort is missing.
 */
export async function findGaps(): Promise<PlanningGapsResult> {
  const { payload } = await buildDashboardCached();
  const gaps: PlanningGap[] = [];

  if (!payload.sprint) {
    return {
      fetchedAt: new Date().toISOString(),
      totalGaps: 0,
      gaps: [],
      prompt: 'No active sprint — nothing to plan.',
    };
  }

  // 1. Task gaps — walk inProgress + upNext only (done tasks are closed out).
  const taskGapInputs: Array<{ task: DashboardWorkItem; parentId: number | null }> = [];
  for (const list of [payload.workItems.inProgress, payload.workItems.upNext]) {
    for (const w of list) {
      if (w.type !== 'Task') continue;
      const missing = taskMissing(w);
      if (missing.length === 0) continue;
      taskGapInputs.push({ task: w, parentId: w.parent ? Number(w.parent.id) : null });
    }
  }

  // 2. Story / Feature / Epic gaps — skip done items; Moran won't go back
  //    to fill closed work.
  const storyGapInputs: Array<{ story: UserStoryGroup }> = [];
  for (const g of payload.userStories) {
    const isDone = ['Done', 'Closed', 'Resolved', 'Completed', 'Removed'].includes(g.state);
    if (isDone) continue;
    if (storyMissing(g).length === 0) continue;
    storyGapInputs.push({ story: g });
  }

  // Anchor lookups run in parallel — they hit the ADO cache so this stays fast.
  const taskAnchors = await Promise.all(
    taskGapInputs.map(({ parentId }) => buildAnchor(parentId)),
  );
  // For story-level items, the anchor parent is the entry's own feature.
  // When the entry IS a Feature/Epic (top of the tree), there's no meaningful
  // sibling history — pass null and let buildAnchor return cold-start.
  const storyAnchors = await Promise.all(
    storyGapInputs.map(({ story }) => {
      const featId = story.feature && Number(story.feature.id) !== Number(story.id)
        ? Number(story.feature.id)
        : null;
      return buildAnchor(featId);
    }),
  );

  taskGapInputs.forEach(({ task }, idx) => {
    const parent = task.parent
      ? {
          workItemId: Number(task.parent.id),
          title: task.parent.title,
          displayName: makeDisplayName(Number(task.parent.id), task.parent.title),
          type: task.parent.type,
        }
      : null;
    gaps.push({
      kind: 'task',
      workItemId: Number(task.id),
      title: task.title,
      displayName: makeDisplayName(Number(task.id), task.title),
      missing: taskMissing(task),
      parent,
      feature: null,
      anchor: taskAnchors[idx],
    });
  });

  storyGapInputs.forEach(({ story }, idx) => {
    // Drop the self-reference the dashboard sets on top-level Features —
    // a "Story under itself" line reads dumb and isn't actionable.
    const feature = story.feature && Number(story.feature.id) !== Number(story.id)
      ? {
          workItemId: Number(story.feature.id),
          title: story.feature.title,
          displayName: makeDisplayName(Number(story.feature.id), story.feature.title),
          type: story.feature.type,
        }
      : null;
    gaps.push({
      kind: kindFor(story.type),
      workItemId: Number(story.id),
      title: story.title,
      displayName: makeDisplayName(Number(story.id), story.title),
      missing: storyMissing(story),
      parent: null,
      feature,
      anchor: storyAnchors[idx],
    });
  });

  const prompt = assemblePlanningPrompt(gaps);

  return {
    fetchedAt: new Date().toISOString(),
    totalGaps: gaps.length,
    gaps,
    prompt,
  };
}

/**
 * Build the paste-ready Claude Code prompt. Names before numbers; echoes
 * `displayName` verbatim. Verbose on purpose — when pasted into a fresh
 * chat with no context, the model needs to be reminded of the ritual.
 */
export function assemblePlanningPrompt(gaps: PlanningGap[]): string {
  if (gaps.length === 0) {
    return 'No items need effort right now — every Task and Story in the current sprint has its planning fields filled in.';
  }

  const header = [
    'Please help me fill in missing effort for these sprint items. For each, run',
    'the decompose-anchor-propose ritual:',
    '',
    "  1. Call `mcp__sprint-helper__estimate_anchor` with the item's parent id.",
    '  2. Decompose the task into 2-4 sub-steps.',
    '  3. Propose hours with the citation visible (per',
    '     feedback_effort_propose_burndown).',
    '  4. Wait for my confirmation before patching via `workitem_edit`.',
    '',
    "Walk these one at a time, in order. Don't ask which to start with — start",
    'with the first one.',
    '',
    `Items needing effort (${gaps.length} total):`,
    '',
  ];

  const lines: string[] = [];
  for (const g of gaps) {
    const label = kindLabel(g.kind);
    let under: string;
    if (g.kind === 'task') {
      under = g.parent ? `${label} under ${g.parent.displayName}` : `${label} (no parent story)`;
    } else if (g.feature) {
      under = `${label} under ${g.feature.displayName}`;
    } else {
      // Top-level Feature or Epic, OR a Story without a parent Feature.
      // Either way, no "under X" suffix — just announce the kind.
      under = `${label} (top-level)`;
    }
    lines.push(`- ${g.displayName} — ${under}.`);
    lines.push(`  Missing: ${g.missing.join(', ')}.`);
  }

  return [...header, ...lines].join('\n');
}
