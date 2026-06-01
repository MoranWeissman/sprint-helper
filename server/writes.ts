/**
 * ADO write operations — push local effort to System.CompletedWork and
 * transition state to Done/Closed.
 *
 * Single-user tool, so we don't bother with optimistic concurrency tokens;
 * a GET-then-PATCH race is vanishingly unlikely in practice. If the PATCH
 * fails, the caller queues a pending_changes row for retry.
 */
import { execFile } from 'node:child_process';
import { loadAdoConfig } from './config';
import { getSetting, setSetting } from './timers';

const ADO_RESOURCE = '499b84ac-1321-427f-aa17-267ca6975798';

/**
 * State buckets the UI exposes (waiting / going / done) → ordered list of
 * candidate ADO state names. Different process templates use different names
 * (Agile = Closed, Scrum = Done, CMMI = Resolved). We try each in order and
 * persist the one that worked per bucket in settings.
 */
export const STATE_BUCKET_CHAIN = {
  waiting: ['New', 'To Do', 'Proposed'],
  going:   ['Active', 'In Progress', 'Doing', 'Committed'],
  done:    ['Closed', 'Done', 'Resolved', 'Completed'],
} as const;
export type StateBucket = keyof typeof STATE_BUCKET_CHAIN;

interface AdoWorkItemSlim {
  id: number;
  rev: number;
  fields: {
    'Microsoft.VSTS.Scheduling.CompletedWork'?: number;
    'Microsoft.VSTS.Scheduling.RemainingWork'?: number;
    'System.State'?: string;
    'System.Tags'?: string;
  };
}

/**
 * Fetch the current completedWork value so we can compute the new total.
 * Cheaper than a full work item read because we limit fields.
 */
async function fetchEffortFields(id: number): Promise<AdoWorkItemSlim> {
  const cfg = await loadAdoConfig();
  const fields = [
    'Microsoft.VSTS.Scheduling.CompletedWork',
    'Microsoft.VSTS.Scheduling.RemainingWork',
    'System.State',
    'System.Tags',
  ].join(',');
  const uri = `${cfg.organization}/${encodeURIComponent(cfg.project)}/_apis/wit/workitems/${id}?fields=${encodeURIComponent(fields)}&api-version=7.1`;
  const { stdout } = await azExec(['rest', '--method', 'GET', '--uri', uri, '--resource', ADO_RESOURCE]);
  return JSON.parse(stdout) as AdoWorkItemSlim;
}

/** Parse ADO's "tag1; tag2; tag3" string into a clean lowercased Set. */
function parseTags(raw: string | undefined): Set<string> {
  if (!raw) return new Set();
  return new Set(
    raw
      .split(';')
      .map(t => t.trim())
      .filter(t => t.length > 0),
  );
}

/**
 * Mutate the System.Tags field. Tags are case-sensitive in ADO display but
 * case-insensitive in dedup. `add` and `remove` may overlap; remove wins.
 * Returns the resulting tag list (in canonical order).
 */
export async function updateTags(
  workItemId: number,
  opts: { add?: string[]; remove?: string[] },
): Promise<string[]> {
  const current = await fetchEffortFields(workItemId);
  const tagSet = parseTags(current.fields['System.Tags']);
  // Case-insensitive lookups so we don't dup "Blocked" + "blocked".
  const lowerToCanonical = new Map<string, string>();
  for (const t of tagSet) lowerToCanonical.set(t.toLowerCase(), t);

  for (const t of opts.add ?? []) {
    const lower = t.trim().toLowerCase();
    if (!lower) continue;
    if (!lowerToCanonical.has(lower)) lowerToCanonical.set(lower, t.trim());
  }
  for (const t of opts.remove ?? []) {
    const lower = t.trim().toLowerCase();
    lowerToCanonical.delete(lower);
  }

  const final = Array.from(lowerToCanonical.values()).sort((a, b) => a.localeCompare(b));
  const newValue = final.join('; ');
  await patchWorkItem(workItemId, [
    { op: 'add', path: '/fields/System.Tags', value: newValue },
  ]);
  return final;
}

/**
 * Push local-logged seconds to ADO as additional CompletedWork.
 * Decrements RemainingWork by the same amount (floored at 0).
 *
 * Returns the new ADO state so the caller can decide what to do next.
 */
