import { describe, it, expect, vi } from 'vitest';

// Use the built-in default schedule (Daily = weekdays @ 09:00) by making the
// settings lookup return nothing, so getCeremonySchedule() falls back to it.
vi.mock('./timers', () => ({ getSetting: () => undefined, setSetting: () => {} }));

import { computeUpcomingCeremonies } from './ceremony';

// Working week is Sun–Thu (0..4); Fri (5) + Sat (6) are off. These guard the
// regression where the Daily recurrence was hardcoded to Mon–Fri, which on a
// Sunday skipped today's Daily and wrongly offered Friday's.
describe('Daily recurrence follows the working week (Sun–Thu)', () => {
  it('includes Sunday and never Friday or Saturday', () => {
    const now = new Date(2026, 5, 14, 8, 0, 0); // Sunday 2026-06-14, before 09:00
    const dows = computeUpcomingCeremonies({ now })
      .filter(u => u.id === 'daily')
      .map(u => new Date(u.startsAt).getDay());

    expect(dows.length).toBeGreaterThan(0);
    expect(dows.every(d => d >= 0 && d <= 4)).toBe(true); // all on Sun–Thu
    expect(dows).toContain(0); // today (Sunday) is a working day
  });

  it('after Thursday, the next Daily is Sunday — not Friday', () => {
    const now = new Date(2026, 5, 11, 18, 0, 0); // Thursday 2026-06-11, after the daily
    const firstFuture = computeUpcomingCeremonies({ now })
      .filter(u => u.id === 'daily')
      .find(u => u.minutesUntil >= 0);

    expect(firstFuture).toBeDefined();
    expect(new Date(firstFuture!.startsAt).getDay()).toBe(0); // Sunday, not Friday(5)
  });
});
