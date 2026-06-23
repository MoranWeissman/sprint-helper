import { describe, it, expect } from 'vitest';
import { summarizeCarryForward } from './dashboard';
import type { WorkItem } from './ado';

function task(id: number, iterationPath: string): WorkItem {
  return {
    id, rev: 1, type: 'Task', title: `#${id}`, state: 'New',
    assignedTo: 'me', iterationPath, areaPath: 'A',
    changedDate: '2026-06-23T00:00:00Z',
    url: `https://x/_apis/wit/workItems/${id}`,
  } as WorkItem;
}

// Past sprints, newest first — what buildDashboard passes in. Current is 26_13;
// 26_14 is a FUTURE sprint and is deliberately NOT in this set.
const PAST = new Set([
  'IDP - DevOps\\2026\\Q2\\26_12',
  'IDP - DevOps\\2026\\Q1\\26_11',
]);

describe('summarizeCarryForward', () => {
  it('returns null when no tasks are stranded', () => {
    expect(summarizeCarryForward([], PAST)).toBeNull();
  });

  it('keeps only tasks in a real previous sprint, not backlog/year/quarter', () => {
    const tasks = [
      task(1, 'IDP - DevOps\\2026\\Q2\\26_12'),
      task(2, 'IDP - DevOps\\2026\\Q2\\26_12'),
      task(3, 'IDP - DevOps\\2026'),
      task(4, 'IDP - DevOps\\Backlog'),
    ];
    const r = summarizeCarryForward(tasks, PAST);
    expect(r).not.toBeNull();
    expect(r!.count).toBe(2);
    expect(r!.taskIds.sort()).toEqual([1, 2]);
    expect(r!.fromSprintLabel).toBe('26_12');
  });

  it('returns null when every stranded task is backlog-level', () => {
    expect(summarizeCarryForward([task(9, 'IDP - DevOps\\2026')], PAST)).toBeNull();
  });

  it('EXCLUDES tasks parked in a FUTURE sprint (not pulled backward)', () => {
    const tasks = [
      task(1, 'IDP - DevOps\\2026\\Q2\\26_12'),  // past — counts
      task(2, 'IDP - DevOps\\2026\\Q2\\26_14'),  // future — must be dropped
    ];
    const r = summarizeCarryForward(tasks, PAST);
    expect(r!.count).toBe(1);
    expect(r!.taskIds).toEqual([1]);
    expect(r!.fromSprintLabel).toBe('26_12');
  });

  it('returns null when the only stranded task is in a future sprint', () => {
    expect(summarizeCarryForward([task(5, 'IDP - DevOps\\2026\\Q2\\26_14')], PAST)).toBeNull();
  });

  it('labels with the most recent past sprint when tasks span several', () => {
    const tasks = [
      task(1, 'IDP - DevOps\\2026\\Q1\\26_11'),
      task(2, 'IDP - DevOps\\2026\\Q2\\26_12'),
      task(3, 'IDP - DevOps\\2026\\Q1\\26_11'),
    ];
    const r = summarizeCarryForward(tasks, PAST);
    expect(r!.count).toBe(3);
    // 26_12 is newer than 26_11 (PAST is newest-first), so it labels 26_12
    // even though 26_11 has more tasks.
    expect(r!.fromSprintLabel).toBe('26_12');
  });
});
