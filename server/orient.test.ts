import { describe, expect, it } from 'vitest';
import { sessionReminderFor } from './orient';

describe('sessionReminderFor', () => {
  it('returns a reminder when no session is open', () => {
    const msg = sessionReminderFor(0);
    expect(msg).not.toBeNull();
    expect(msg).toContain('session_start');
  });

  it('returns null when a session is already open', () => {
    expect(sessionReminderFor(1)).toBeNull();
  });

  it('returns null when several sessions are open', () => {
    expect(sessionReminderFor(3)).toBeNull();
  });
});
