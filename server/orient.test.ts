import { describe, expect, it } from 'vitest';
import { repoHintFor, sessionReminderFor } from './orient';

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

describe('repoHintFor', () => {
  it('says it matches this chat when repos agree', () => {
    expect(repoHintFor('sprint-helper', 'sprint-helper')).toBe(
      'started from `sprint-helper` — matches this chat',
    );
  });
  it("marks a different repo as another chat's work", () => {
    expect(repoHintFor('devex-infrastructure', 'sprint-helper')).toBe(
      "started from `devex-infrastructure` — a different chat's work",
    );
  });
  it('names the repo without a claim when this chat is unknown', () => {
    expect(repoHintFor('devex-infrastructure', null)).toBe(
      'started from `devex-infrastructure`',
    );
  });
  it('says repo unknown for old sessions with no cwd', () => {
    expect(repoHintFor(null, 'sprint-helper')).toBe('repo unknown (older session)');
    expect(repoHintFor(null, null)).toBe('repo unknown (older session)');
  });
});
