import { describe, expect, it } from 'vitest';
import {
  suggestCall,
  suggestGoalIndex,
  summarizeCoverage,
  workingDaysBetween,
} from './preplan';

const NOW = new Date('2026-06-25T12:00:00Z'); // a Thursday

describe('workingDaysBetween', () => {
  it('counts Sun-Thu and skips Fri/Sat', () => {
    // Sun 2026-06-21 -> Thu 2026-06-25 = 4 working days elapsed
    expect(workingDaysBetween(new Date('2026-06-21T12:00:00Z'), NOW)).toBe(4);
  });
  it('is 0 for the same day', () => {
    expect(workingDaysBetween(NOW, NOW)).toBe(0);
  });
});

describe('suggestCall', () => {
  it('suggests at-risk when blocked', () => {
    expect(
      suggestCall({ blocked: true, lastActivityAt: NOW.toISOString(), remainingHours: 5, now: NOW }),
    ).toBe('at-risk');
  });
  it('suggests at-risk when idle 3+ working days with hours left', () => {
    expect(
      suggestCall({
        blocked: false,
        lastActivityAt: '2026-06-21T12:00:00Z', // 4 working days ago
        remainingHours: 5,
        now: NOW,
      }),
    ).toBe('at-risk');
  });
  it('suggests on-track when recently active', () => {
    expect(
      suggestCall({
        blocked: false,
        lastActivityAt: '2026-06-24T12:00:00Z', // 1 working day ago
        remainingHours: 5,
        now: NOW,
      }),
    ).toBe('on-track');
  });
  it('suggests on-track when idle but no hours remain', () => {
    expect(
      suggestCall({
        blocked: false,
        lastActivityAt: '2026-06-21T12:00:00Z',
        remainingHours: 0,
        now: NOW,
      }),
    ).toBe('on-track');
  });
  it('suggests at-risk when never active but hours remain and sprint has run', () => {
    // null activity is treated as "no activity yet" -> at-risk only if hours remain
    expect(
      suggestCall({ blocked: false, lastActivityAt: null, remainingHours: 5, now: NOW }),
    ).toBe('at-risk');
  });
  it('never returns carries-over', () => {
    const r = suggestCall({ blocked: true, lastActivityAt: null, remainingHours: 99, now: NOW });
    expect(r).not.toBe('carries-over');
  });
});

describe('suggestGoalIndex', () => {
  const goals = ['Improve ArgoCD rollout confidence', 'Migrate Datadog helm values'];
  it('matches the obvious goal by shared words', () => {
    expect(suggestGoalIndex('Validate addon rollout from prod ArgoCD', goals)).toBe(0);
  });
  it('returns null when overlap is weak', () => {
    expect(suggestGoalIndex('Unrelated database backup chore', goals)).toBeNull();
  });
  it('returns null when there are no goals', () => {
    expect(suggestGoalIndex('anything', [])).toBeNull();
  });
});

describe('summarizeCoverage', () => {
  const goals = ['Goal A', 'Goal B', 'Goal C'];
  it('counts stories per goal and flags uncovered goals', () => {
    const cards = [{ goalIndex: 0 }, { goalIndex: 0 }, { goalIndex: 2 }];
    const cov = summarizeCoverage(cards, goals);
    expect(cov).toEqual([
      { index: 0, text: 'Goal A', storyCount: 2 },
      { index: 1, text: 'Goal B', storyCount: 0 },
      { index: 2, text: 'Goal C', storyCount: 1 },
    ]);
  });
  it('returns empty when there are no goals', () => {
    expect(summarizeCoverage([{ goalIndex: null }], [])).toEqual([]);
  });
});
