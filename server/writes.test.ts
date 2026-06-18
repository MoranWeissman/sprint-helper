import { describe, it, expect, beforeEach, vi } from 'vitest';
import { deriveStoryPoints } from './story-points';

/**
 * These tests exercise the ADO write paths against an in-memory fake "board"
 * instead of real Azure DevOps. We mock:
 *   - ./config        → a fake org/project so URIs build
 *   - ./timers        → an in-memory settings map (state-name memory + the
 *                       close/reopen markers writes.ts leans on)
 *   - ./story-points  → keep the real deriveStoryPoints, pin workday to 9h
 *   - node:child_process → a fake `az rest` that reads/patches the fake board
 *
 * The fake's "process template" accepts only New / Active / Blocked / Done.
 * It rejects "Closed" with a state-transition error so the done-bucket chain
 * walk (which tries Closed first, then Done) is genuinely exercised.
 */
const h = vi.hoisted(() => ({
  settings: new Map<string, string>(),
  store: new Map<number, { rev: number; fields: Record<string, unknown> }>(),
}));

vi.mock('./config', () => ({
  loadAdoConfig: async () => ({
    organization: 'https://dev.azure.com/org',
    project: 'Proj',
    team: 'Team',
    user: 'moran@example.com',
  }),
}));

vi.mock('./timers', () => ({
  getSetting: (k: string) => h.settings.get(k),
  setSetting: (k: string, v: string) => {
    h.settings.set(k, v);
  },
}));

vi.mock('./story-points', async importOriginal => {
  const orig = await importOriginal<typeof import('./story-points')>();
  return { ...orig, getWorkdayHours: () => 9 };
});

const ACCEPTED_STATES = new Set(['New', 'Active', 'Blocked', 'Done']);

let nextCreatedId = 1000;

function handleAz(args: string[], body: string): string {
  const method = args[args.indexOf('--method') + 1];
  const uri = args[args.indexOf('--uri') + 1];
  const id = Number(uri.match(/\/workitems\/(\d+)/i)?.[1] ?? NaN);

  if (method === 'POST') {
    const patch = JSON.parse(body) as Array<{ op: string; path: string; value?: unknown }>;
    const typeSeg = uri.match(/\/workitems\/\$([^?]+)/i)?.[1] ?? 'Unknown';
    const witType = decodeURIComponent(typeSeg); // '$User%20Story' -> 'User Story'
    const newId = ++nextCreatedId;
    const fields: Record<string, unknown> = {
      'System.WorkItemType': witType,
      'System.State': 'New',
    };
    for (const p of patch) {
      if (p.path.startsWith('/fields/')) fields[p.path.replace('/fields/', '')] = p.value;
      // '/relations/-' (parent links) are not asserted by these tests — ignore.
    }
    h.store.set(newId, { rev: 1, fields });
    return JSON.stringify({
      id: newId,
      fields,
      url: `https://dev.azure.com/org/_apis/wit/workItems/${newId}`,
      _links: { html: { href: `https://dev.azure.com/org/_workitems/edit/${newId}` } },
    });
  }

  if (method === 'GET') {
    // The current-sprint lookup createStory makes before it POSTs.
    if (/_apis\/work\/teamsettings\/iterations/i.test(uri)) {
      return JSON.stringify({ value: [{ path: 'Proj\\Sprint 1' }] });
    }
    const wi = h.store.get(id) ?? { rev: 1, fields: {} };
    return JSON.stringify({ id, rev: wi.rev, fields: wi.fields });
  }

  if (method === 'PATCH') {
    const patch = JSON.parse(body) as Array<{ op: string; path: string; value?: unknown }>;
    const wi = h.store.get(id) ?? { rev: 1, fields: {} };
    for (const p of patch) {
      const field = p.path.replace('/fields/', '');
      if (p.op === 'remove') {
        delete wi.fields[field];
        continue;
      }
      if (field === 'System.State' && !ACCEPTED_STATES.has(String(p.value))) {
        throw new Error(`TF401320: '${String(p.value)}' is not a valid state transition`);
      }
      wi.fields[field] = p.value;
    }
    wi.rev += 1;
    h.store.set(id, wi);
    return JSON.stringify({ id, fields: wi.fields });
  }

  throw new Error(`fake az: unexpected method ${method}`);
}

vi.mock('node:child_process', () => ({
  execFile: (
    _cmd: string,
    args: string[],
    _opts: unknown,
    cb: (err: Error | null, stdout: string, stderr: string) => void,
  ) => {
    const run = (body: string) => {
      queueMicrotask(() => {
        try {
          cb(null, handleAz(args, body), '');
        } catch (e) {
          cb(e as Error, '', (e as Error).message);
        }
      });
    };
    // azStdin pipes the JSON-patch body through stdin (`--body @-`); azExec doesn't.
    if (!args.includes('@-')) {
      run('');
      return {} as unknown;
    }
    let stdinData = '';
    return {
      stdin: {
        write: (s: string) => {
          stdinData += s;
        },
        end: () => run(stdinData),
      },
    } as unknown;
  },
}));

