/**
 * Capacity math (slice R5).
 *
 * Given a sprint window, computes:
 *   working_hours_total  = working_days × workday_hours
 *   meeting_hours        = BUSY + OOF, clipped to the working window
 *                          (8:00–18:00 on working days) so an all-day
 *                          meeting doesn't steal 24 hours. TENTATIVE is
 *                          ignored entirely — see TENTATIVE_WEIGHT below.
 *   available_hours      = working_hours_total - meeting_hours
 *   difference           = planned_hours - available_hours
 *
 * Returns sensible defaults if no calendar URL is configured (available
 * hours = working hours total, hasUrl=false). Errors during fetch are
 * surfaced — never silently swallowed.
 */
import { listBusyInWindow, getCalendarUrl, type BusyInterval } from './calendar';
import { getWorkdayHours } from './story-points';

// Moran-specific defaults: TENTATIVE meetings ignored entirely (he doesn't
// count "maybes" against capacity), Sun-Thu (Israeli workweek — Friday +
// Saturday are off; set 2026-06-04). The workday length is read from
// settings via getWorkdayHours() so effort math and capacity math share
// one source of truth.
const DEFAULT_WORKDAY_START = 8;  // 08:00 local
const DEFAULT_WORKDAY_END = 18;   // 18:00 local
const DEFAULT_WORKING_DAYS = new Set([0, 1, 2, 3, 4]); // Sun-Thu
const TENTATIVE_WEIGHT = 0;

export interface Capacity {
  sprintStart: string;
  sprintEnd: string;
  workingDays: number;
  /**
   * Working days from today (inclusive, if today is a workday) through
   * sprintEnd. 0 once the sprint is over. Use this for "days left" reads on
   * the dashboard — counts Sun-Thu, ignores Fri + Sat.
   */
  workingDaysRemaining: number;
  workdayHours: number;
  workingHoursTotal: number;
  /** workingDaysRemaining × workdayHours — working hours left from today on. */
  workingHoursRemaining: number;
  meetingHours: {
    busy: number;
    tentative: number;
    oof: number;
    weighted: number;
  };
  availableHours: number;
  /**
   * Real desk time STILL AHEAD: remaining working hours minus only the meetings
   * that are still in the future. This is the number that visibly counts down
   * as the sprint progresses (vs availableHours, which is the whole-sprint figure).
   */
  availableHoursRemaining: number;
  plannedHours: number;
  difference: number;
  hasUrl: boolean;
  fetchError?: string;
}

export interface ComputeCapacityOptions {
  sprintStart: Date;
  sprintEnd: Date;
  plannedHours: number;
  /** Defaults: Sun-Thu (Israeli workweek), 8h/day, 08:00–18:00. */
  workingDays?: Set<number>;
  workdayHours?: number;
  workdayStartHour?: number;
  workdayEndHour?: number;
  /** "Now" for the workingDaysRemaining count. Defaults to new Date(). */
  now?: Date;
}

