# Design Phase Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The design phase end-to-end: `design/` folder shape + agree-per-part + three ordered gates (agreed → reviewed → pushed) + one push that creates the stories in ADO + the D&D Design tab + the `design` skill.

**Architecture:** Mirrors discovery exactly. Pure logic in `server/design.ts` (no fs/network, never throws), fs wrapper in `server/design-store.ts`, disk-only payload on a new `/api/discovery/<id>/design` route, React facet in `DnDView.tsx`, gate + push tool in `mcp/server.ts`, skills at the SEED fanned out by `skills_sync`.

**Tech Stack:** TypeScript, Vitest, React, plain CSS (OKLCH tokens), @modelcontextprotocol/sdk, zod.

**Spec:** `docs/superpowers/specs/2026-07-29-design-phase-design.md`

## Global Constraints

- Parse code never throws; missing/garbage → safe empties. A missing `design/` folder is a normal state everywhere.
- Plain English in every human-facing string; banned words apply ("slack", "burndown", "scope" as noun, "velocity", "WIP", "work item", "blockers" collective, "pushback"). Names before numbers: echo `displayName` strings.
- Agreement keys exactly: `approach`, `flows`, `plan`, `decisions`, and `story:<story title>` per story. Unagreed labels exactly: `the approach`, `the flows`, `the story "<title>"`, `the working plan`, `the open decisions`.
- Gate order: agreement → review → push; every block message names ONLY the first unmet gate.
- Board writes go through the existing `createStory` in `server/writes.ts` (Effort set once; Story Points derived — never reimplement).
- No day nudges, no clock for design, anywhere.
- Functional color, existing tokens only; never font-size ≤ 11px with `--ink-4`; reuse existing `dnd-*` patterns.
- Seed skills live ONLY at `~/projects/github-moran/features/.claude/skills/`; never touch workspace/global copies.
- No D&D component unit tests (repo decision). MCP handler glue untested (repo decision) — USER smokes.
- Commits end with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

---

### Task 1: `server/design.ts` — the pure core

