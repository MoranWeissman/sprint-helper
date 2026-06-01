/**
 * Stale-while-revalidate cache around `buildDashboard`.
 *
 * Every /api/dashboard hit talks to Azure DevOps (work items aren't cached by
 * design — see project_build_state). That makes each load ~2.7s. To keep the
 * dashboard feeling instant for an ADHD-friendly experience, this module
 * memoizes the last successful payload per sprint key in process memory:
 *
 *  - If a cached payload exists, it's returned immediately (`cache: 'stale'`)
 *    and a fresh `buildDashboard` is kicked off in the background to update
 *    the cache for the next hit. The client refetches once on `stale` to pick
 *    up the fresh data shortly after.
 *  - If there's no cache (cold process, first hit ever), we await the real
 *    build, store it, return it (`cache: 'fresh'`).
 *  - At most one background refresh per key runs at a time.
 *
 * Writes (effort/state edits, dismiss-note, schedule changes) call
 * `invalidateDashboardCache()` so the next hit blocks for a real fetch and
 * never serves a payload that contradicts a known change.
 */
import { buildDashboard, type BuildOptions, type DashboardPayload } from './dashboard';

interface CacheEntry {
  payload: DashboardPayload;
  at: number;
  refreshing: Promise<unknown> | null;
}

const cache = new Map<string, CacheEntry>();

function keyFor(opts: BuildOptions): string {
  return opts.sprintName ?? '__current__';
}

export interface CachedDashboardResult {
  payload: DashboardPayload;
  cache: 'fresh' | 'stale';
  cacheAgeMs: number;
}

export async function buildDashboardCached(opts: BuildOptions = {}): Promise<CachedDashboardResult> {
  const key = keyFor(opts);
  const entry = cache.get(key);

  if (entry) {
    if (!entry.refreshing) {
      entry.refreshing = buildDashboard(opts)
        .then(fresh => {
          cache.set(key, { payload: fresh, at: Date.now(), refreshing: null });
        })
        .catch(() => {
          // Refresh failed — keep the stale entry but clear the lock so a later
          // request can try again. The next direct fetch will surface the error.
          const still = cache.get(key);
          if (still) still.refreshing = null;
        });
    }
    return { payload: entry.payload, cache: 'stale', cacheAgeMs: Date.now() - entry.at };
  }

  const payload = await buildDashboard(opts);
  cache.set(key, { payload, at: Date.now(), refreshing: null });
  return { payload, cache: 'fresh', cacheAgeMs: 0 };
}

/** Drop cached payloads so the next request will block on a real Azure DevOps fetch. */
export function invalidateDashboardCache(): void {
  cache.clear();
}