import {
  pushCompletedWork,
  setStateBucket,
  transitionToBlocked,
  transitionFromBlocked,
  setEffortWithDerivedPoints,
  setIterationPath,
  setTitle,
  backfillEstimateIfBlank,
  createStory,
} from './writes';

const F = {
  completed: 'Microsoft.VSTS.Scheduling.CompletedWork',
  remaining: 'Microsoft.VSTS.Scheduling.RemainingWork',
  effort: 'Microsoft.VSTS.Scheduling.Effort',
  points: 'Microsoft.VSTS.Scheduling.StoryPoints',
  state: 'System.State',
  type: 'System.WorkItemType',
  iteration: 'System.IterationPath',
  title: 'System.Title',
} as const;

function seed(id: number, fields: Record<string, unknown>) {
  h.store.set(id, { rev: 1, fields: { ...fields } });
}
const fieldsOf = (id: number) => h.store.get(id)!.fields;

beforeEach(() => {
  h.settings.clear();
  h.store.clear();
});

describe('pushCompletedWork — burn down Remaining as Completed grows', () => {
  it('adds the logged hours to Completed and subtracts them from Remaining', async () => {
    seed(1, { [F.completed]: 1, [F.remaining]: 4 });
    const r = await pushCompletedWork(1, 3600); // +1h
    expect(r.newCompletedHours).toBe(2);
    expect(r.newRemainingHours).toBe(3);
    expect(fieldsOf(1)[F.completed]).toBe(2);
    expect(fieldsOf(1)[F.remaining]).toBe(3);
  });

  it('floors Remaining at zero when the work overran the estimate', async () => {
    seed(2, { [F.completed]: 0, [F.remaining]: 1 });
    const r = await pushCompletedWork(2, 2 * 3600); // +2h against 1h left
    expect(r.newRemainingHours).toBe(0);
    expect(r.newCompletedHours).toBe(2);
  });
});

describe('setStateBucket — chain walk and close/reopen effort preservation', () => {
  it('walks the state chain and remembers the name that worked', async () => {
    seed(3, { [F.state]: 'Active' });
    const resolved = await setStateBucket(3, 'done'); // 'Closed' rejected, 'Done' accepted
    expect(resolved).toBe('Done');
    expect(fieldsOf(3)[F.state]).toBe('Done');
    expect(h.settings.get('state_done')).toBe('Done');
  });

  it('closing with Completed empty auto-fills it from Remaining and remembers both', async () => {
    seed(4, { [F.state]: 'Active', [F.remaining]: 5, [F.completed]: 0 });
    await setStateBucket(4, 'done');
    expect(fieldsOf(4)[F.state]).toBe('Done');
    expect(fieldsOf(4)[F.completed]).toBe(5); // "you used what was left"
    expect(h.settings.get('remaining_prior_to_close_4')).toBe('5');
    expect(h.settings.get('completed_auto_filled_4')).toBe('5');
  });

  it('does not overwrite a Completed value that was already set at close', async () => {
    seed(5, { [F.state]: 'Active', [F.remaining]: 5, [F.completed]: 3 });
    await setStateBucket(5, 'done');
    expect(fieldsOf(5)[F.completed]).toBe(3); // left alone — no auto-fill
    expect(h.settings.get('completed_auto_filled_5')).toBe('');
  });

  it('reopening a closed item restores Remaining and unwinds the auto-filled Completed', async () => {
    seed(6, { [F.state]: 'Active', [F.remaining]: 5, [F.completed]: 0 });
    await setStateBucket(6, 'done'); // auto-fills Completed=5, remembers Remaining=5
    await setStateBucket(6, 'going'); // leaving done
    expect(fieldsOf(6)[F.state]).toBe('Active');
    expect(fieldsOf(6)[F.remaining]).toBe(5); // restored
    expect(fieldsOf(6)[F.completed]).toBe(0); // auto-fill unwound
    expect(h.settings.get('remaining_prior_to_close_6')).toBe('');
    expect(h.settings.get('completed_auto_filled_6')).toBe('');
  });
});

describe('block / unblock — capture and restore the prior state', () => {
  it('blocking captures the prior state; unblocking restores it', async () => {
    seed(7, { [F.state]: 'Active' });
    const blocked = await transitionToBlocked(7);
    expect(blocked.fromState).toBe('Active');
    expect(blocked.toState).toBe('Blocked');
    expect(fieldsOf(7)[F.state]).toBe('Blocked');
    expect(h.settings.get('blocked_prior_state_7')).toBe('Active');

    const unblocked = await transitionFromBlocked(7);
    expect(unblocked.restored).toBe(true);
    expect(unblocked.toState).toBe('Active');
    expect(fieldsOf(7)[F.state]).toBe('Active');
    expect(h.settings.get('blocked_prior_state_7')).toBe('');
  });

  it('unblocking with no captured prior state falls back to the going state', async () => {
    seed(8, { [F.state]: 'Blocked' });
    const r = await transitionFromBlocked(8);
    expect(r.restored).toBe(false);
    expect(r.toState).toBe('Active');
    expect(fieldsOf(8)[F.state]).toBe('Active');
  });
});

