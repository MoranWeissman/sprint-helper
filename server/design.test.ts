// server/design.test.ts
import { describe, it, expect } from 'vitest';
import { parseDesignDoc, emptyDesignDoc, designAgreementCheck, isDesignStoryTitle, designGate, designGateMessage, renderDesignMarkdown } from './design';

function agreedDoc() {
  const d = emptyDesignDoc();
  d.approach = { lines: ['build a reusable workflow'], diagram: 'architecture.svg' };
  d.flows = [{ name: 'Deploy flow', steps: ['merge', 'deploy'], diagram: '' }];
  d.stories = [
    { title: 'Reusable deploy workflow', covers: 'the shared workflow', estimateHours: 16, why: 'touches the KCL risk from discovery' },
    { title: 'Rollback story', covers: 'auto rollback', estimateHours: 8, why: 'plain work, no risks touched' },
  ];
  d.plan = [{ step: 'workflow first', stories: ['Reusable deploy workflow'], note: '' }];
  d.decisions = [{ question: 'one app or two?', choice: '', decidedInMeeting: '' }];
  d.agreed = ['approach', 'flows', 'plan', 'decisions', 'story:Reusable deploy workflow', 'story:Rollback story'];
  return d;
}

describe('parseDesignDoc', () => {
  it('returns null for unset/garbage input', () => {
    expect(parseDesignDoc(null)).toBeNull();
    expect(parseDesignDoc('not json {')).toBeNull();
    expect(parseDesignDoc('[]')).toBeNull();
  });
  it('parses a full doc and keeps its fields', () => {
    const parsed = parseDesignDoc(JSON.stringify(agreedDoc()));
    expect(parsed!.stories).toHaveLength(2);
    expect(parsed!.stories[0].estimateHours).toBe(16);
    expect(parsed!.approach.diagram).toBe('architecture.svg');
    expect(parsed!.agreed).toContain('story:Rollback story');
  });
  it('defaults every missing field to a safe empty', () => {
    const p = parseDesignDoc('{}')!;
    expect(p.approach).toEqual({ lines: [], diagram: '' });
    expect(p.flows).toEqual([]);
    expect(p.stories).toEqual([]);
    expect(p.plan).toEqual([]);
    expect(p.decisions).toEqual([]);
    expect(p.review).toEqual({ status: 'none', date: '' });
    expect(p.pushed).toEqual({ at: '', storyIds: [] });
    expect(p.agreed).toEqual([]);
  });
  it('keeps stories with unusable hours as 0h; drops the truly malformed', () => {
    const p = parseDesignDoc(JSON.stringify({ stories: [
      { title: 'ok', covers: 'c', estimateHours: 4, why: 'w' },
      { title: 'bad hours', covers: 'c', estimateHours: 'six', why: 'w' },
      'garbage',
    ] }))!;
    expect(p.stories).toHaveLength(2);
    expect(p.stories[0].title).toBe('ok');
    expect(p.stories[1]).toEqual({ title: 'bad hours', covers: 'c', estimateHours: 0, why: 'w' });
  });
});

describe('designAgreementCheck', () => {
  it('passes when every non-empty part and every story is agreed', () => {
    const r = designAgreementCheck(agreedDoc());
    expect(r.ok).toBe(true);
    expect(r.unagreed).toEqual([]);
  });
  it('lists unagreed parts and stories with plain labels', () => {
    const d = agreedDoc();
    d.agreed = ['approach'];
    const r = designAgreementCheck(d);
    expect(r.ok).toBe(false);
    expect(r.unagreed).toContain('the flows');
    expect(r.unagreed).toContain('the working plan');
    expect(r.unagreed).toContain('the open decisions');
    expect(r.unagreed).toContain('the story "Reusable deploy workflow"');
  });
  it('empty parts need no mark', () => {
    const d = emptyDesignDoc();
    expect(designAgreementCheck(d).ok).toBe(true);
  });
  it('a retitled story is not covered by its old mark', () => {
    const d = agreedDoc();
    d.stories[1].title = 'Rollback story v2';
    const r = designAgreementCheck(d);
    expect(r.unagreed).toContain('the story "Rollback story v2"');
  });
});

