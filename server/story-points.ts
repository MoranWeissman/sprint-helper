/**
 * Story Points are a derived view of Effort (hours), never independently entered.
 *
 *   pointsAsDays = effortHours / workdayHours
 *   storyPoints  = round(pointsAsDays * 2) / 2     // nearest half-point
 *
 * Workday hours come from the local settings table (key `workday_hours`),
 * falling back to 9 if unset. Capacity math reads from the same source so
 * effort and capacity can never disagree about a "day."
 */
import { getSetting } from './timers';

/** Read the configured workday in hours. Defaults to 9 when unset. */
export function getWorkdayHours(): number {
  const raw = getSetting('workday_hours');
  if (!raw) return 9;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 9;
}

/**
 * Derive Story Points from Effort hours. Rounds to the nearest 0.5 so the
 * board still reads as "Nd" in half-day increments. Negative effort clamps
 * to 0.
 */
export function deriveStoryPoints(effortHours: number, workdayHours: number): number {
  if (!Number.isFinite(effortHours) || effortHours <= 0) return 0;
  if (!Number.isFinite(workdayHours) || workdayHours <= 0) return 0;
  const days = effortHours / workdayHours;
  return Math.round(days * 2) / 2;
}