describe('setEffortWithDerivedPoints — Effort and StoryPoints land together', () => {
  it('writes Effort and the derived StoryPoints in one shot', async () => {
    seed(9, {});
    const r = await setEffortWithDerivedPoints(9, 18); // workday pinned to 9h
    const expectedPoints = deriveStoryPoints(18, 9); // 18h / 9h = 2 days = 2 points
    expect(r.effort).toBe(18);
    expect(r.storyPoints).toBe(expectedPoints);
    expect(fieldsOf(9)[F.effort]).toBe(18);
    expect(fieldsOf(9)[F.points]).toBe(expectedPoints);
  });
});

describe('setIterationPath — a started story stays put, only tasks (and new stories) move', () => {
  const NEXT = 'Proj\\2026\\Q2\\26_12';

  it('refuses to move a started story to another sprint', async () => {
    seed(10, { [F.type]: 'User Story', [F.state]: 'Active', [F.title]: 'Underway story', [F.iteration]: 'Proj\\2026\\Q2\\26_11' });
    await expect(setIterationPath(10, NEXT)).rejects.toThrow(/underway/i);
    expect(fieldsOf(10)[F.iteration]).toBe('Proj\\2026\\Q2\\26_11'); // unchanged
  });

  it('also refuses a blocked story', async () => {
    seed(11, { [F.type]: 'User Story', [F.state]: 'Blocked', [F.title]: 'Stuck story' });
    await expect(setIterationPath(11, NEXT)).rejects.toThrow();
  });

  it('moves a never-started (New) story', async () => {
    seed(12, { [F.type]: 'User Story', [F.state]: 'New', [F.title]: 'Fresh story' });
    await setIterationPath(12, NEXT);
    expect(fieldsOf(12)[F.iteration]).toBe(NEXT);
  });

  it('always moves a task, even an active one (carryover)', async () => {
    seed(13, { [F.type]: 'Task', [F.state]: 'Active', [F.title]: 'A carried task' });
    await setIterationPath(13, NEXT);
    expect(fieldsOf(13)[F.iteration]).toBe(NEXT);
  });
});

describe('setTitle — rename a work item', () => {
  it('overwrites the title, trimmed, and returns what was written', async () => {
    seed(14, { [F.title]: 'Old name' });
    const written = await setTitle(14, '  New name  ');
    expect(written).toBe('New name');
    expect(fieldsOf(14)[F.title]).toBe('New name');
  });

  it('rejects an empty title', async () => {
    seed(15, { [F.title]: 'Keep me' });
    await expect(setTitle(15, '   ')).rejects.toThrow();
    expect(fieldsOf(15)[F.title]).toBe('Keep me'); // unchanged
  });
});

describe('backfillEstimateIfBlank — fill a blank Original Estimate, never overwrite a set one', () => {
  const EST = 'Microsoft.VSTS.Scheduling.OriginalEstimate';

  it('fills the estimate when the task has none', async () => {
    seed(16, { [F.type]: 'Task', [F.title]: 'No estimate yet' });
    await backfillEstimateIfBlank(16, 3);
    expect(fieldsOf(16)[EST]).toBe(3);
  });

  it('treats 0 as blank and fills it', async () => {
    seed(17, { [F.type]: 'Task', [EST]: 0 });
    await backfillEstimateIfBlank(17, 5);
    expect(fieldsOf(17)[EST]).toBe(5);
  });

  it('refuses to overwrite an estimate that is already set', async () => {
    seed(18, { [F.type]: 'Task', [F.title]: 'Has a baseline', [EST]: 4 });
    await expect(backfillEstimateIfBlank(18, 8)).rejects.toThrow(/baseline|set once|already/i);
    expect(fieldsOf(18)[EST]).toBe(4); // untouched
  });
});

describe('createStory — posts a User Story with planning fields', () => {
  it('creates with title, assignee, sprint, Effort and derived StoryPoints', async () => {
    const created = await createStory({ title: 'A story', effortHours: 9 });
    expect(created.type).toBe('User Story');
    const f = fieldsOf(created.id);
    expect(f[F.title]).toBe('A story');
    expect(f[F.effort]).toBe(9);
    expect(f[F.points]).toBe(1); // 9h / 9h workday = 1 point
    expect(f['System.AssignedTo']).toBe('moran@example.com');
  });
});
