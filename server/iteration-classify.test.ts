import { describe, it, expect } from 'vitest';
import { classifyIterationLevel, isSprintLevel } from './planning-cockpit';
import { classifyPastSprint } from './iteration-paths';

describe('classifyIterationLevel', () => {
  it('classifies the tree levels', () => {
    expect(classifyIterationLevel('IDP - DevOps')).toBe('backlog');
    expect(classifyIterationLevel('IDP - DevOps\\Backlog')).toBe('backlog');
    expect(classifyIterationLevel('IDP - DevOps\\2026')).toBe('year');
    expect(classifyIterationLevel('IDP - DevOps\\2026\\Q2')).toBe('quarter');
    expect(classifyIterationLevel('IDP - DevOps\\2026\\Q2\\26_12')).toBe('sprint');
    expect(classifyIterationLevel('')).toBe(null);
  });

  it('isSprintLevel is true only for a concrete named sprint', () => {
    expect(isSprintLevel('IDP - DevOps\\2026\\Q2\\26_12')).toBe(true);
    expect(isSprintLevel('IDP - DevOps\\2026')).toBe(false);
    expect(isSprintLevel('IDP - DevOps\\Backlog')).toBe(false);
  });
});

describe('classifyPastSprint', () => {
  const ITS = [
    { path: 'IDP - DevOps\\2026\\Q2\\26_11', finishDate: '2026-06-10T00:00:00Z' },
    { path: 'IDP - DevOps\\2026\\Q2\\26_13', finishDate: '2026-07-10T00:00:00Z' },
  ];
  const NOW = new Date('2026-06-25T09:00:00Z');

  it('true for a sprint that already finished', () => {
    expect(classifyPastSprint(ITS, 'IDP - DevOps\\2026\\Q2\\26_11', NOW)).toBe(true);
  });
  it('false for a current/future sprint', () => {
    expect(classifyPastSprint(ITS, 'IDP - DevOps\\2026\\Q2\\26_13', NOW)).toBe(false);
  });
  it('false for backlog / year / quarter paths', () => {
    expect(classifyPastSprint(ITS, 'IDP - DevOps\\2026', NOW)).toBe(false);
    expect(classifyPastSprint(ITS, 'IDP - DevOps\\Backlog', NOW)).toBe(false);
  });
  it('false for an unknown sprint path not in the list', () => {
    expect(classifyPastSprint(ITS, 'IDP - DevOps\\2026\\Q1\\26_09', NOW)).toBe(false);
  });
});