export async function pushCompletedWork(
  workItemId: number,
  addSeconds: number,
): Promise<{ newCompletedHours: number; newRemainingHours: number }> {
  const current = await fetchEffortFields(workItemId);
  const currentCompleted = current.fields['Microsoft.VSTS.Scheduling.CompletedWork'] ?? 0;
  const currentRemaining = current.fields['Microsoft.VSTS.Scheduling.RemainingWork'] ?? 0;

  const addHours = addSeconds / 3600;
  const newCompleted = round2(currentCompleted + addHours);
  const newRemaining = Math.max(0, round2(currentRemaining - addHours));

  const patch = [
    { op: 'add', path: '/fields/Microsoft.VSTS.Scheduling.CompletedWork', value: newCompleted },
    { op: 'add', path: '/fields/Microsoft.VSTS.Scheduling.RemainingWork', value: newRemaining },
  ];
  await patchWorkItem(workItemId, patch);
  return { newCompletedHours: newCompleted, newRemainingHours: newRemaining };
}

/**
 * Transition an item to a target bucket (waiting / going / done). Tries the
 * previously-successful state name first, then walks the chain. Persists what
 * worked.
 */
export async function setStateBucket(
  workItemId: number,
  bucket: StateBucket,
): Promise<string> {
  const settingKey = `state_${bucket}`;
  const preferred = getSetting(settingKey);
  const chain: string[] = preferred
    ? [preferred, ...STATE_BUCKET_CHAIN[bucket].filter(s => s !== preferred)]
    : [...STATE_BUCKET_CHAIN[bucket]];

  let lastErr: Error | null = null;
  for (const state of chain) {
    try {
      await patchWorkItem(workItemId, [
        { op: 'add', path: '/fields/System.State', value: state },
      ]);
      if (state !== preferred) setSetting(settingKey, state);
      return state;
    } catch (err) {
      lastErr = err instanceof Error ? err : new Error(String(err));
      const msg = lastErr.message.toLowerCase();
      if (
        !msg.includes('valid state') &&
        !msg.includes('transition') &&
        !msg.includes('not allowed') &&
        !msg.includes('invalid')
      ) {
        throw lastErr;
      }
    }
  }
  throw lastErr ?? new Error(`Could not transition to any ${bucket} state.`);
}

/** Back-compat for slice 2 timer-service: stop+done flow. */
export function transitionToDone(workItemId: number): Promise<string> {
  return setStateBucket(workItemId, 'done');
}

const WAITING_STATES_LOWER = new Set(STATE_BUCKET_CHAIN.waiting.map(s => s.toLowerCase()));

/**
 * If the work item is in any "waiting" state (New / To Do / Proposed),
 * transition it to the team's "going" state (Active / In Progress / etc).
 * Called automatically from session_start so opening a session on a New
 * item is the user's declaration that work has started — no manual ADO
 * state flip needed.
 *
 * No-op if the item is already in going/done/unknown.
 */
export async function ensureActive(workItemId: number): Promise<{
  flipped: boolean;
  fromState: string;
  toState: string;
}> {
  const current = await fetchEffortFields(workItemId);
  const fromState = current.fields['System.State'] ?? '';
  if (!WAITING_STATES_LOWER.has(fromState.toLowerCase())) {
    return { flipped: false, fromState, toState: fromState };
  }
  const toState = await setStateBucket(workItemId, 'going');
  return { flipped: true, fromState, toState };
}

export async function setEstimate(workItemId: number, hours: number): Promise<void> {
  await patchWorkItem(workItemId, [
    { op: 'add', path: '/fields/Microsoft.VSTS.Scheduling.OriginalEstimate', value: round2(hours) },
  ]);
}

export async function setRemaining(workItemId: number, hours: number): Promise<void> {
  await patchWorkItem(workItemId, [
    { op: 'add', path: '/fields/Microsoft.VSTS.Scheduling.RemainingWork', value: round2(hours) },
  ]);
}

/**
 * Story-level effort. Two separate ADO fields:
 *  - StoryPoints: Moran's team convention = days.
 *  - Effort:      total hours she thinks the work is.
 * Both are needed so the POM delivery manager sees real planning.
 */
export async function setStoryPoints(workItemId: number, points: number): Promise<void> {
  await patchWorkItem(workItemId, [
    { op: 'add', path: '/fields/Microsoft.VSTS.Scheduling.StoryPoints', value: round2(points) },
  ]);
}

export async function setEffort(workItemId: number, hours: number): Promise<void> {
  await patchWorkItem(workItemId, [
    { op: 'add', path: '/fields/Microsoft.VSTS.Scheduling.Effort', value: round2(hours) },
  ]);
}

