/**
 * Capacity math (slice R5).
 *
 * Given a sprint window, computes:
 *   working_hours_total  = working_days × workday_hours
 *   meeting_hours        = BUSY + (TENTATIVE × 0.5) + OOF, clipped to the
 *                          working window (8:00–18:00 on working days),
 *                          so an all-day meeting doesn't steal 24 hours.
 *   available_hours      = working_hours_total - meeting_hours
 *   difference           = planned_hours - available_hours
 *
 * Returns sensible defaults if no calendar URL is configured (available
 * hours = working hours total, hasUrl=false). Errors during fetch are
 * surfaced — never silently swallowed.
 */
import { listBusyInWindow, getCalendarUrl, type BusyInterval } from './calendar';

// Moran-specific defaults (2026-06-01): 9h workday, TENTATIVE meetings
// ignored entirely (he doesn't count "maybes" against capacity), Mon-Fri.
const DEFAULT_WORKDAY_HOURS = 9;
const DEFAULT_WORKDAY_START = 8;  // 08:00 local
const DEFAULT_WORKDAY_END = 18;   // 18:00 local
const DEFAULT_WORKING_DAYS = new Set([1, 2, 3, 4, 5]); // Mon-Fri
const TENTATIVE_WEIGHT = 0;

export interface Capacity {
  sprintStart: string;
  sprintEnd: string;
  workingDays: number;
  workdayHours: number;
  workingHoursTotal: number;
  meetingHours: {
    busy: number;
    tentative: number;
    oof: number;
    weighted: number;
  };
  availableHours: number;
  plannedHours: number;
  difference: number;
  hasUrl: boolean;
  fetchError?: string;
}

export interface ComputeCapacityOptions {
  sprintStart: Date;
  sprintEnd: Date;
  plannedHours: number;
  /** Defaults: Mon-Fri, 8h/day, 08:00–18:00. */
  workingDays?: Set<number>;
  workdayHours?: number;
  workdayStartHour?: number;
  workdayEndHour?: number;
}

export async function computeCapacity(opts: ComputeCapacityOptions): Promise<Capacity> {
  const workdaySet = opts.workingDays ?? DEFAULT_WORKING_DAYS;
  const workdayHours = opts.workdayHours ?? DEFAULT_WORKDAY_HOURS;
  const workdayStart = opts.workdayStartHour ?? DEFAULT_WORKDAY_START;
  const workdayEnd = opts.workdayEndHour ?? DEFAULT_WORKDAY_END;

  const workingDays = countWorkingDays(opts.sprintStart, opts.sprintEnd, workdaySet);
  const workingHoursTotal = workingDays * workdayHours;

  const baseResult: Capacity = {
    sprintStart: opts.sprintStart.toISOString(),
    sprintEnd: opts.sprintEnd.toISOString(),
    workingDays,
    workdayHours,
    workingHoursTotal,
    meetingHours: { busy: 0, tentative: 0, oof: 0, weighted: 0 },
    availableHours: workingHoursTotal,
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
  for (const iv of intervals) {
    const clippedMins = clipToWorkingHours(iv.start, iv.end, workdaySet, workdayStart, workdayEnd);
    if (iv.busyStatus === 'BUSY') busyMins += clippedMins;
    else if (iv.busyStatus === 'TENTATIVE') tentativeMins += clippedMins;
    else if (iv.busyStatus === 'OOF') oofMins += clippedMins;
  }

  const busy = busyMins / 60;
  const tentative = tentativeMins / 60;
  const oof = oofMins / 60;
  const weighted = busy + tentative * TENTATIVE_WEIGHT + oof;
  const availableHours = Math.max(0, workingHoursTotal - weighted);

  return {
    ...baseResult,
    meetingHours: { busy, tentative, oof, weighted },
    availableHours,
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