describe('isDesignStoryTitle', () => {
  it('matches titles that start with design', () => {
    expect(isDesignStoryTitle('Design: CD pipeline')).toBe(true);
    expect(isDesignStoryTitle('  design work')).toBe(true);
    expect(isDesignStoryTitle('Redesign the flow')).toBe(false);
  });
});

describe('designGateMessage — names only the FIRST unmet gate', () => {
  it('null for non-design stories and for a fully done design', () => {
    expect(designGateMessage({ isDesignStory: false, doc: null, meetingCount: 0 })).toBeNull();
    const d = agreedDoc();
    d.review = { status: 'done', date: '2026-08-02' };
    d.pushed = { at: '2026-08-02T10:00:00Z', storyIds: [1, 2] };
    expect(designGateMessage({ isDesignStory: true, doc: d, meetingCount: 1 })).toBeNull();
  });
  it('gate 1: unagreed parts block first, listing them', () => {
    const d = agreedDoc();
    d.agreed = [];
    const msg = designGateMessage({ isDesignStory: true, doc: d, meetingCount: 0 })!;
    expect(msg).toContain("aren't agreed yet");
    expect(msg).toContain('the approach');
    expect(msg).toContain('Explain each one to the user in plain words');
    expect(msg).not.toContain('review');
  });
  it('gate 2: agreed but not reviewed', () => {
    const msg = designGateMessage({ isDesignStory: true, doc: agreedDoc(), meetingCount: 0 })!;
    expect(msg).toContain('design review');
    expect(msg).not.toContain('push');
  });
  it('review status done without a recorded meeting still blocks at gate 2', () => {
    const d = agreedDoc();
    d.review = { status: 'done', date: '2026-08-02' };
    const msg = designGateMessage({ isDesignStory: true, doc: d, meetingCount: 0 })!;
    expect(msg).toContain('design review');
  });
  it('gate 3: agreed + reviewed but not pushed', () => {
    const d = agreedDoc();
    d.review = { status: 'done', date: '2026-08-02' };
    const msg = designGateMessage({ isDesignStory: true, doc: d, meetingCount: 1 })!;
    expect(msg).toContain('push');
  });
  it('a missing doc blocks with a plain start message', () => {
    const msg = designGateMessage({ isDesignStory: true, doc: null, meetingCount: 0 })!;
    expect(msg).toContain('no design');
  });
});

describe('designGate — structured step', () => {
  it('a story titled with the word push does not fool the agree gate', () => {
    const d = emptyDesignDoc();
    d.stories = [{ title: 'Add push notifications', covers: 'c', estimateHours: 4, why: 'w' }];
    const g = designGate({ isDesignStory: true, doc: d, meetingCount: 0 });
    expect(g.step).toBe('agree');
    expect(g.message).toContain('the story "Add push notifications"');
  });
  it('steps walk start → agree → review → push → none', () => {
    expect(designGate({ isDesignStory: true, doc: null, meetingCount: 0 }).step).toBe('start');
    const d = emptyDesignDoc();
    d.stories = [{ title: 'S', covers: 'c', estimateHours: 4, why: 'w' }];
    expect(designGate({ isDesignStory: true, doc: d, meetingCount: 0 }).step).toBe('agree');
    d.agreed = ['story:S'];
    expect(designGate({ isDesignStory: true, doc: d, meetingCount: 0 }).step).toBe('review');
    d.review = { status: 'done', date: '2026-08-02' };
    expect(designGate({ isDesignStory: true, doc: d, meetingCount: 1 }).step).toBe('push');
    d.pushed = { at: 'x', storyIds: [1] };
    expect(designGate({ isDesignStory: true, doc: d, meetingCount: 1 }).step).toBe('none');
  });
});

describe('renderDesignMarkdown', () => {
  it('renders all parts with agreed marks and hours', () => {
    const d = agreedDoc();
    const md = renderDesignMarkdown(d, { featureDisplayName: '**F** (#1)' });
    expect(md).toContain('## The approach · agreed ✓');
    expect(md).toContain('Reusable deploy workflow');
    expect(md).toContain('16h');
    expect(md).toContain('## The working plan · agreed ✓');
    expect(md).toContain('not decided yet');
  });
});
