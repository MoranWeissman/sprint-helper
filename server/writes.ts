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
  ].join(',');
  const uri = `${cfg.organization}/${encodeURIComponent(cfg.project)}/_apis/wit/workitems/${id}?fields=${encodeURIComponent(fields)}&api-version=7.1`;
  const { stdout } = await azExec(['rest', '--method', 'GET', '--uri', uri, '--resource', ADO_RESOURCE]);
  return JSON.parse(stdout) as AdoWorkItemSlim;
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
