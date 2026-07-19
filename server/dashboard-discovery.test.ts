import { describe, it, expect } from 'vitest';
import { buildDiscoveryBlock } from './dashboard';

describe('buildDiscoveryBlock', () => {
  const af = { id: 426639, title: 'Declarative CD', folderPath: '/w/426639-declarative-cd', setAt: '2026-07-19T10:00:00.000Z' };

  it('maps active feature to displayName + folderPath, managed to displayName list', () => {
    const b = buildDiscoveryBlock({
      activeFeature: af,
      managedIds: [426639],
      fetched: [{ id: 426639, title: 'Declarative CD' }],
      hasWorkspace: true,
    });
    expect(b.activeFeature).toEqual({
      id: 426639,
      displayName: '**Declarative CD** (#426639)',
      folderPath: '/w/426639-declarative-cd',
    });
    expect(b.managed).toEqual([{ id: 426639, displayName: '**Declarative CD** (#426639)' }]);
    expect(b.hasWorkspace).toBe(true);
  });

  it('null active feature when none set', () => {
    const b = buildDiscoveryBlock({ activeFeature: null, managedIds: [], fetched: [], hasWorkspace: true });
    expect(b.activeFeature).toBeNull();
    expect(b.managed).toEqual([]);
  });

  it('falls back to #id displayName when a managed id has no fetched title', () => {
    const b = buildDiscoveryBlock({ activeFeature: null, managedIds: [999], fetched: [], hasWorkspace: true });
    expect(b.managed).toEqual([{ id: 999, displayName: '#999' }]);
  });

  it('hasWorkspace false passes through', () => {
    const b = buildDiscoveryBlock({ activeFeature: null, managedIds: [], fetched: [], hasWorkspace: false });
    expect(b.hasWorkspace).toBe(false);
  });
});
