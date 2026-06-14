import { describe, it, expect } from 'vitest';
import { buildTaskMeta } from './dashboard';
import type { WorkItem } from './ado';

// Regression test for the bug Moran hit: a closed User Story
// ("Prod addons ArgoCD ready to start migration") still showed as "going" in
// the morning recap. The recap reads each story's live state from taskMeta,
// but taskMeta was built only from the user's own sprint items — and a story
// worked through its child Tasks isn't its own row, so its state went missing
// and the UI fell back to "going". taskMeta must also reach the parent story's
// state via the parent fields every child task carries.

function raw(over: Partial<WorkItem> & { id: number; type: string; title: string; state: string }): WorkItem {
  return {
    rev: 1,
    areaPath: 'Area',
    iterationPath: 'Proj\\26_11',
    changedDate: '2026-06-07T00:00:00Z',
    url: `https://dev.azure.com/o/_apis/wit/workItems/${over.id}`,
    ...over,
  } as WorkItem;
}

describe('buildTaskMeta — parent story state is reachable for the recap', () => {
  it('seeds a parent story (absent from items) from its child task parentState', () => {
    // Only the closed child Task is in the sprint item list; the Story itself
    // is present only as the task's parent fields.
    const task = raw({
      id: 300,
      type: 'Task',
      title: 'Deploy hello-world',
      state: 'Closed',
      parentId: 200,
      parentTitle: 'Prod addons ArgoCD ready to start migration',
      parentType: 'User Story',
      parentState: 'Closed',
    });

    const meta = buildTaskMeta([task]);

    expect(meta.get(200)?.state).toBe('Closed');
    expect(meta.get(200)?.type).toBe('User Story');
    expect(meta.get(200)?.title).toBe('Prod addons ArgoCD ready to start migration');
  });

  it('lets a real story item row win over the parent-derived fallback', () => {
    const story = raw({ id: 200, type: 'User Story', title: 'Story', state: 'Active' });
    const task = raw({
      id: 300,
      type: 'Task',
      title: 'T',
      state: 'Closed',
      parentId: 200,
      parentTitle: 'Story',
      parentType: 'User Story',
      parentState: 'StaleValue',
    });

    const meta = buildTaskMeta([story, task]);

    expect(meta.get(200)?.state).toBe('Active');
  });
});
