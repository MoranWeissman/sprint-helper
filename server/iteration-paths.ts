/**
 * Iteration-path classification — pure, dependency-free.
 *
 * Lives in its own leaf module (no imports) so any module can classify an
 * Azure DevOps iteration path without pulling in the planning cockpit or the
 * dashboard. Keeping it here avoids a module cycle: both `planning-cockpit`
 * and `dashboard` need these rules, and `planning-cockpit` is downstream of
 * `dashboard-cache` which is downstream of `dashboard`.
 */

export type BacklogLevel = 'year' | 'quarter' | 'backlog';

/**
 * Classify a work item's iteration path as backlog vs sprint.
 *
 * Moran's tree shape (verified 2026-06-03 from the iteration picker):
 *   IDP - DevOps                       → backlog (area root, no year)
 *   IDP - DevOps\Backlog               → backlog (literal segment)
 *   IDP - DevOps\2026                  → year
 *   IDP - DevOps\2026\Q1               → quarter
 *   IDP - DevOps\2026\Q1\26_03         → sprint (anything below quarter)
 *
 * Returns null if the path is empty/unparseable.
 */
export function classifyIterationLevel(path: string): BacklogLevel | 'sprint' | null {
  if (!path) return null;
  const segments = path.split('\\').filter(Boolean);
  if (segments.length === 0) return null;

  // Any segment literally named "Backlog" → backlog (top wins).
  if (segments.some(s => /^backlog$/i.test(s))) return 'backlog';

  // Single segment = just the area root, no year/quarter chosen → backlog.
  if (segments.length === 1) return 'backlog';

  const last = segments[segments.length - 1];

  // Last segment is a 4-digit year → year-level bucket.
  if (/^\d{4}$/.test(last)) return 'year';

  // Last segment is Q1..Q4 → quarter-level bucket.
  if (/^Q\d+$/i.test(last)) return 'quarter';

  // Anything else (a named sprint like 26_11) is a concrete sprint.
  return 'sprint';
}

export function isSprintLevel(path: string): boolean {
  return classifyIterationLevel(path) === 'sprint';
}
