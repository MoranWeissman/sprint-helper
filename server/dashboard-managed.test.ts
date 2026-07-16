import { describe, it, expect } from 'vitest';
import { selectManagedFeatures } from './dashboard';

const CLOSED = new Set(['Closed', 'Removed', 'Done']);

describe('selectManagedFeatures', () => {
  const fetched = [
    { id: 426639, title: 'Declarative CD', type: 'Feature', state: 'New', assignedTo: 'Rom, Guy', url: 'u1' },
    { id: 500, title: 'Closed one', type: 'Feature', state: 'Closed', assignedTo: 'X', url: 'u2' },
  ] as any[];

  it('keeps open managed features not already shown; formats displayName', () => {
    const out = selectManagedFeatures({
      managedIds: [426639, 500],
      alreadyShownIds: new Set<number>(),
      fetched,
    });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ id: 426639, displayName: '**Declarative CD** (#426639)', assignedTo: 'Rom, Guy' });
  });

  it('skips a feature already shown in the sprint payload', () => {
    const out = selectManagedFeatures({
      managedIds: [426639],
      alreadyShownIds: new Set<number>([426639]),
      fetched,
    });
    expect(out).toEqual([]);
  });

  it('dedups repeated managed ids', () => {
    const out = selectManagedFeatures({
      managedIds: [426639, 426639],
      alreadyShownIds: new Set<number>(),
      fetched,
    });
    expect(out).toHaveLength(1);
  });
});
