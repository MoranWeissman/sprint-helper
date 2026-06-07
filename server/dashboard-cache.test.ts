import { describe, it, expect, beforeEach, vi } from 'vitest';

// The cache wraps buildDashboard. We replace it with a counter so each build
// is observable, and an optional "gate" promise lets a test hold a background
// refresh open to inspect what happens while it's still in flight.
const h = vi.hoisted(() => ({
  buildCalls: 0,
  gate: null as null | { promise: Promise<void>; resolve: () => void },
}));

vi.mock('./dashboard', () => ({
  buildDashboard: async () => {
    h.buildCalls += 1;
    const tag = h.buildCalls;
    if (h.gate) await h.gate.promise;
    return { workItems: [], tag };
  },
}));

import { buildDashboardCached, invalidateDashboardCache } from './dashboard-cache';

function makeGate() {
  let resolve!: () => void;
  const promise = new Promise<void>(r => {
    resolve = r;
  });
  return { promise, resolve };
}

const tagOf = (payload: unknown) => (payload as { tag: number }).tag;

beforeEach(() => {
  invalidateDashboardCache();
  h.buildCalls = 0;
  h.gate = null;
});

describe('buildDashboardCached — stale-while-revalidate', () => {
  it('cold cache builds fresh and blocks for the real payload', async () => {
    const r = await buildDashboardCached();
    expect(r.cache).toBe('fresh');
    expect(r.cacheAgeMs).toBe(0);
    expect(h.buildCalls).toBe(1);
    expect(tagOf(r.payload)).toBe(1);
  });

  it('serves the stale payload instantly, then updates from the background refresh', async () => {
    const first = await buildDashboardCached(); // warm: tag 1
    expect(first.cache).toBe('fresh');

    // Hold the next build so we can observe the stale-serve before it finishes.
    h.gate = makeGate();
    const second = await buildDashboardCached();
    expect(second.cache).toBe('stale');
    expect(tagOf(second.payload)).toBe(1); // old payload — refresh not done yet
    expect(h.buildCalls).toBe(2); // background build started

    // Let the background build complete and write its result into the cache.
    h.gate.resolve();
    await new Promise(r => setTimeout(r, 0));
    h.gate = null;

    const third = await buildDashboardCached();
    expect(third.cache).toBe('stale');
    expect(tagOf(third.payload)).toBe(2); // now serves the refreshed payload
  });

  it('runs at most one background refresh at a time', async () => {
    await buildDashboardCached(); // warm: calls = 1
    h.gate = makeGate(); // hold background builds open

    const a = await buildDashboardCached();
    expect(a.cache).toBe('stale');
    expect(h.buildCalls).toBe(2); // one background refresh kicked off

    const b = await buildDashboardCached();
    expect(b.cache).toBe('stale');
    expect(h.buildCalls).toBe(2); // still just the one in-flight refresh

    h.gate.resolve();
  });

  it('invalidate forces the next read to block on a fresh build', async () => {
    await buildDashboardCached(); // calls = 1
    invalidateDashboardCache();
    const r = await buildDashboardCached();
    expect(r.cache).toBe('fresh');
    expect(h.buildCalls).toBe(2);
  });
});
