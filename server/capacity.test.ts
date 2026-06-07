import { describe, it, expect } from 'vitest';
import { countWorkingDays, clipToWorkingHours, DEFAULT_WORKING_DAYS } from './capacity';

// In Moran's tenant the workweek is Sun-Thu. These dates are anchored to a
// known week: June 7 2026 is a Sunday, so Jun 12 = Friday, Jun 13 = Saturday.
const SUN_THU = DEFAULT_WORKING_DAYS;
const d = (y: number, m: number, day: number, h = 0, min = 0) => new Date(y, m - 1, day, h, min, 0, 0);

describe('DEFAULT_WORKING_DAYS', () => {
  it('is Sun-Thu (Israeli workweek), not Mon-Fri', () => {
    expect([...SUN_THU].sort()).toEqual([0, 1, 2, 3, 4]);
    expect(SUN_THU.has(5)).toBe(false); // Friday off
    expect(SUN_THU.has(6)).toBe(false); // Saturday off
  });
});

describe('countWorkingDays (Sun-Thu)', () => {
  it('counts a single Sunday as one working day', () => {
    expect(countWorkingDays(d(2026, 6, 7), d(2026, 6, 7), SUN_THU)).toBe(1);
  });

  it('counts 5 working days across a full Sun-Sat week', () => {
    // Sun Jun 7 .. Sat Jun 13 -> Sun,Mon,Tue,Wed,Thu work; Fri,Sat off.
    expect(countWorkingDays(d(2026, 6, 7), d(2026, 6, 13), SUN_THU)).toBe(5);
  });

  it('counts 10 working days across a two-week sprint', () => {
    // Sun Jun 7 .. Thu Jun 18 -> two work-weeks, weekend in the middle skipped.
    expect(countWorkingDays(d(2026, 6, 7), d(2026, 6, 18), SUN_THU)).toBe(10);
  });

  it('counts the Fri+Sat weekend as zero', () => {
    expect(countWorkingDays(d(2026, 6, 12), d(2026, 6, 13), SUN_THU)).toBe(0); // Fri+Sat
  });
});

describe('clipToWorkingHours (08:00-18:00, Sun-Thu)', () => {
  it('counts a meeting fully inside working hours', () => {
    // Sunday 10:00-11:00 -> 60 minutes.
    expect(clipToWorkingHours(d(2026, 6, 7, 10), d(2026, 6, 7, 11), SUN_THU, 8, 18)).toBe(60);
  });

  it('ignores a meeting outside the working window', () => {
    // Sunday 06:00-07:00 -> before the workday, 0 minutes.
    expect(clipToWorkingHours(d(2026, 6, 7, 6), d(2026, 6, 7, 7), SUN_THU, 8, 18)).toBe(0);
  });

  it('ignores a meeting on a non-working day', () => {
    // Saturday 10:00-11:00 -> not a working day, 0 minutes.
    expect(clipToWorkingHours(d(2026, 6, 13, 10), d(2026, 6, 13, 11), SUN_THU, 8, 18)).toBe(0);
  });

  it('clips a meeting that runs past the end of the workday', () => {
    // Sunday 17:00-19:00 -> only 17:00-18:00 counts = 60 minutes.
    expect(clipToWorkingHours(d(2026, 6, 7, 17), d(2026, 6, 7, 19), SUN_THU, 8, 18)).toBe(60);
  });

  it('clips an all-day block to the 10-hour workday', () => {
    // Sunday 00:00 -> Monday 00:00 clipped to 08:00-18:00 = 600 minutes.
    expect(clipToWorkingHours(d(2026, 6, 7, 0), d(2026, 6, 8, 0), SUN_THU, 8, 18)).toBe(600);
  });
});
