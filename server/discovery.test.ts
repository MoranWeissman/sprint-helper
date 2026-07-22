// server/discovery.test.ts
import { describe, it, expect } from 'vitest';
import { parseDiscoveryDoc, emptyDiscoveryDoc, renderDiscoveryMarkdown, isGroupComplete, discoveryFinishedCheck } from './discovery';

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

describe('isGroupComplete', () => {
  it('needs a diff, a risk, and a fact-or-option', () => {
    expect(isGroupComplete({ name: 'g', items: [
      { text: 'a', tags: ['diff'] }, { text: 'b', tags: ['risk'] }, { text: 'c', tags: ['fact'] },
    ] })).toBe(true);
    expect(isGroupComplete({ name: 'g', items: [
      { text: 'a', tags: ['diff'] }, { text: 'b', tags: ['risk'] }, // no fact/option
    ] })).toBe(false);
    expect(isGroupComplete({ name: 'g', items: [
      { text: 'a', tags: ['diff', 'fact', 'option'] }, // no risk
    ] })).toBe(false);
  });
});

describe('discoveryFinishedCheck', () => {
  it('fails for a null doc', () => {
    const r = discoveryFinishedCheck(null);
    expect(r.ok).toBe(false);
    expect(r.missing.length).toBeGreaterThan(0);
  });
  it('fails when the flow is empty', () => {
    const doc = emptyDiscoveryDoc();
    doc.groups = [{ name: 'g', items: [
      { text: 'a', tags: ['diff'] }, { text: 'b', tags: ['risk'] }, { text: 'c', tags: ['fact'] },
    ] }];
    const r = discoveryFinishedCheck(doc);
    expect(r.ok).toBe(false);
    expect(r.missing).toContain('an end-to-end flow');
  });
  it('fails when no group is complete', () => {
    const doc = emptyDiscoveryDoc();
    doc.flow = ['step 1'];
    doc.groups = [{ name: 'g', items: [{ text: 'a', tags: ['diff'] }] }];
    expect(discoveryFinishedCheck(doc).ok).toBe(false);
  });
  it('passes with a flow + one complete group', () => {
    const doc = emptyDiscoveryDoc();
    doc.flow = ['step 1', 'step 2'];
    doc.groups = [{ name: 'g', items: [
      { text: 'a', tags: ['diff'] }, { text: 'b', tags: ['risk'] }, { text: 'c', tags: ['option'] },
    ] }];
    const r = discoveryFinishedCheck(doc);
    expect(r.ok).toBe(true);
    expect(r.missing).toEqual([]);
  });
});

describe('renderDiscoveryMarkdown', () => {
  it('renders headings, the flow as a numbered list, and tagged items', () => {
    const doc = emptyDiscoveryDoc();
    doc.problem = 'Move CD to GitHub.';
    doc.flow = ['dev merges PR', 'live in dev'];
    doc.groups = [{ name: 'How apps deploy', items: [
      { text: 'double the ArgoCD apps', tags: ['diff', 'fact'] },
      { text: 'more Akuity cost', tags: ['risk'] },
    ] }];
    doc.demo = { status: 'scheduled', shape: 'pipeline', date: '2026-08-01' };
    const md = renderDiscoveryMarkdown(doc, { featureDisplayName: '**Declarative CD** (#100)' });
    expect(md).toContain('# Discovery: **Declarative CD** (#100)');
    expect(md).toContain('## What we\'re solving');
    expect(md).toContain('Move CD to GitHub.');
    expect(md).toContain('1. dev merges PR');
    expect(md).toContain('### How apps deploy');
    expect(md).toContain('double the ArgoCD apps');
    expect(md).toContain('[diff, fact]');
    expect(md).toContain('scheduled');
  });
});