**Files:**
- Create: `server/design.ts`
- Test: `server/design.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces (later tasks rely on these exact names):
  - `interface DesignStory { title: string; covers: string; estimateHours: number; why: string }`
  - `interface DesignDoc { approach: { lines: string[]; diagram: string }; flows: { name: string; steps: string[]; diagram: string }[]; stories: DesignStory[]; plan: { step: string; stories: string[]; note: string }[]; decisions: { question: string; choice: string; decidedInMeeting: string }[]; review: { status: 'none'|'scheduled'|'done'; date: string }; pushed: { at: string; storyIds: number[] }; agreed: string[] }`
  - `emptyDesignDoc(): DesignDoc`
  - `parseDesignDoc(raw: string | null | undefined): DesignDoc | null`
  - `designAgreementCheck(doc: DesignDoc): { ok: boolean; unagreed: string[] }`
  - `isDesignStoryTitle(title: string): boolean`
  - `designGateMessage(args: { isDesignStory: boolean; doc: DesignDoc | null; meetingCount: number }): string | null`
  - `renderDesignMarkdown(doc: DesignDoc, opts: { featureDisplayName: string }): string`

- [ ] **Step 1: Write the failing tests** (`server/design.test.ts`)

```ts
// server/design.test.ts
import { describe, it, expect } from 'vitest';
import { parseDesignDoc, emptyDesignDoc, designAgreementCheck, isDesignStoryTitle, designGateMessage, renderDesignMarkdown } from './design';

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
  it('drops malformed stories and non-numeric hours rather than throwing', () => {
    const p = parseDesignDoc(JSON.stringify({ stories: [
      { title: 'ok', covers: 'c', estimateHours: 4, why: 'w' },
      { title: 'bad hours', covers: 'c', estimateHours: 'six', why: 'w' },
      'garbage',
    ] }))!;
    expect(p.stories).toHaveLength(1);
    expect(p.stories[0].title).toBe('ok');
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
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run server/design.test.ts`
Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Implement `server/design.ts`**

```ts
/**
 * Per-feature design phase: the source-file shape, its markdown render, the
 * agree-per-part coverage check, and the three ordered gates (agreed →
 * reviewed → pushed). Pure functions over data passed in; never throws;
 * every reader tolerates missing/garbage input — same discipline as
 * server/discovery.ts. No fs access here; that's server/design-store.ts.
 */

export interface DesignStory { title: string; covers: string; estimateHours: number; why: string }

export interface DesignDoc {
  approach: { lines: string[]; diagram: string };
  flows: { name: string; steps: string[]; diagram: string }[];
  stories: DesignStory[];
  plan: { step: string; stories: string[]; note: string }[];
  decisions: { question: string; choice: string; decidedInMeeting: string }[];
  review: { status: 'none' | 'scheduled' | 'done'; date: string };
  /** Written by the push tool only — chats never hand-write it. */
  pushed: { at: string; storyIds: number[] };
  /** Agree-per-part record. Keys: 'approach','flows','plan','decisions','story:<title>'. */
  agreed: string[];
}

const VALID_REVIEW: ReadonlySet<string> = new Set(['none', 'scheduled', 'done']);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const strArray = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
const numArray = (v: unknown): number[] =>
  Array.isArray(v) ? v.filter((x): x is number => typeof x === 'number' && Number.isFinite(x)) : [];
const obj = (v: unknown): Record<string, unknown> =>
  (v != null && typeof v === 'object' && !Array.isArray(v)) ? v as Record<string, unknown> : {};

export function emptyDesignDoc(): DesignDoc {
  return {
    approach: { lines: [], diagram: '' },
    flows: [], stories: [], plan: [], decisions: [],
    review: { status: 'none', date: '' },
    pushed: { at: '', storyIds: [] },
    agreed: [],
  };
}

function parseStory(v: unknown): DesignStory | null {
  const o = obj(v);
  if (typeof o.title !== 'string' || o.title === '') return null;
  if (typeof o.estimateHours !== 'number' || !Number.isFinite(o.estimateHours)) return null;
  return { title: o.title, covers: str(o.covers), estimateHours: o.estimateHours, why: str(o.why) };
}

export function parseDesignDoc(raw: string | null | undefined): DesignDoc | null {
  if (!raw) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return null; }
  if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const o = parsed as Record<string, unknown>;
  const approach = obj(o.approach);
  const review = obj(o.review);
  const pushed = obj(o.pushed);
  return {
    approach: { lines: strArray(approach.lines), diagram: str(approach.diagram) },
    flows: Array.isArray(o.flows) ? o.flows.map(f => {
      const fo = obj(f);
      return typeof fo.name === 'string'
        ? { name: fo.name, steps: strArray(fo.steps), diagram: str(fo.diagram) } : null;
    }).filter((f): f is DesignDoc['flows'][number] => f !== null) : [],
    stories: Array.isArray(o.stories)
      ? o.stories.map(parseStory).filter((s): s is DesignStory => s !== null) : [],
    plan: Array.isArray(o.plan) ? o.plan.map(p => {
      const po = obj(p);
      return typeof po.step === 'string'
        ? { step: po.step, stories: strArray(po.stories), note: str(po.note) } : null;
    }).filter((p): p is DesignDoc['plan'][number] => p !== null) : [],
    decisions: Array.isArray(o.decisions) ? o.decisions.map(d => {
      const dd = obj(d);
      return typeof dd.question === 'string'
        ? { question: dd.question, choice: str(dd.choice), decidedInMeeting: str(dd.decidedInMeeting) } : null;
    }).filter((d): d is DesignDoc['decisions'][number] => d !== null) : [],
    review: {
      status: (typeof review.status === 'string' && VALID_REVIEW.has(review.status)
        ? review.status : 'none') as DesignDoc['review']['status'],
      date: str(review.date),
    },
    pushed: { at: str(pushed.at), storyIds: numArray(pushed.storyIds) },
    agreed: strArray(o.agreed),
  };
}

/** Agree-per-part coverage: every part with content + every story needs its
 *  key in `agreed`. Labels are plain English for the block message. */
export function designAgreementCheck(doc: DesignDoc): { ok: boolean; unagreed: string[] } {
  const unagreed: string[] = [];
  const parts: { key: string; present: boolean; label: string }[] = [
    { key: 'approach', present: doc.approach.lines.length > 0 || doc.approach.diagram.trim() !== '', label: 'the approach' },
    { key: 'flows', present: doc.flows.length > 0, label: 'the flows' },
    ...doc.stories.map(s => ({ key: `story:${s.title}`, present: true, label: `the story "${s.title}"` })),
    { key: 'plan', present: doc.plan.length > 0, label: 'the working plan' },
    { key: 'decisions', present: doc.decisions.length > 0, label: 'the open decisions' },
  ];
  for (const p of parts) {
    if (p.present && !doc.agreed.includes(p.key)) unagreed.push(p.label);
  }
  return { ok: unagreed.length === 0, unagreed };
}

/** Title-based: design stories are titled "Design: X" (mirror of discovery). */
export function isDesignStoryTitle(title: string): boolean {
  return /^\s*design\b/i.test(title);
}

/** The story-close gate's message. Names ONLY the first unmet gate —
 *  one instruction at a time, never a wall. null = allowed to close. */
export function designGateMessage(args: {
  isDesignStory: boolean;
  doc: DesignDoc | null;
  meetingCount: number;
}): string | null {
  if (!args.isDesignStory) return null;
  if (!args.doc) {
    return 'This design story has no design yet. Start the design (the design skill walks it part by part), then close.';
  }
  const check = designAgreementCheck(args.doc);
  if (!check.ok) {
    return `These parts of the design aren't agreed yet: ${check.unagreed.join(', ')}. Explain each one to the user in plain words, get their yes, then continue.`;
  }
  const reviewed = args.doc.review.status === 'done' && args.meetingCount > 0;
  if (!reviewed) {
    return 'All parts are agreed. Next: hold the design review with the team, record it as a meeting summary, and mark the review done. Then the stories can go to the board.';
  }
  if (args.doc.pushed.storyIds.length === 0) {
    return 'Agreed and reviewed. Next: push the stories to the board with the push tool, then close this design story.';
  }
  return null;
}

export function renderDesignMarkdown(
  doc: DesignDoc,
  opts: { featureDisplayName: string },
): string {
  const mark = (key: string): string => (doc.agreed.includes(key) ? ' · agreed ✓' : '');
  const lines: string[] = [];
  lines.push(`# Design: ${opts.featureDisplayName}`, '');
  lines.push(`## The approach${mark('approach')}`, '');
  if (doc.approach.lines.length === 0) lines.push('_(not filled in)_');
  else doc.approach.lines.forEach(l => lines.push(`- ${l}`));
  if (doc.approach.diagram) lines.push('', `Picture: ${doc.approach.diagram}`);
  lines.push('');
  lines.push(`## The flows${mark('flows')}`, '');
  if (doc.flows.length === 0) lines.push('_(none yet)_', '');
  for (const f of doc.flows) {
    lines.push(`### ${f.name}`, '');
    f.steps.forEach((s, i) => lines.push(`${i + 1}. ${s}`));
    if (f.diagram) lines.push('', `Picture: ${f.diagram}`);
    lines.push('');
  }
  lines.push('## The stories', '');
  if (doc.stories.length === 0) lines.push('_(none yet)_', '');
  for (const s of doc.stories) {
    lines.push(`### ${s.title} — ${s.estimateHours}h${mark(`story:${s.title}`)}`, '');
    lines.push(s.covers || '_(no description)_', '');
    lines.push(`Why this estimate: ${s.why || '_(not justified yet)_'}`, '');
  }
  lines.push(`## The working plan${mark('plan')}`, '');
  if (doc.plan.length === 0) lines.push('_(none yet)_');
  else doc.plan.forEach((p, i) => {
    const which = p.stories.length ? ` — ${p.stories.join(', ')}` : '';
    const note = p.note ? ` (${p.note})` : '';
    lines.push(`${i + 1}. ${p.step}${which}${note}`);
  });
  lines.push('');
  lines.push(`## Open decisions${mark('decisions')}`, '');
  if (doc.decisions.length === 0) lines.push('_(none)_');
  else for (const d of doc.decisions) {
    const settled = d.choice
      ? `${d.choice}${d.decidedInMeeting ? ` (decided in ${d.decidedInMeeting})` : ''}`
      : 'not decided yet';
    lines.push(`- ${d.question} → ${settled}`);
  }
  lines.push('');
  lines.push('## Review and push', '');
  lines.push(`review: ${doc.review.status}${doc.review.date ? ` · ${doc.review.date}` : ''}`);
  lines.push(doc.pushed.storyIds.length
    ? `pushed: ${doc.pushed.storyIds.length} stories · ${doc.pushed.at}`
    : 'pushed: not yet');
  lines.push('');
  return lines.join('\n');
}
```

- [ ] **Step 4: Run tests + typecheck**

Run: `npx vitest run server/design.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/design.ts server/design.test.ts
git commit -m "feat(design): pure core — doc shape, agree-per-part check, ordered gates, markdown

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: `server/design-store.ts` — the fs wrapper

**Files:**
- Create: `server/design-store.ts`
- Modify: `server/discovery-store.ts` (extract a meetings-core helper; add the `design-walkthrough` artifact kind)
- Test: `server/design-store.test.ts`

**Interfaces:**
- Consumes: Task 1's `DesignDoc`, `parseDesignDoc`, `emptyDesignDoc`, `designAgreementCheck`, `renderDesignMarkdown`.
- Produces:
  - `readDesignDoc(featureFolderPath: string): DesignDoc | null`
  - `writeDesignDoc(featureFolderPath: string, doc: DesignDoc, opts: { featureDisplayName: string }): void` (writes `design/design.json` + regenerates `design/design.md`)
  - `listDesignMeetings(featureFolderPath: string): DiscoveryMeeting[]` (reads `design/meetings/`)
  - `listDiagrams(featureFolderPath: string): string[]` (`design/diagrams/*.svg` file names, sorted; missing dir → `[]`)
  - `diagramPath(featureFolderPath: string, name: string): string | null` (null unless `name` matches `/^[\w][\w.-]*\.svg$/` — path-safety)
  - In `discovery-store.ts`: `listMeetingsFromDir(absDir: string): DiscoveryMeeting[]` (the extracted core; existing `listMeetings` becomes a one-line wrapper pointing it at `discovery/meetings`), and `HtmlArtifactKind` gains `'design-walkthrough'` whose path is `<feature>/design/walkthrough.html` (refactor the file map so each kind carries its folder AND file name; existing kinds keep `demo/`).

- [ ] **Step 1: Write the failing tests** (`server/design-store.test.ts`, temp-dir style copied from `server/discovery-store.test.ts`)

Test cases (write them as real code following the sibling file's mkdtemp pattern):
1. `readDesignDoc` on a folder with no `design/` → null; after `writeDesignDoc` → round-trips the doc and `design.md` exists containing `## The approach`.
2. `listDesignMeetings` reads `design/meetings/*.md` (title from `#` heading) and ignores `sources/`; missing folder → `[]`.
3. `listMeetings` (discovery) still works — regression on the extraction.
4. `listDiagrams` returns only `.svg` names, sorted; `diagramPath` rejects `../evil.svg` and `x.png` (null) and accepts `deploy-flow.svg`.
5. `hasHtmlArtifact(dir, 'design-walkthrough')` is false, then true after writing `design/walkthrough.html`; `'walkthrough'` still resolves to `demo/walkthrough.html` (regression).

- [ ] **Step 2: Run to verify failure** — `npx vitest run server/design-store.test.ts` → FAIL.

- [ ] **Step 3: Implement.** `design-store.ts` mirrors `discovery-store.ts`'s read/write/ensure-dir discipline (try/catch everywhere, never throw). The `discovery-store.ts` refactor is mechanical: move the body of `listMeetings` into `listMeetingsFromDir(absDir)`, keep the public signature working; change `HTML_ARTIFACT_FILE` from `Record<kind, filename>` to `Record<kind, { dir: string; file: string }>` and update `htmlArtifactPath` accordingly (`walkthrough` → `demo/walkthrough.html`, `demo` → its current file name unchanged, `design-walkthrough` → `design/walkthrough.html`).

- [ ] **Step 4: Full suite + typecheck** — `npx vitest run && npm run typecheck` → PASS (discovery-store tests prove the refactor safe).

- [ ] **Step 5: Commit**

```bash
git add server/design-store.ts server/design-store.test.ts server/discovery-store.ts
git commit -m "feat(design): design-store — read/write, meetings, diagrams, design-walkthrough artifact

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: the API — design route, diagram serving, client types

**Files:**
- Modify: `vite.config.ts` (the `/api/discovery` middleware)
- Modify: `src/lib/api.ts`

**Interfaces:**
- Consumes: Task 2's store functions.
- Produces:
  - Route `GET /api/discovery/<id>/design` → `{ folderPath, doc: DesignDoc | null, meetings, diagrams: string[], hasWalkthrough: boolean }` — disk-only, never touches ADO.
  - Route `GET /api/discovery/<id>/diagram/<name>` → the SVG file, `Content-Type: image/svg+xml`; 404 when `diagramPath` returns null or the file is missing.
  - `html/<kind>` accepts `design-walkthrough`.
  - `src/lib/api.ts`: `ApiDesignStory`, `ApiDesignDoc` (mirror Task 1's shapes, all new object fields optional-safe), `DesignPayload { folderPath: string; doc: ApiDesignDoc | null; meetings: ApiDiscoveryMeeting[]; diagrams: string[]; hasWalkthrough: boolean }`, `fetchDesign(id: number): Promise<DesignPayload>`.

- [ ] **Step 1: Extend the route regex** in `vite.config.ts` from `(board|demo|open-folder|image|html)` to `(board|demo|open-folder|image|html|design|diagram)` and add the two branches beside the existing `image`/`html` handlers, importing from `./server/design-store`. Follow the existing branches' shape exactly (status codes, JSON errors, safe-name checks).
- [ ] **Step 2: Add the types + fetch helper** to `src/lib/api.ts`, next to the discovery ones, same JSDoc style.
- [ ] **Step 3: Verify** — `npm run typecheck && npx vitest run` → PASS. Note in the report: vite.config changes need a DEV-SERVER RESTART to take effect (do not "verify" against a stale running server).
- [ ] **Step 4: Commit**

```bash
git add vite.config.ts src/lib/api.ts
git commit -m "feat(design): /api/discovery/<id>/design + diagram serving + client types

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: the D&D Design tab

**Files:**
- Modify: `src/components/DnDView.tsx` (replace the `DesignFacet` placeholder; sub-tab wiring in `FacetReadingArea`)
- Modify: `src/styles/dashboard.css`

**Interfaces:**
- Consumes: Task 3's `fetchDesign` + `DesignPayload`; existing `AgreedMark`, `MeetingsFacet`, `ArtifactView`, `renderDescription` patterns; agreement keys from Task 1.
- Produces: nothing for later tasks.

Requirements (follow existing component patterns in this file; no component tests):

- `type DesignSub = 'review' | 'meetings' | 'walkthrough'`. When `facet === 'design'`, the pinned read-head shows a `DesignSubBar` (same `dnd-subtabs` classes as `DiscoverySubBar`; Meetings tab shows a count hint; Walkthrough tab only enabled state — no hint). The existing `?sub=` URL param carries the value; switching feature or facet resets to `review` (mirror the discovery reset behavior).
- `DesignFacet` fetches `fetchDesign(featureId)` in a `useEffect` keyed on `featureId` with loading/error states (mirror how the doc payload is fetched today); defensive `payload.doc ?? null`, `payload.meetings ?? []`, `payload.diagrams ?? []`.
- No design yet (`doc === null`): keep a friendly empty state — `This feature has no design yet. In a Discovery & Design chat, say "start the design".` (replaces "coming soon"; the `soon` hint on the facet tab at line ~408 is REMOVED).
- Review sub-tab renders, in order, using the same collapsible `dnd-group` card + `AgreedMark` patterns as `DiscoveryReview`:
  1. A quiet gate line at the top (`dnd-section-note`): `Parts agreed: n of m · review: <status> · stories pushed: <count or 'not yet'>` (compute n/m from the same present-parts logic: non-empty parts + all stories).
  2. **The approach** — lines as a list; if `approach.diagram` is set and present in `diagrams`, show `<img src={/api/discovery/${id}/diagram/${name}} className="dnd-diagram" alt="architecture picture">`. `AgreedMark on={agreed.includes('approach')}` (mark only when the part is non-empty).
  3. **The flows** — one card per flow: name, numbered steps, optional diagram image, `AgreedMark` for the `flows` key on the section header.
  4. **The stories** — one card per story: title + `<span className="dnd-hours">{estimateHours}h</span>` chip in the summary row + per-story `AgreedMark on={agreed.includes(`story:${s.title}`)}`; body shows `covers` and a `Why this estimate:` line with `why`.
  5. **The working plan** — ordered list, each step with its story names and note.
  6. **Open decisions** — question → choice, or `not decided yet` in muted style.
- Meetings sub-tab: `<MeetingsFacet meetings={payload.meetings} />` (reuse — the component takes a list; if its empty-state line is discovery-specific, generalize the copy to `No meeting summaries yet. Tell your work chat about a meeting and it will land here.`).
- Walkthrough sub-tab: `payload.hasWalkthrough ? <ArtifactView featureId={id} kind="design-walkthrough" title="Design walkthrough" /> : <p className="dnd-artifact-empty">No design walkthrough built yet. In a Discovery & Design chat, ask to build the design walkthrough.</p>`. Confirm `ArtifactView` passes its `kind` straight into the `/html/<kind>` URL (it does today for walkthrough/demo — no change expected).
- CSS additions (after the discovery card styles): `.dnd-diagram { max-width: 100%; border: 1px solid var(--line-hair); border-radius: 10px; background: var(--surface-2); }` and `.dnd-hours { font-size: 12px; font-weight: 600; color: var(--accent); background: var(--accent-soft); padding: 3px 8px; border-radius: 6px; white-space: nowrap; }`. Reuse everything else.

- [ ] **Step 1: Implement** per above.
- [ ] **Step 2: Verify** — `npm run typecheck && npx vitest run` → PASS.
- [ ] **Step 3: Commit**

```bash
git add src/components/DnDView.tsx src/styles/dashboard.css
git commit -m "feat(dnd): Design tab — review/meetings/walkthrough sub-tabs, agreed marks, diagrams

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: MCP — the design close gate + the push tool

**Files:**
- Modify: `mcp/server.ts`

**Interfaces:**
- Consumes: Task 1's `isDesignStoryTitle`, `designGateMessage`, `parseDesignDoc`; Task 2's `readDesignDoc`, `writeDesignDoc`, `listDesignMeetings`; existing `createStory` from `server/writes.ts`, `getActiveFeature`, `displayNameFor`, `jsonResult`/`errorResult`, `markSHCreated`.
- Produces: the `design_push_stories` MCP tool.

- [ ] **Step 1: The close gate.** In the story-close handler, directly after the existing discovery gate block (~line 1636), add the mirror:

```ts
      // Design stories must pass the three ordered gates before they close:
      // agreed with the user → design review recorded → stories pushed.
      // Same active-feature guard as the discovery gate above.
      if (isDesignStoryTitle(d.title)) {
        const active = getActiveFeature();
        if (active && d.parent?.id === active.id) {
          const block = designGateMessage({
            isDesignStory: true,
            doc: readDesignDoc(active.folderPath),
            meetingCount: listDesignMeetings(active.folderPath).length,
          });
          if (block) return errorResult(block);
        }
      }
```

- [ ] **Step 2: The push tool.** Register `design_push_stories` next to `story_create`:

```ts
server.registerTool(
  'design_push_stories',
  {
    title: 'Push the agreed design stories to the board',
    description:
      "Create every story drafted in the active feature's design on the board in one step. Refuses unless every design part is agreed AND the design review is recorded as done — and refuses a second push. Estimates come from the design's estimateHours per story (Effort set once; Story Points derived automatically). Returns the created stories so you can echo their displayName.",
    inputSchema: {},
  },
  async () => {
    try {
      const active = getActiveFeature();
      if (!active) return errorResult('No active feature. Open the feature this design belongs to first.');
      const doc = readDesignDoc(active.folderPath);
      if (!doc) return errorResult('This feature has no design yet — nothing to push.');
      if (doc.pushed.storyIds.length > 0) {
        return errorResult(`These design stories are already on the board (pushed ${doc.pushed.at}). A second push would duplicate them. To change a story, edit it on the board.`);
      }
      const gate = designGateMessage({
        isDesignStory: true, doc, meetingCount: listDesignMeetings(active.folderPath).length,
      });
      // The only gate allowed to remain at push time is the push itself.
      if (gate && !gate.includes('push')) return errorResult(gate);
      if (doc.stories.length === 0) return errorResult('The design has no stories drafted — nothing to push.');
      const created: { id: number; displayName: string }[] = [];
      for (const s of doc.stories) {
        const made = await createStory({
          title: s.title,
          description: `${s.covers}\n\nWhy this estimate: ${s.why}`,
          effortHours: s.estimateHours,
          parentFeatureId: active.id,
        });
        markSHCreated(made.id, 'story');
        created.push({ id: made.id, displayName: displayNameFor(made.id, s.title) });
      }
      doc.pushed = { at: new Date().toISOString(), storyIds: created.map(c => c.id) };
      writeDesignDoc(active.folderPath, doc, { featureDisplayName: active.displayName ?? String(active.id) });
      invalidateDashboardCache();
      return jsonResult({ pushed: created });
    } catch (e) {
      return errorResult(e instanceof Error ? e.message : String(e));
    }
  },
);
```

(Adapt the exact `getActiveFeature()` return field names to what the discovery gate block already uses in this file — same object, same fields. If a push fails mid-loop, the catch returns the error; already-created stories stay on the board and `pushed` stays empty — the error message must then tell the chat to say plainly which stories were already created, so add the created-so-far list to the error text when `created.length > 0`.)

- [ ] **Step 3: SERVER_INSTRUCTIONS.** Add a short "DESIGN PHASE" block next to the discovery block: design story per feature ("Design: X" title), design.json parts, agree-per-part, gates in order, `design_push_stories` at the end, no clock. Keep it under ~15 lines, same voice as the discovery block.
- [ ] **Step 4: Verify** — `npm run typecheck && npx vitest run` → PASS (handler glue itself has no unit tests — repo decision; the pure gate logic is already covered by Task 1).
- [ ] **Step 5: Commit**

```bash
git add mcp/server.ts
git commit -m "feat(design): close gate + design_push_stories tool

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: the skills — new `design` seed skill, walkthrough design mode, sync list

**Files:**
- Create: `~/projects/github-moran/features/.claude/skills/design/SKILL.md` (SEED)
- Modify: `~/projects/github-moran/features/.claude/skills/walkthrough/SKILL.md` (SEED)
- Modify: `server/skills-sync.ts` + `server/skills-sync.test.ts` (repo)

**Interfaces:**
- Consumes: Task 1's exact keys and field names; Task 5's tool name.
- Produces: nothing.

- [ ] **Step 1: `MANAGED_SKILLS`** in `server/skills-sync.ts` becomes `['demo', 'design', 'discovery', 'walkthrough']`. Update any test in `server/skills-sync.test.ts` that enumerates the managed skills. Run `npx vitest run server/skills-sync.test.ts` → PASS. Commit:

```bash
git add server/skills-sync.ts server/skills-sync.test.ts
git commit -m "feat(design): design joins the managed skills

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

- [ ] **Step 2: Write the seed `design` skill.** Create the file with this FULL content:

```markdown
---
name: design
description: Use when running the DESIGN phase on a feature in this workspace — turning a finished discovery into agreed stories with estimates, a working plan, diagrams, and a push to the board. Comes AFTER discovery, never replaces it.
---

# Design (this workspace)

Design turns a finished discovery into work the team can pick up: stories
with estimates, a build order, and pictures. It ends with ONE push that
creates the stories on the board — nothing lands there before it.

## Where it lives

`design/design.json` in the feature's folder (create `design/` if absent).
sprint-helper regenerates `design/design.md` from it — keep the JSON right,
never hand-edit the md. Pictures are SVG files in `design/diagrams/`.
Meeting summaries (the design review too) go in `design/meetings/` — same
rules as discovery meetings: summaries ONLY, raw material in
`design/meetings/sources/`, never rewrite an existing meeting file.

## Start from the discovery

Read `discovery.json` first. It feeds design:

- `option` items and the tech lead's lane become entries in `decisions`.
- Risks and `dep` items must show up in story estimates: a story touching
  one gets more room, and its `why` line names it.

## The EXACT file shape — write these keys, no others

```json
{
  "approach": { "lines": ["plain line: how we'll build it"], "diagram": "architecture.svg" },
  "flows": [ { "name": "Deploy flow", "steps": ["step 1", "step 2"], "diagram": "" } ],
  "stories": [
    { "title": "Board-ready story title", "covers": "what this story delivers", "estimateHours": 8,
      "why": "why this number — name the discovery risk or waits-on it touches" }
  ],
  "plan": [ { "step": "what gets built at this step", "stories": ["Board-ready story title"], "note": "" } ],
  "decisions": [ { "question": "the open choice", "choice": "", "decidedInMeeting": "" } ],
  "review": { "status": "none", "date": "" },
  "pushed": { "at": "", "storyIds": [] },
  "agreed": ["approach", "flows", "plan", "decisions", "story:Board-ready story title"]
}
```

- `review.status` is `none` / `scheduled` / `done` — set `done` only after the
  review meeting's summary file exists in `design/meetings/`.
- NEVER write `pushed` yourself — the push tool owns it.
- NEVER write a key into `agreed` without USER's explicit yes on that part.

## Agree per part — never hand USER a finished wall

Build ONE PART at a time: approach → flows → each story (one by one — every
story gets its own yes and its own `story:<title>` key) → plan → decisions.
After drafting each part: explain it in simple, non-academic English
(simplify the WORDING, never the content), ask for USER's take, wait, and
only on a yes add its key to `agreed`. If an agreed part changes later,
remove its key and re-walk it. Retitling a story drops its old mark.

## Estimates must show their homework

Propose hours per story and say why in the `why` field, in plain words. A
story touching a discovery `risk` or `dep` MUST name it there and gets more
room. Before proposing, use the estimate history tool
(`mcp__sprint-helper__estimate_anchor`) so numbers anchor to USER's real
history, not gut.

## Diagrams

Write self-contained SVG files into `design/diagrams/` (no external fonts or
images). Boxes, arrows, short labels — readable at ~800px wide, calm colors.
One picture for the architecture, one per flow that earns it. Reference each
file by name in the JSON (`diagram` fields).

## The order of endings — three doors

1. Every part agreed (the file's `agreed` covers everything present).
2. The design review: when USER says it happened, write the meeting summary
   in `design/meetings/`, set `review.status: "done"`, and fill
   `choice`/`decidedInMeeting` on any decision the meeting settled.
3. The push: only when USER says push, call
   `mcp__sprint-helper__design_push_stories`. Echo the created stories'
   `displayName` strings verbatim. The board never sees drafts before this.

The design story on the board will not close until all three doors are
passed, in that order — the close message always names the next door.

## Plain English

Short sentences, everyday words — USER is a non-native English speaker.
Names before numbers: echo `displayName` strings verbatim. One idea per
line; no walls of text. Every line exactly right — a wrong line a reviewer
trusts is worse than a missing one.
```

- [ ] **Step 3: Walkthrough skill design mode.** In the seed `walkthrough/SKILL.md`, after the `## When to offer it` section, add:

```markdown
## Design walkthrough (second mode)

When asked for a DESIGN walkthrough, everything in this skill applies with
these swaps: read `design.json` instead of `discovery.json`; write
`demo/../design/walkthrough.html` — that is, `design/walkthrough.html` in
the feature folder; slides in this order: title → the approach (embed the
architecture SVG inline) → one slide per flow (embed its SVG) → the stories
(title + hours + the why line, table layout) → the working plan → open
decisions. Embed diagrams by pasting the SVG inline, never by file
reference — the file must stay self-contained. The dashboard shows it under
Design → Walkthrough.
```

- [ ] **Step 4: Self-check.** Re-read both seed files; the JSON example must parse (extract + `JSON.parse`); no contradictions (the walkthrough skill's discovery wording stays intact for mode 1). No git in the seed folder — no commit there.
- [ ] **Step 5: Remind in the task report** that a `skills_sync` run is needed after merge.

---

## Final QA (controller, after all tasks)

- `npm run typecheck && npx vitest run && npm run build` — all green.
- Remind USER: restart the dashboard dev server (vite.config changed), run `skills_sync`, and open a fresh work-chat session (MCP server changed).
- Headless smoke on the CD feature: `?mode=dnd&feature=426639&facet=design&sub=review` → the "no design yet" empty state renders (no design exists yet); Discovery tab regression-checked in the same run.
- USER smokes the real flow end-to-end in the work chat: start design → agree parts → record review → push → watch the stories land on the board.
