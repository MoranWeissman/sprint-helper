import { describe, it, expect } from 'vitest';
import { classifyIterationLevel, isSprintLevel } from './planning-cockpit';

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