export async function computeCapacity(opts: ComputeCapacityOptions): Promise<Capacity> {
  const workdaySet = opts.workingDays ?? DEFAULT_WORKING_DAYS;
  const workdayHours = opts.workdayHours ?? getWorkdayHours();
  const workdayStart = opts.workdayStartHour ?? DEFAULT_WORKDAY_START;
  const workdayEnd = opts.workdayEndHour ?? DEFAULT_WORKDAY_END;
  const now = opts.now ?? new Date();

  const workingDays = countWorkingDays(opts.sprintStart, opts.sprintEnd, workdaySet);
  const workingHoursTotal = workingDays * workdayHours;

  // Remaining working days = count from today (clamped into the sprint
  // window) through sprintEnd. If today is past sprintEnd, this is 0.
  const remainingStart = now > opts.sprintStart ? now : opts.sprintStart;
  const workingDaysRemaining =
    now > opts.sprintEnd ? 0 : countWorkingDays(remainingStart, opts.sprintEnd, workdaySet);
  const workingHoursRemaining = workingDaysRemaining * workdayHours;

  const baseResult: Capacity = {
    sprintStart: opts.sprintStart.toISOString(),
    sprintEnd: opts.sprintEnd.toISOString(),
    workingDays,
    workingDaysRemaining,
    workdayHours,
    workingHoursTotal,
    workingHoursRemaining,
    meetingHours: { busy: 0, tentative: 0, oof: 0, weighted: 0 },
    availableHours: workingHoursTotal,
    availableHoursRemaining: workingHoursRemaining,
    plannedHours: opts.plannedHours,
    difference: opts.plannedHours - workingHoursTotal,
    hasUrl: getCalendarUrl() != null,
  };

  if (!baseResult.hasUrl) return baseResult;

  let intervals: BusyInterval[];
  try {
    intervals = await listBusyInWindow(opts.sprintStart, opts.sprintEnd);
  } catch (e) {
    return {
      ...baseResult,
      fetchError: e instanceof Error ? e.message : String(e),
    };
  }

  let busyMins = 0;
  let tentativeMins = 0;
  let oofMins = 0;
  // Same buckets but only counting the portion of each meeting still ahead of
  // `now`, so we can work out desk time that's actually still available.
  let remBusyMins = 0;
  let remTentativeMins = 0;
  let remOofMins = 0;
  for (const iv of intervals) {
    const clippedMins = clipToWorkingHours(iv.start, iv.end, workdaySet, workdayStart, workdayEnd);
    if (iv.busyStatus === 'BUSY') busyMins += clippedMins;
    else if (iv.busyStatus === 'TENTATIVE') tentativeMins += clippedMins;
    else if (iv.busyStatus === 'OOF') oofMins += clippedMins;

    const remStart = iv.start < now ? now : iv.start;
    if (remStart < iv.end) {
      const remMins = clipToWorkingHours(remStart, iv.end, workdaySet, workdayStart, workdayEnd);
      if (iv.busyStatus === 'BUSY') remBusyMins += remMins;
      else if (iv.busyStatus === 'TENTATIVE') remTentativeMins += remMins;
      else if (iv.busyStatus === 'OOF') remOofMins += remMins;
    }
  }

  const busy = busyMins / 60;
  const tentative = tentativeMins / 60;
  const oof = oofMins / 60;
  const weighted = busy + tentative * TENTATIVE_WEIGHT + oof;
  const availableHours = Math.max(0, workingHoursTotal - weighted);

  const weightedRemaining = remBusyMins / 60 + (remTentativeMins / 60) * TENTATIVE_WEIGHT + remOofMins / 60;
  const availableHoursRemaining = Math.max(0, workingHoursRemaining - weightedRemaining);

  return {
    ...baseResult,
    meetingHours: { busy, tentative, oof, weighted },
    availableHours,
    availableHoursRemaining,
    difference: opts.plannedHours - availableHours,
  };
}

function countWorkingDays(start: Date, end: Date, workdaySet: Set<number>): number {
  let n = 0;
  const cursor = new Date(start);
  cursor.setHours(0, 0, 0, 0);
  const stop = new Date(end);
  stop.setHours(23, 59, 59, 999);
  while (cursor <= stop) {
    if (workdaySet.has(cursor.getDay())) n++;
    cursor.setDate(cursor.getDate() + 1);
  }
  return n;
}

/**
 * Intersect an event with the working window (workdayStart..workdayEnd local)
 * across only working days. Returns total intersected minutes.
 */
function clipToWorkingHours(
  start: Date,
  end: Date,
  workdaySet: Set<number>,
  workdayStartHour: number,
  workdayEndHour: number,
): number {
  let totalMins = 0;
  const cursor = new Date(start);
  cursor.setHours(0, 0, 0, 0);
  while (cursor <= end) {
    if (workdaySet.has(cursor.getDay())) {
      const dayStart = new Date(cursor);
      dayStart.setHours(workdayStartHour, 0, 0, 0);
      const dayEnd = new Date(cursor);
      dayEnd.setHours(workdayEndHour, 0, 0, 0);
      const overlapStart = start > dayStart ? start : dayStart;
      const overlapEnd = end < dayEnd ? end : dayEnd;
      if (overlapEnd > overlapStart) {
        totalMins += (overlapEnd.getTime() - overlapStart.getTime()) / 60000;
      }
    }
    cursor.setDate(cursor.getDate() + 1);
  }
  return totalMins;
}