/* ============================================================ */
/*  Create                                                       */
/* ============================================================ */

export interface CreateTaskInput {
  title: string;
  description?: string;
  parentStoryId?: number;
  estimateHours?: number;
  /** Tags applied as a list — ADO stores them semicolon-delimited. */
  tags?: string[];
}

export interface CreatedTask {
  id: number;
  title: string;
  type: string;
  state: string;
  url: string;
  webUrl: string;
  parentId?: number;
}

/**
 * Create a new Task in ADO. Defaults: assignee = current user, iteration =
 * current sprint, area = project default. If `parentStoryId` is given, links
 * the new task as a child of that work item.
 */
export async function createTask(input: CreateTaskInput): Promise<CreatedTask> {
  const cfg = await loadAdoConfig();
  // Resolve current iteration so newly-created tasks land in this sprint.
  const iteration = await getCurrentIterationPath();
  if (!iteration) throw new Error('No active sprint found — cannot place new task.');

  const remaining = input.estimateHours ?? 0;
  const patch: Array<Record<string, unknown>> = [
    { op: 'add', path: '/fields/System.Title', value: input.title },
    { op: 'add', path: '/fields/System.AssignedTo', value: cfg.user },
    { op: 'add', path: '/fields/System.IterationPath', value: iteration },
  ];
  if (input.description) {
    patch.push({
      op: 'add',
      path: '/fields/System.Description',
      // ADO accepts plain text in HTML field; escape minimally to be safe.
      value: escapeHtml(input.description),
    });
  }
  if (input.estimateHours != null) {
    patch.push({
      op: 'add',
      path: '/fields/Microsoft.VSTS.Scheduling.OriginalEstimate',
      value: round2(input.estimateHours),
    });
    patch.push({
      op: 'add',
      path: '/fields/Microsoft.VSTS.Scheduling.RemainingWork',
      value: round2(remaining),
    });
  }
  if (input.tags && input.tags.length > 0) {
    patch.push({
      op: 'add',
      path: '/fields/System.Tags',
      value: input.tags.join('; '),
    });
  }
  if (input.parentStoryId) {
    patch.push({
      op: 'add',
      path: '/relations/-',
      value: {
        rel: 'System.LinkTypes.Hierarchy-Reverse',
        url: `${cfg.organization}/_apis/wit/workItems/${input.parentStoryId}`,
      },
    });
  }

  const uri = `${cfg.organization}/${encodeURIComponent(cfg.project)}/_apis/wit/workitems/$Task?api-version=7.1`;
  const { stdout } = await azStdin(
    [
      'rest',
      '--method', 'POST',
      '--uri', uri,
      '--resource', ADO_RESOURCE,
      '--headers', 'Content-Type=application/json-patch+json',
      '--body', '@-',
    ],
    JSON.stringify(patch),
  );

  const created = JSON.parse(stdout) as {
    id: number;
    fields: {
      'System.Title': string;
      'System.WorkItemType': string;
      'System.State': string;
    };
    url: string;
    _links?: { html?: { href?: string } };
  };

  return {
    id: created.id,
    title: created.fields['System.Title'],
    type: created.fields['System.WorkItemType'],
    state: created.fields['System.State'],
    url: created.url,
    webUrl:
      created._links?.html?.href ??
      `${cfg.organization}/${encodeURIComponent(cfg.project)}/_workitems/edit/${created.id}`,
    parentId: input.parentStoryId,
  };
}

export interface CreateStoryInput {
  title: string;
  description?: string;
  /** Moran's team convention: 1 story point = 1 day. */
  storyPoints: number;
  /** Total hours she thinks this story is. */
  effortHours: number;
  /** Optional Feature/Epic id to link the story under. */
  parentFeatureId?: number;
  tags?: string[];
}

export interface CreatedStory {
  id: number;
  title: string;
  type: string;
  state: string;
  url: string;
  webUrl: string;
  parentId?: number;
}

/**
 * Create a new User Story in ADO. Defaults: assignee = current user, iteration =
 * current sprint, area = project default. Always sets StoryPoints + Effort —
 * these are required by callers, not optional, so the POM delivery manager
 * never sees a story with blank planning fields.
 */
