// server/discovery.test.ts
import { describe, it, expect } from 'vitest';
import { parseDiscoveryDoc, emptyDiscoveryDoc, renderDiscoveryMarkdown, isGroupComplete, discoveryFinishedCheck, discoveryDayStage, discoveryDayNudge, discoveryCloseBlockMessage, discoveryStartNudge } from './discovery';

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

describe('discoveryDayStage', () => {
  const WORKDAYS = new Set([0, 1, 2, 3, 4]); // Sun-Thu
  it('none when there is no first session', () => {
    expect(discoveryDayStage({ firstSessionAt: null, now: new Date('2026-07-22T10:00:00Z') }).stage).toBe('none');
  });
  it('day 1 is ok', () => {
    // Sun 2026-07-19 .. same day
    const r = discoveryDayStage({ firstSessionAt: '2026-07-19T08:00:00Z', now: new Date('2026-07-19T15:00:00Z'), workdays: WORKDAYS });
    expect(r.workday).toBe(1);
    expect(r.stage).toBe('ok');
  });
  it('Fri + Sat do not count as working days', () => {
    // Sun 2026-07-19 (day1) .. through Sat 2026-07-25: working days are Sun,Mon,Tue,Wed,Thu = 5
    const r = discoveryDayStage({ firstSessionAt: '2026-07-19T08:00:00Z', now: new Date('2026-07-25T10:00:00Z'), workdays: WORKDAYS });
    expect(r.workday).toBe(5);
    expect(r.stage).toBe('overrun');
  });
  it('day 2 / day 3 / overrun stages', () => {
    // Sun(19)=1, Mon(20)=2, Tue(21)=3, Wed(22)=4
    expect(discoveryDayStage({ firstSessionAt: '2026-07-19T08:00:00Z', now: new Date('2026-07-20T10:00:00Z'), workdays: WORKDAYS }).stage).toBe('day2');
    expect(discoveryDayStage({ firstSessionAt: '2026-07-19T08:00:00Z', now: new Date('2026-07-21T10:00:00Z'), workdays: WORKDAYS }).stage).toBe('day3');
    expect(discoveryDayStage({ firstSessionAt: '2026-07-19T08:00:00Z', now: new Date('2026-07-22T10:00:00Z'), workdays: WORKDAYS }).stage).toBe('overrun');
  });
});

describe('discoveryDayNudge', () => {
  it('is quiet on none and ok, speaks from day2 on', () => {
    expect(discoveryDayNudge('none')).toBeNull();
    expect(discoveryDayNudge('ok')).toBeNull();
    expect(discoveryDayNudge('day2')).toMatch(/wrap/i);
    expect(discoveryDayNudge('day3')).toMatch(/extra day/i);
    expect(discoveryDayNudge('overrun')).toMatch(/ran past/i);
  });
});

describe('discoveryCloseBlockMessage', () => {
  it('never blocks a non-discovery story', () => {
    expect(discoveryCloseBlockMessage({
      isDiscoveryStory: false, folderPath: null, check: { ok: false, missing: ['x'] },
    })).toBeNull();
  });
  it('blocks a discovery story with no folder to read', () => {
    const msg = discoveryCloseBlockMessage({
      isDiscoveryStory: true, folderPath: null, check: { ok: false, missing: ['a discovery doc (none found)'] },
    });
    expect(msg).toMatch(/discovery/i);
  });
  it('blocks a discovery story whose doc is unfinished, listing the gaps', () => {
    const msg = discoveryCloseBlockMessage({
      isDiscoveryStory: true, folderPath: '/x', check: { ok: false, missing: ['an end-to-end flow'] },
    });
    expect(msg).toContain('an end-to-end flow');
  });
  it('lets a finished discovery story close', () => {
    expect(discoveryCloseBlockMessage({
      isDiscoveryStory: true, folderPath: '/x', check: { ok: true, missing: [] },
    })).toBeNull();
  });
});

describe('discoveryStartNudge', () => {
  it('quiet when discovery is finished', () => {
    expect(discoveryStartNudge({ hasDiscovery: true, finished: true })).toBeNull();
  });
  it('reminds when there is no discovery yet', () => {
    expect(discoveryStartNudge({ hasDiscovery: false, finished: false })).toMatch(/no finished discovery/i);
  });
  it('reminds when discovery exists but is not finished', () => {
    expect(discoveryStartNudge({ hasDiscovery: true, finished: false })).toMatch(/not finished/i);
  });
});
