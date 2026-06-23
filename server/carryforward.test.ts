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

describe('summarizeCarryForward', () => {
  it('returns null when no tasks are stranded', () => {
    expect(summarizeCarryForward([])).toBeNull();
  });

  it('keeps only tasks in a real previous sprint, not backlog/year/quarter', () => {
    const tasks = [
      task(1, 'IDP - DevOps\\2026\\Q2\\26_12'),
      task(2, 'IDP - DevOps\\2026\\Q2\\26_12'),
      task(3, 'IDP - DevOps\\2026'),
      task(4, 'IDP - DevOps\\Backlog'),
    ];
    const r = summarizeCarryForward(tasks);
    expect(r).not.toBeNull();
    expect(r!.count).toBe(2);
    expect(r!.taskIds.sort()).toEqual([1, 2]);
    expect(r!.fromSprintLabel).toBe('26_12');
  });

  it('returns null when every stranded task is backlog-level', () => {
    expect(summarizeCarryForward([task(9, 'IDP - DevOps\\2026')])).toBeNull();
  });

  it('labels by the most common sprint when tasks span several', () => {
    const tasks = [
      task(1, 'IDP - DevOps\\2026\\Q2\\26_12'),
      task(2, 'IDP - DevOps\\2026\\Q2\\26_12'),
      task(3, 'IDP - DevOps\\2026\\Q1\\26_11'),
    ];
    const r = summarizeCarryForward(tasks);
    expect(r!.count).toBe(3);
    expect(r!.fromSprintLabel).toBe('26_12');
  });
});