export async function createStory(input: CreateStoryInput): Promise<CreatedStory> {
  const cfg = await loadAdoConfig();
  const iteration = await getCurrentIterationPath();
  if (!iteration) throw new Error('No active sprint found — cannot place new story.');

  const patch: Array<Record<string, unknown>> = [
    { op: 'add', path: '/fields/System.Title', value: input.title },
    { op: 'add', path: '/fields/System.AssignedTo', value: cfg.user },
    { op: 'add', path: '/fields/System.IterationPath', value: iteration },
    { op: 'add', path: '/fields/Microsoft.VSTS.Scheduling.StoryPoints', value: round2(input.storyPoints) },
    { op: 'add', path: '/fields/Microsoft.VSTS.Scheduling.Effort', value: round2(input.effortHours) },
  ];
  if (input.description) {
    patch.push({
      op: 'add',
      path: '/fields/System.Description',
      value: escapeHtml(input.description),
    });
  }
  if (input.tags && input.tags.length > 0) {
    patch.push({
      op: 'add',
      path: '/fields/System.Tags',
      value: input.tags.join('; '),
    });
  }
  if (input.parentFeatureId) {
    patch.push({
      op: 'add',
      path: '/relations/-',
      value: {
        rel: 'System.LinkTypes.Hierarchy-Reverse',
        url: `${cfg.organization}/_apis/wit/workItems/${input.parentFeatureId}`,
      },
    });
  }

  const uri = `${cfg.organization}/${encodeURIComponent(cfg.project)}/_apis/wit/workitems/$User%20Story?api-version=7.1`;
  const { stdout } = await azStdin(
    [
      'rest',
      '--method', 'POST',
      '--uri', uri,
      '--resource', ADO_RESOURCE,
      '--headers', 'Content-Type=application/json-patch+json',
      '--body', '@-',
    ],
    JSON.stringify(patch),
  );

  const created = JSON.parse(stdout) as {
    id: number;
    fields: {
      'System.Title': string;
      'System.WorkItemType': string;
      'System.State': string;
    };
    url: string;
    _links?: { html?: { href?: string } };
  };

  return {
    id: created.id,
    title: created.fields['System.Title'],
    type: created.fields['System.WorkItemType'],
    state: created.fields['System.State'],
    url: created.url,
    webUrl:
      created._links?.html?.href ??
      `${cfg.organization}/${encodeURIComponent(cfg.project)}/_workitems/edit/${created.id}`,
    parentId: input.parentFeatureId,
  };
}

async function getCurrentIterationPath(): Promise<string | null> {
  const cfg = await loadAdoConfig();
  const uri = `${cfg.organization}/${encodeURIComponent(cfg.project)}/${encodeURIComponent(cfg.team)}/_apis/work/teamsettings/iterations?$timeframe=current&api-version=7.1`;
  try {
    const { stdout } = await azExec(['rest', '--method', 'GET', '--uri', uri, '--resource', ADO_RESOURCE]);
    const parsed = JSON.parse(stdout) as { value?: Array<{ path: string }> };
    return parsed.value?.[0]?.path ?? null;
  } catch {
    return null;
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\n/g, '<br>');
}

/* ============================================================ */
/*  Low-level                                                    */
/* ============================================================ */

async function patchWorkItem(id: number, patch: Array<Record<string, unknown>>): Promise<void> {
  const cfg = await loadAdoConfig();
  const uri = `${cfg.organization}/${encodeURIComponent(cfg.project)}/_apis/wit/workitems/${id}?api-version=7.1`;
  const body = JSON.stringify(patch);
  await azStdin(
    [
      'rest',
      '--method', 'PATCH',
      '--uri', uri,
      '--resource', ADO_RESOURCE,
      '--headers', 'Content-Type=application/json-patch+json',
      '--body', '@-',
    ],
    body,
  );
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/* ---- exec helpers (mirror server/ado.ts patterns) ---- */

function azExec(args: string[]): Promise<{ stdout: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      'az',
      [...args, '-o', 'json'],
      { maxBuffer: 16 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) reject(enrich(stderr, args));
        else resolve({ stdout: String(stdout) });
      },
    );
  });
}

function azStdin(args: string[], input: string): Promise<{ stdout: string }> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      'az',
      args,
      { maxBuffer: 16 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) reject(enrich(stderr, args));
        else resolve({ stdout: String(stdout) });
      },
    );
    child.stdin?.write(input);
    child.stdin?.end();
  });
}

function enrich(stderr: string | Buffer | undefined, args: string[]): Error {
  const text = String(stderr ?? '');
  const msg = text.includes('not logged in')
    ? 'sprint-helper needs you to run `az login` first.'
    : `az command failed: ${text || 'unknown error'}`;
  const err = new Error(msg);
  (err as unknown as { command: string }).command = `az ${args.join(' ')}`;
  return err;
}
