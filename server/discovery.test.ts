// server/discovery.test.ts
import { describe, it, expect } from 'vitest';
import { parseDiscoveryDoc, emptyDiscoveryDoc } from './discovery';

describe('parseDiscoveryDoc', () => {
  it('returns null for unset/garbage input', () => {
    expect(parseDiscoveryDoc(null)).toBeNull();
    expect(parseDiscoveryDoc(undefined)).toBeNull();
    expect(parseDiscoveryDoc('not json {')).toBeNull();
    expect(parseDiscoveryDoc('[]')).toBeNull(); // array, not an object
    expect(parseDiscoveryDoc('42')).toBeNull();
  });

  it('parses a full valid doc and keeps its fields', () => {
    const doc = {
      problem: 'Move CD to GitHub.',
      flow: ['dev merges PR', 'pipeline runs', 'live in dev'],
      groups: [
        { name: 'How apps deploy', items: [
          { text: 'double the ArgoCD apps', tags: ['diff', 'fact'] },
          { text: 'more Akuity cost', tags: ['risk'] },
        ] },
      ],
      lanes: { ours: 'the flow shape', techLead: 'pipeline internals' },
      demo: { status: 'scheduled', shape: 'pipeline', date: '2026-08-01' },
      openQuestions: ['who owns the runner?'],
    };
    const parsed = parseDiscoveryDoc(JSON.stringify(doc));
    expect(parsed).not.toBeNull();
    expect(parsed!.problem).toBe('Move CD to GitHub.');
    expect(parsed!.flow).toHaveLength(3);
    expect(parsed!.groups[0].items[0].tags).toEqual(['diff', 'fact']);
    expect(parsed!.demo.status).toBe('scheduled');
  });

  it('drops unknown tags and malformed items rather than throwing', () => {
    const doc = {
      problem: 'x', flow: [], groups: [
        { name: 'g', items: [
          { text: 'ok', tags: ['diff', 'nonsense'] },
          { text: 42, tags: ['risk'] }, // bad text type -> dropped
          'garbage',                      // not an object -> dropped
        ] },
      ], lanes: { ours: '', techLead: '' },
      demo: { status: 'weird', shape: '', date: '' }, openQuestions: [],
    };
    const parsed = parseDiscoveryDoc(JSON.stringify(doc));
    expect(parsed).not.toBeNull();
    expect(parsed!.groups[0].items).toHaveLength(1);
    expect(parsed!.groups[0].items[0].tags).toEqual(['diff']); // 'nonsense' dropped
    expect(parsed!.demo.status).toBe('none'); // unknown status -> safe default
  });

  it('emptyDiscoveryDoc is a well-formed empty doc', () => {
    const e = emptyDiscoveryDoc();
    expect(e.problem).toBe('');
    expect(e.flow).toEqual([]);
    expect(e.groups).toEqual([]);
    expect(e.demo.status).toBe('none');
  });
});
