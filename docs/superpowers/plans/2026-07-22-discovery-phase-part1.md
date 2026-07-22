# Discovery Phase — Part 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give sprint-helper the ability to hold, render, track, and lightly enforce a per-feature discovery — the source-of-content file, its markdown render, read-from-any-session tracking, the build-start nudge, the story-close gate, the day-count, and the story-exception — plus the seeded discovery skill that steers the AI to fill it.

**Architecture:** A new pure module `server/discovery.ts` owns the source-file shape, its markdown render, the "finished" check, and the day-count — all pure functions over data passed in, defensively parsed (garbage → safe empty, never throws), mirroring `server/workspace.ts`. The source file is a JSON file (`discovery.json`) inside the feature's workspace folder; a rendered `discovery.md` sits beside it. A tiny settings-backed record tracks story-level-exception flags. The story-close gate is added to the existing `story_close` handler in `mcp/server.ts`. The build-start nudge and day-count surface through the existing orient packet (`server/orient.ts`). The seeded discovery skill is a markdown file added to the seed folder so `ensureWorkspaceScaffold` copies it into every workspace.

**Tech Stack:** TypeScript / Node (ESM, `node:fs`/`node:path`), `@modelcontextprotocol/sdk`, Vitest. Front end untouched in Part 1.

## Global Constraints

- **The real typecheck gate is `npm run typecheck` (= `tsc -b --noEmit`, project references). Bare `tsc --noEmit` checks NOTHING** because the root tsconfig has `"files": []`. Vitest transpiles without type-checking, so green tests can mask a broken build. Every task's final verification runs `npm run typecheck` AND `npm test`.
- **Tests live next to code as `*.test.ts`** under `server/**` (vitest `include: ['server/**/*.test.ts', 'src/**/*.test.ts']`). No separate tests dir.
- **Defensive parsing, never throw on read.** All readers of the source file / settings return a safe empty state on missing/garbage input — same pattern as `readJsonArray` in `server/workspace.ts`.
- **ADO owns status.** "Discovery finished" has ONE truth: the discovery story is closed. The required-parts check runs AT the story-close moment; we do NOT keep a second persisted "is-done" flag.
- **Sun–Thursday workweek.** Reuse `DEFAULT_WORKING_DAYS` (`new Set([0,1,2,3,4])`) and `countWorkingDays(start, end, workdaySet)` from `server/capacity.ts` for all day counting. Do not re-implement.
- **Plain-English copy to the user.** Nudge/flag strings use everyday words. Banned words: "slack", "burndown", "scope" (noun), "blockers" (collective), "cleanup moves". Names before numbers when referencing work items.
- **Commit after each task. Do NOT push. Never push main** (the user's standing rule).
- **KISS/DRY/YAGNI.** Part 1 only. No demo builder, no dashboard UI, no auto-HTML doc render — those are later, separate plans.

---

### Task 1: Discovery source-file shape + defensive parse

**Files:**
- Create: `server/discovery.ts`
- Test: `server/discovery.test.ts`

**Interfaces:**
- Produces:
  - `interface DiscoveryItem { text: string; tags: DiscoveryTag[] }`
  - `type DiscoveryTag = 'diff' | 'risk' | 'fact' | 'option'` (an item tagged both a fact and an option carries both `'fact'` and `'option'` — this is the spec's `both`)
  - `interface DiscoveryGroup { name: string; items: DiscoveryItem[] }`
  - `type DemoStatus = 'none' | 'scheduled' | 'built'`
  - `interface DiscoveryDoc { problem: string; flow: string[]; groups: DiscoveryGroup[]; lanes: { ours: string; techLead: string }; demo: { status: DemoStatus; shape: string; date: string }; openQuestions: string[] }`
  - `function parseDiscoveryDoc(raw: string | null | undefined): DiscoveryDoc | null` — JSON-parses, validates shape, returns null on missing/garbage/wrong-type. Never throws.
  - `function emptyDiscoveryDoc(): DiscoveryDoc` — a doc with empty problem, empty arrays, `demo.status: 'none'`.

- [ ] **Step 1: Write the failing test**

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run server/discovery.test.ts`
Expected: FAIL — `Cannot find module './discovery'`.

- [ ] **Step 3: Write minimal implementation**

```ts
// server/discovery.ts
/**
 * Per-feature discovery: the source-of-content file shape, its markdown render,
 * the "finished" check, and the day-count. Pure functions over data passed in;
 * every reader tolerates missing/garbage input and returns a safe empty state,
 * never throws — same discipline as server/workspace.ts. No fs or ADO access in
 * the pure core; the fs wrapper lives in Task 2.
 */

export type DiscoveryTag = 'diff' | 'risk' | 'fact' | 'option';
const VALID_TAGS: ReadonlySet<string> = new Set(['diff', 'risk', 'fact', 'option']);

export interface DiscoveryItem { text: string; tags: DiscoveryTag[] }
export interface DiscoveryGroup { name: string; items: DiscoveryItem[] }
export type DemoStatus = 'none' | 'scheduled' | 'built';
const VALID_DEMO: ReadonlySet<string> = new Set(['none', 'scheduled', 'built']);

export interface DiscoveryDoc {
  problem: string;
  flow: string[];
  groups: DiscoveryGroup[];
  lanes: { ours: string; techLead: string };
  demo: { status: DemoStatus; shape: string; date: string };
  openQuestions: string[];
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const strArray = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];

function parseItem(v: unknown): DiscoveryItem | null {
  if (v == null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  if (typeof o.text !== 'string') return null;
  const tags = Array.isArray(o.tags)
    ? (o.tags.filter((t): t is DiscoveryTag => typeof t === 'string' && VALID_TAGS.has(t)))
    : [];
  return { text: o.text, tags };
}

function parseGroup(v: unknown): DiscoveryGroup | null {
  if (v == null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  if (typeof o.name !== 'string') return null;
  const items = Array.isArray(o.items)
    ? o.items.map(parseItem).filter((i): i is DiscoveryItem => i !== null)
    : [];
  return { name: o.name, items };
}

export function emptyDiscoveryDoc(): DiscoveryDoc {
  return {
    problem: '', flow: [], groups: [],
    lanes: { ours: '', techLead: '' },
    demo: { status: 'none', shape: '', date: '' },
    openQuestions: [],
  };
}

/** Parse the source file; missing/garbage/wrong-shape → null. Never throws. */
export function parseDiscoveryDoc(raw: string | null | undefined): DiscoveryDoc | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const o = parsed as Record<string, unknown>;
  const lanes = (o.lanes && typeof o.lanes === 'object' && !Array.isArray(o.lanes))
    ? o.lanes as Record<string, unknown> : {};
  const demo = (o.demo && typeof o.demo === 'object' && !Array.isArray(o.demo))
    ? o.demo as Record<string, unknown> : {};
  const status = typeof demo.status === 'string' && VALID_DEMO.has(demo.status)
    ? demo.status as DemoStatus : 'none';
  return {
    problem: str(o.problem),
    flow: strArray(o.flow),
    groups: Array.isArray(o.groups)
      ? o.groups.map(parseGroup).filter((g): g is DiscoveryGroup => g !== null) : [],
    lanes: { ours: str(lanes.ours), techLead: str(lanes.techLead) },
    demo: { status, shape: str(demo.shape), date: str(demo.date) },
    openQuestions: strArray(o.openQuestions),
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run server/discovery.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Typecheck + commit**

```bash
npm run typecheck
git add server/discovery.ts server/discovery.test.ts
git commit -m "feat(discovery): source-file shape + defensive parse"
```

---

### Task 2: Render the doc to markdown + the "finished" check

**Files:**
- Modify: `server/discovery.ts`
- Test: `server/discovery.test.ts` (add cases)

**Interfaces:**
- Consumes: `DiscoveryDoc`, `DiscoveryGroup`, `DiscoveryItem` from Task 1.
- Produces:
  - `function renderDiscoveryMarkdown(doc: DiscoveryDoc, opts: { featureDisplayName: string }): string`
  - `function isGroupComplete(g: DiscoveryGroup): boolean` — true when the group has ≥1 item tagged `diff`, ≥1 item tagged `risk`, and ≥1 item tagged `fact` OR `option`.
  - `function discoveryFinishedCheck(doc: DiscoveryDoc | null): { ok: boolean; missing: string[] }` — ok when `doc` is non-null, `flow.length > 0`, and at least one group passes `isGroupComplete`. `missing` lists the human-readable gaps.

- [ ] **Step 1: Write the failing test**

```ts
// append to server/discovery.test.ts
import { renderDiscoveryMarkdown, isGroupComplete, discoveryFinishedCheck } from './discovery';

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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run server/discovery.test.ts`
Expected: FAIL — `renderDiscoveryMarkdown`/`isGroupComplete`/`discoveryFinishedCheck` are not exported.

- [ ] **Step 3: Write minimal implementation**

```ts
// append to server/discovery.ts

export function isGroupComplete(g: DiscoveryGroup): boolean {
  const has = (t: DiscoveryTag) => g.items.some(i => i.tags.includes(t));
  return has('diff') && has('risk') && (has('fact') || has('option'));
}

/** The story-close gate reads this. ok = a real flow + at least one complete
 *  group. `missing` is plain-English so the close error can quote it. */
export function discoveryFinishedCheck(doc: DiscoveryDoc | null): { ok: boolean; missing: string[] } {
  const missing: string[] = [];
  if (!doc) return { ok: false, missing: ['a discovery doc (none found)'] };
  if (doc.flow.length === 0) missing.push('an end-to-end flow');
  if (!doc.groups.some(isGroupComplete)) {
    missing.push('at least one context group with a difference, a risk, and a fact or option');
  }
  return { ok: missing.length === 0, missing };
}

export function renderDiscoveryMarkdown(
  doc: DiscoveryDoc,
  opts: { featureDisplayName: string },
): string {
  const lines: string[] = [];
  lines.push(`# Discovery: ${opts.featureDisplayName}`, '');
  lines.push('## What we\'re solving', '', doc.problem || '_(not filled in)_', '');
  lines.push('## The feature end-to-end', '');
  if (doc.flow.length === 0) lines.push('_(no flow yet)_');
  else doc.flow.forEach((s, i) => lines.push(`${i + 1}. ${s}`));
  lines.push('');
  lines.push('## Context groups', '');
  if (doc.groups.length === 0) lines.push('_(no groups yet)_', '');
  for (const g of doc.groups) {
    lines.push(`### ${g.name}`, '');
    for (const it of g.items) {
      const tags = it.tags.length ? ` [${it.tags.join(', ')}]` : '';
      lines.push(`- ${it.text}${tags}`);
    }
    lines.push('');
  }
  lines.push('## Lanes', '');
  lines.push(`- Ours: ${doc.lanes.ours || '_(not filled in)_'}`);
  lines.push(`- Tech Lead's (parked): ${doc.lanes.techLead || '_(not filled in)_'}`, '');
  lines.push('## Demo', '');
  lines.push(`status: ${doc.demo.status}  ·  shape: ${doc.demo.shape || '—'}  ·  date: ${doc.demo.date || '—'}`, '');
  lines.push('## Open questions for the platform-team talk', '');
  if (doc.openQuestions.length === 0) lines.push('_(none yet)_');
  else doc.openQuestions.forEach(q => lines.push(`- ${q}`));
  lines.push('');
  return lines.join('\n');
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run server/discovery.test.ts`
Expected: PASS (all Task 1 + Task 2 tests).

- [ ] **Step 5: Typecheck + commit**

```bash
npm run typecheck
git add server/discovery.ts server/discovery.test.ts
git commit -m "feat(discovery): markdown render + finished check"
```

---

### Task 3: Day-count from first session, pause-aware, over-run-once

**Files:**
- Modify: `server/discovery.ts`
- Test: `server/discovery.test.ts` (add cases)

**Interfaces:**
- Consumes: `countWorkingDays` and `DEFAULT_WORKING_DAYS` from `server/capacity.ts`.
- Produces:
  - `type DiscoveryDayStage = 'none' | 'ok' | 'day2' | 'day3' | 'overrun'`
  - `function discoveryDayStage(args: { firstSessionAt: string | null; now: Date; workdays?: Set<number> }): { workday: number; stage: DiscoveryDayStage }` — `workday` is the count of Sun–Thu working days from the first session date through `now` (inclusive, so the first day = 1). Stage: no first session → `none`; workday 1 → `ok`; 2 → `day2`; 3 → `day3`; ≥4 → `overrun`.
  - `function discoveryDayNudge(stage: DiscoveryDayStage): string | null` — the plain-English line for each stage; `null` for `none`/`ok`.

**Note on "pause-aware" and "over-run once":** the count is over *working days* (Sun–Thu), so Fri/Sat and a multi-day gap where those days aren't workdays don't inflate it beyond real working days elapsed. "Over-run once" is enforced by the caller (Task 5) recording that the over-run line was shown; the pure function just reports the stage. Keeping the once-only state in the caller avoids a second persisted flag inside the doc.

- [ ] **Step 1: Write the failing test**

```ts
// append to server/discovery.test.ts
import { discoveryDayStage, discoveryDayNudge } from './discovery';

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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run server/discovery.test.ts`
Expected: FAIL — `discoveryDayStage`/`discoveryDayNudge` not exported.

- [ ] **Step 3: Write minimal implementation**

```ts
// append to server/discovery.ts — add this import at the TOP of the file with the others:
//   import { countWorkingDays, DEFAULT_WORKING_DAYS } from './capacity';

export type DiscoveryDayStage = 'none' | 'ok' | 'day2' | 'day3' | 'overrun';

export function discoveryDayStage(args: {
  firstSessionAt: string | null;
  now: Date;
  workdays?: Set<number>;
}): { workday: number; stage: DiscoveryDayStage } {
  if (!args.firstSessionAt) return { workday: 0, stage: 'none' };
  const start = new Date(args.firstSessionAt);
  if (Number.isNaN(start.getTime())) return { workday: 0, stage: 'none' };
  const workday = countWorkingDays(start, args.now, args.workdays ?? DEFAULT_WORKING_DAYS);
  let stage: DiscoveryDayStage;
  if (workday <= 1) stage = 'ok';
  else if (workday === 2) stage = 'day2';
  else if (workday === 3) stage = 'day3';
  else stage = 'overrun';
  return { workday, stage };
}

export function discoveryDayNudge(stage: DiscoveryDayStage): string | null {
  switch (stage) {
    case 'day2': return 'Discovery day 2 — aim to wrap it up today.';
    case 'day3': return 'Discovery day 3, the extra day — close it out.';
    case 'overrun': return 'This discovery has run past its 3 days — close it or say why it needs longer.';
    default: return null;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run server/discovery.test.ts`
Expected: PASS (all discovery tests).

- [ ] **Step 5: Typecheck + commit**

```bash
npm run typecheck
git add server/discovery.ts server/discovery.test.ts
git commit -m "feat(discovery): pause-aware working-day count + nudges"
```

---

### Task 4: File I/O wrapper + read-from-any-session status

**Files:**
- Create: `server/discovery-store.ts`
- Test: `server/discovery-store.test.ts`

**Interfaces:**
- Consumes: `parseDiscoveryDoc`, `renderDiscoveryMarkdown`, `discoveryFinishedCheck`, `DiscoveryDoc` from `server/discovery.ts`; `featureFolderName` from `server/workspace.ts`.
- Produces:
  - `const DISCOVERY_FILE = 'discovery.json'`, `const DISCOVERY_MD = 'discovery.md'`
  - `function readDiscoveryDoc(featureFolderPath: string): DiscoveryDoc | null` — reads `discovery.json` in the folder; missing/garbage → null. Never throws.
  - `function writeDiscoveryDoc(featureFolderPath: string, doc: DiscoveryDoc, featureDisplayName: string): void` — writes `discovery.json` AND the rendered `discovery.md` beside it (so the render can never drift from the source — it is regenerated on every write).
  - `interface DiscoveryStatus { hasDiscovery: boolean; finished: boolean; missing: string[]; demoStatus: string }`
  - `function discoveryStatus(featureFolderPath: string): DiscoveryStatus` — the read-from-any-session summary. `hasDiscovery` = file parses to non-null; `finished` = `discoveryFinishedCheck(doc).ok`.

**Testing note:** these touch the filesystem; use Node's `os.tmpdir()` + `fs.mkdtempSync` for a throwaway folder, mirroring how other fs-touching tests isolate (no DB, no network).

- [ ] **Step 1: Write the failing test**

```ts
// server/discovery-store.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readDiscoveryDoc, writeDiscoveryDoc, discoveryStatus, DISCOVERY_MD } from './discovery-store';
import { emptyDiscoveryDoc } from './discovery';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'disco-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe('discovery-store', () => {
  it('reads null when no file / garbage file', () => {
    expect(readDiscoveryDoc(dir)).toBeNull();
    writeFileSync(join(dir, 'discovery.json'), 'not json {');
    expect(readDiscoveryDoc(dir)).toBeNull();
  });

  it('writes the json AND a rendered markdown beside it', () => {
    const doc = emptyDiscoveryDoc();
    doc.problem = 'Move CD.';
    doc.flow = ['step 1'];
    writeDiscoveryDoc(dir, doc, '**Declarative CD** (#100)');
    expect(existsSync(join(dir, 'discovery.json'))).toBe(true);
    expect(existsSync(join(dir, DISCOVERY_MD))).toBe(true);
    expect(readFileSync(join(dir, DISCOVERY_MD), 'utf8')).toContain('# Discovery: **Declarative CD** (#100)');
    expect(readDiscoveryDoc(dir)!.problem).toBe('Move CD.');
  });

  it('discoveryStatus reports has/finished/demo from the folder', () => {
    expect(discoveryStatus(dir)).toEqual({ hasDiscovery: false, finished: false, missing: expect.any(Array), demoStatus: 'none' });
    const doc = emptyDiscoveryDoc();
    doc.flow = ['s1', 's2'];
    doc.groups = [{ name: 'g', items: [
      { text: 'a', tags: ['diff'] }, { text: 'b', tags: ['risk'] }, { text: 'c', tags: ['fact'] },
    ] }];
    doc.demo.status = 'scheduled';
    writeDiscoveryDoc(dir, doc, '#100');
    const st = discoveryStatus(dir);
    expect(st.hasDiscovery).toBe(true);
    expect(st.finished).toBe(true);
    expect(st.demoStatus).toBe('scheduled');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run server/discovery-store.test.ts`
Expected: FAIL — `Cannot find module './discovery-store'`.

- [ ] **Step 3: Write minimal implementation**

```ts
// server/discovery-store.ts
/**
 * Filesystem wrapper for the discovery source file. The pure shape/logic lives
 * in server/discovery.ts; this reads/writes it in a feature's workspace folder
 * and exposes the read-from-any-session status summary. Reads never throw.
 */
import { join } from 'node:path';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import {
  parseDiscoveryDoc, renderDiscoveryMarkdown, discoveryFinishedCheck,
  type DiscoveryDoc,
} from './discovery';

export const DISCOVERY_FILE = 'discovery.json';
export const DISCOVERY_MD = 'discovery.md';

export function readDiscoveryDoc(featureFolderPath: string): DiscoveryDoc | null {
  const p = join(featureFolderPath, DISCOVERY_FILE);
  if (!existsSync(p)) return null;
  try {
    return parseDiscoveryDoc(readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

/** Write the source JSON and regenerate the markdown render beside it, so the
 *  two never drift — the md is always rebuilt from the json on every write. */
export function writeDiscoveryDoc(
  featureFolderPath: string,
  doc: DiscoveryDoc,
  featureDisplayName: string,
): void {
  writeFileSync(join(featureFolderPath, DISCOVERY_FILE), JSON.stringify(doc, null, 2) + '\n');
  writeFileSync(
    join(featureFolderPath, DISCOVERY_MD),
    renderDiscoveryMarkdown(doc, { featureDisplayName }),
  );
}

export interface DiscoveryStatus {
  hasDiscovery: boolean;
  finished: boolean;
  missing: string[];
  demoStatus: string;
}

export function discoveryStatus(featureFolderPath: string): DiscoveryStatus {
  const doc = readDiscoveryDoc(featureFolderPath);
  const check = discoveryFinishedCheck(doc);
  return {
    hasDiscovery: doc !== null,
    finished: check.ok,
    missing: check.missing,
    demoStatus: doc?.demo.status ?? 'none',
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run server/discovery-store.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Typecheck + commit**

```bash
npm run typecheck
git add server/discovery-store.ts server/discovery-store.test.ts
git commit -m "feat(discovery): fs store + read-from-any-session status"
```

---

### Task 5: Story-close gate in the story_close handler

**Files:**
- Modify: `mcp/server.ts` (the `story_close` handler, currently around lines 1571–1608)
- Test: `server/discovery.test.ts` — add a pure helper + its test (the handler glue itself is smoke-tested by the user, per the project's testing note).

**Interfaces:**
- Consumes: `discoveryFinishedCheck`, `DiscoveryDoc` from `server/discovery.ts`; `readDiscoveryDoc` from `server/discovery-store.ts`; `getActiveFeature` from `server/workspace.ts`.
- Produces (pure, testable): `function discoveryCloseBlockMessage(args: { isDiscoveryStory: boolean; folderPath: string | null; check: { ok: boolean; missing: string[] } }): string | null` — returns a plain-English block message when a discovery story isn't finished, else null. Non-discovery stories always return null (never blocked by this gate).

**How "is this a discovery story?" is decided:** a story is a discovery story when its title starts with `Discovery` (case-insensitive) — matching the POM convention ("Discovery: X") seen in the reference repos. This is a cheap, title-based check; no new field on ADO. The handler computes `isDiscoveryStory` from the fetched work item's title and finds the folder via the active-feature pointer's `folderPath`.

- [ ] **Step 1: Write the failing test**

```ts
// append to server/discovery.test.ts
import { discoveryCloseBlockMessage } from './discovery';

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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run server/discovery.test.ts`
Expected: FAIL — `discoveryCloseBlockMessage` not exported.

- [ ] **Step 3: Write the pure helper**

```ts
// append to server/discovery.ts

/** Title-based: POM discovery stories are titled "Discovery: X". */
export function isDiscoveryStoryTitle(title: string): boolean {
  return /^\s*discovery\b/i.test(title);
}

/** The story-close gate's message. null = allowed to close. */
export function discoveryCloseBlockMessage(args: {
  isDiscoveryStory: boolean;
  folderPath: string | null;
  check: { ok: boolean; missing: string[] };
}): string | null {
  if (!args.isDiscoveryStory) return null;
  if (args.check.ok) return null;
  const gaps = args.check.missing.join('; ');
  return `This discovery isn't finished yet — still needs: ${gaps}. Fill it in, then close the story.`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run server/discovery.test.ts`
Expected: PASS.

- [ ] **Step 5: Wire the helper into the `story_close` handler**

In `mcp/server.ts`, add imports near the other `server/*` imports:
```ts
import { isDiscoveryStoryTitle, discoveryCloseBlockMessage, discoveryFinishedCheck } from '../server/discovery';
import { readDiscoveryDoc } from '../server/discovery-store';
import { getActiveFeature } from '../server/workspace';
```

In the `story_close` handler, AFTER the open-children guard (currently the block ending at the `openChildren.length > 0` return, ~line 1599) and BEFORE `const toState = await setStateBucket(...)`, insert:
```ts
      // Discovery stories must have a finished discovery doc before they close.
      if (isDiscoveryStoryTitle(d.title)) {
        const active = getActiveFeature();
        const folderPath = active?.folderPath ?? null;
        const doc = folderPath ? readDiscoveryDoc(folderPath) : null;
        const block = discoveryCloseBlockMessage({
          isDiscoveryStory: true,
          folderPath,
          check: discoveryFinishedCheck(doc),
        });
        if (block) return errorResult(block);
      }
```

- [ ] **Step 6: Typecheck + full test run + commit**

```bash
npm run typecheck
npm test
git add server/discovery.ts server/discovery.test.ts mcp/server.ts
git commit -m "feat(discovery): block closing an unfinished discovery story"
```

Expected: typecheck clean; full suite green.

---

### Task 6: Story-level-exception record (settings-backed)

**Files:**
- Create: `server/discovery-exception.ts`
- Test: `server/discovery-exception.test.ts`

**Interfaces:**
- Consumes: `getSetting`, `setSetting` from `server/timers.ts` (same source `server/workspace.ts` uses).
- Produces:
  - `const DISCOVERY_STORY_EXCEPTIONS_KEY = 'discovery_story_exceptions'`
  - `function getStoryExceptions(): number[]` — story ids flagged as the deliberate single-story-discovery exception. Garbage/unset → `[]`.
  - `function recordStoryException(storyId: number): void` — adds the id (dedup).
  - `function isStoryException(storyId: number): boolean`

This is the record that lets a later look-back see a single-story discovery was a deliberate one-off. The spoken-confirm itself is driven by the seeded skill's instructions (Task 7) — the code's job is only to remember the flagged ids, mirroring `getManagedFeatureIds` in `server/workspace.ts`.

- [ ] **Step 1: Write the failing test**

```ts
// server/discovery-exception.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const store = new Map<string, string>();
vi.mock('./timers', () => ({
  getSetting: (k: string) => store.get(k) ?? null,
  setSetting: (k: string, v: string) => { store.set(k, v); },
}));

import { getStoryExceptions, recordStoryException, isStoryException } from './discovery-exception';

beforeEach(() => store.clear());

describe('discovery story exceptions', () => {
  it('empty by default and on garbage', () => {
    expect(getStoryExceptions()).toEqual([]);
    store.set('discovery_story_exceptions', 'not json');
    expect(getStoryExceptions()).toEqual([]);
  });
  it('records and reports, deduped', () => {
    recordStoryException(123);
    recordStoryException(123);
    recordStoryException(456);
    expect(getStoryExceptions().sort()).toEqual([123, 456]);
    expect(isStoryException(123)).toBe(true);
    expect(isStoryException(999)).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run server/discovery-exception.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// server/discovery-exception.ts
/**
 * Remembers which stories were the deliberate "discover a single story instead
 * of the whole feature" exception, so a later look-back sees it was a conscious
 * one-off. Settings-backed, defensively parsed — mirrors getManagedFeatureIds
 * in server/workspace.ts. The spoken confirm is driven by the seeded skill; the
 * code only remembers the flagged ids.
 */
import { getSetting, setSetting } from './timers';

export const DISCOVERY_STORY_EXCEPTIONS_KEY = 'discovery_story_exceptions';

export function getStoryExceptions(): number[] {
  const raw = getSetting(DISCOVERY_STORY_EXCEPTIONS_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((n): n is number => typeof n === 'number' && Number.isFinite(n))
      : [];
  } catch {
    return [];
  }
}

export function recordStoryException(storyId: number): void {
  const ids = getStoryExceptions();
  if (!ids.includes(storyId)) {
    ids.push(storyId);
    setSetting(DISCOVERY_STORY_EXCEPTIONS_KEY, JSON.stringify(ids));
  }
}

export function isStoryException(storyId: number): boolean {
  return getStoryExceptions().includes(storyId);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run server/discovery-exception.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Typecheck + commit**

```bash
npm run typecheck
git add server/discovery-exception.ts server/discovery-exception.test.ts
git commit -m "feat(discovery): story-level-exception record"
```

---

### Task 7: Surface discovery in orient (build-start nudge + day-count)

**Files:**
- Modify: `server/orient.ts` (add a `discovery` field to `OrientPacket`, populate it in `buildOrientPacket`)
- Modify: `server/discovery.ts` (add the pure nudge composer, tested there)
- Test: `server/discovery.test.ts` (nudge composer), `server/orient.test.ts` (packet field)

**Interfaces:**
- Consumes: `getActiveFeature` from `server/workspace.ts`; `discoveryStatus` from `server/discovery-store.ts`; `discoveryDayStage`, `discoveryDayNudge` from `server/discovery.ts`; `listSessionsForWorkItem` from `server/sessions.ts` (for the first-session timestamp of the discovery story — but in Part 1 the day-count keys off the active feature's `setAt` as the first-session proxy; see note).
- Produces:
  - On `OrientPacket`: `discovery: { activeFeatureDisplayName: string; hasDiscovery: boolean; finished: boolean; demoStatus: string; startNudge: string | null; dayNudge: string | null } | null`
  - `function discoveryStartNudge(status: { hasDiscovery: boolean; finished: boolean }): string | null` — when a feature is active but its discovery isn't finished, the plain reminder; else null. This is the build-start "smart nudge" — it informs, never blocks.

**First-session timestamp in Part 1 (KISS):** the precise "first discovery session" tracking is refined when the demo step lands. For Part 1, use the active feature's `setAt` (already stored) as the first-session proxy for the day-count. This is honest for the common case (the feature is set active when discovery work begins) and avoids a new persisted timestamp before we know we need one. Documented as a known simplification.

- [ ] **Step 1: Write the failing test (nudge composer)**

```ts
// append to server/discovery.test.ts
import { discoveryStartNudge } from './discovery';

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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run server/discovery.test.ts`
Expected: FAIL — `discoveryStartNudge` not exported.

- [ ] **Step 3: Write the nudge composer**

```ts
// append to server/discovery.ts
export function discoveryStartNudge(status: { hasDiscovery: boolean; finished: boolean }): string | null {
  if (status.finished) return null;
  if (!status.hasDiscovery) {
    return 'Heads up: this feature has no finished discovery yet. Want to start one before building?';
  }
  return 'Heads up: this feature\'s discovery isn\'t finished yet.';
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run server/discovery.test.ts`
Expected: PASS.

- [ ] **Step 5: Add the `discovery` field to `OrientPacket` and populate it**

In `server/orient.ts`, add to the `OrientPacket` interface (near the `activeFeature` field, ~line 147):
```ts
  discovery: {
    activeFeatureDisplayName: string;
    hasDiscovery: boolean;
    finished: boolean;
    demoStatus: string;
    startNudge: string | null;
    dayNudge: string | null;
  } | null;
```

Add imports near the other `server/*` imports in `orient.ts`:
```ts
import { discoveryStatus } from './discovery-store';
import { discoveryDayStage, discoveryDayNudge, discoveryStartNudge } from './discovery';
```

In `buildOrientPacket`, near where `activeFeature` is computed (~line 351), add:
```ts
  const af = getActiveFeature();
  let discovery: OrientPacket['discovery'] = null;
  if (af) {
    const status = discoveryStatus(af.folderPath);
    const { stage } = discoveryDayStage({ firstSessionAt: af.setAt, now: new Date() });
    discovery = {
      activeFeatureDisplayName: displayNameFor(af.id, af.title),
      hasDiscovery: status.hasDiscovery,
      finished: status.finished,
      demoStatus: status.demoStatus,
      startNudge: discoveryStartNudge(status),
      dayNudge: discoveryDayNudge(stage),
    };
  }
```
(`getActiveFeature` and `displayNameFor` are already imported/used in `orient.ts`.) Add `discovery` to the returned packet object (near `activeFeature,` ~line 378):
```ts
    discovery,
```

- [ ] **Step 6: Add the orient packet test**

In `server/orient.test.ts`, add a case asserting the packet carries a `discovery` key (null is a valid value when no active feature). Match the existing test style in that file — read the top of `orient.test.ts` first to see how `buildOrientPacket` is invoked and mocked, then assert:
```ts
  // inside an existing describe for buildOrientPacket
  it('includes a discovery field (null when no active feature)', async () => {
    const packet = await buildOrientPacket(null);
    expect('discovery' in packet).toBe(true);
  });
```

- [ ] **Step 7: Typecheck + full test run + commit**

```bash
npm run typecheck
npm test
git add server/orient.ts server/orient.test.ts server/discovery.ts server/discovery.test.ts
git commit -m "feat(discovery): surface start-nudge + day-count in orient"
```

Expected: typecheck clean; full suite green.

---

### Task 8: The seeded discovery skill

**Files:**
- Create: `/Users/weissmmo/projects/github-moran/features/.claude/skills/discovery/SKILL.md` (the seed folder — copied into every workspace by `ensureWorkspaceScaffold`)

**Interfaces:** none (a markdown skill file — no code). This is the steering layer. It is NOT copied by any test; it ships via the existing scaffold path.

**Note:** this task has no failing-test cycle — it is a documentation/seed artifact. Its "test" is that the file exists, is well-formed markdown with the required frontmatter, and describes the method accurately. The reviewer checks it against the spec's "discovery method" section.

- [ ] **Step 1: Write the skill file**

Create the file with this content:

```markdown
---
name: discovery
description: Use when running a DISCOVERY on a feature in this workspace — a fast, high-level investigation that surfaces what's different from today and the risks it brings, sorts facts from options, and produces an end-to-end flow. NOT design, NOT implementation.
---

# Discovery (this workspace)

Discovery is the first work under a feature. It is **fast but not fast-and-dirty**:
high level, every line correct, no deep dives. It does NOT pick sides or weigh
trade-offs — that is the later Design phase.

## The rules

- **One discovery per FEATURE**, not per story. (Discovering a single story is the
  rare exception — if asked, confirm out loud first: "Just this one story, not the
  whole feature? That's the special case — yes?")
- **2 working days, 3 max.** The 3rd is a deliberate choice, never the default.
- **High level only.** Topics are one-liners, never blocks of detail.

## What discovery must produce

Fill the discovery source file (`discovery.json` in this feature's folder) with:

1. **What we're solving** — 2–3 plain lines. The problem, not the solution.
2. **The end-to-end flow** — the plain story of how the feature works, step by step.
   This is what a demo would later show.
3. **Context groups** — split the feature into areas that make sense to a reviewer.
   In each group, one-liners tagged:
   - **diff** — where this makes the team work differently than today (only if a
     real difference exists).
   - **risk** — the cost or new skill that difference brings (e.g. "double the
     ArgoCD apps → more Akuity cost"; "needs functions in KCL → a new team skill").
   - **fact** — a given, not up for debate ("our CD is in GitHub, unlike the Azure
     DevOps users know — but it's a fact").
   - **option** — a real choice to make later.
   An item can be both a fact and an option (a fact that spawns a choice) — give it
   both tags.
4. **Lanes** — one line each: what's ours vs what's the tech lead's (parked, not
   designed here).
5. **Open questions** — one-liners for the platform-team talk.

## When to write it up

A discovery is finished when the source file has an end-to-end flow AND at least
one context group with a diff, a risk, and a fact or option. The discovery story
on the board will not close until it does.

## Plain English

The reader is a non-native English speaker and some reviewers walk in cold. Short
sentences, everyday words. Read each line aloud — if a friend over coffee wouldn't
say it that way, rewrite it.
```

- [ ] **Step 2: Verify the file is well-formed**

Run: `head -5 /Users/weissmmo/projects/github-moran/features/.claude/skills/discovery/SKILL.md`
Expected: shows the frontmatter (`---`, `name: discovery`, `description:`, `---`).

- [ ] **Step 3: Commit**

```bash
# The seed folder is OUTSIDE the sprint-helper repo, so it is committed in its own repo (if tracked) or left in place.
# In the sprint-helper repo there is nothing to add for this task — confirm the file exists and note it in the ledger.
ls /Users/weissmmo/projects/github-moran/features/.claude/skills/discovery/SKILL.md
```

**Reviewer note:** this file lives in the workspace seed, not the sprint-helper repo, so it is not part of a sprint-helper commit. Confirm it exists and reads correctly against the method above.

---

## Self-Review

**Spec coverage:**
- Discovery method (per-feature, 2/3 days, high-level, diffs/risks, fact/option/both, e2e flow) → Task 8 (skill) + Tasks 1–3 (shape, render, day-count).
- Source-of-content file → Tasks 1, 4.
- Markdown render → Task 2, 4.
- Read-from-any-session tracking → Task 4 (`discoveryStatus`).
- Build-start smart nudge → Task 7 (`discoveryStartNudge`, surfaced in orient).
- Story-close hard gate → Task 5.
- Day cap (from first session, pause-aware, over-run once) → Task 3 (stage) + Task 7 (surfaced once via orient; the "once" is inherent — orient shows the current stage, it is not a repeated push notification).
- Story-exception (confirm + recorded) → Task 6 (record) + Task 8 (confirm instruction).
- Defensive parsing, ADO-owns-status single truth, Sun–Thu reuse → Global Constraints, enforced per task.
- Out of scope (demo builder, dashboard, auto-HTML) → correctly absent.

**Placeholder scan:** no TBD/TODO; every code step has complete code; the one no-code task (8) is explicitly a seed artifact with a stated verification.

**Type consistency:** `DiscoveryDoc`/`DiscoveryItem`/`DiscoveryTag`/`DiscoveryGroup`/`DemoStatus` defined in Task 1 and used unchanged in Tasks 2, 4, 5, 7. `discoveryFinishedCheck` returns `{ ok, missing }` used identically in Tasks 2, 4, 5. `discoveryStatus` shape defined in Task 4 and consumed in Task 7. `discoveryDayStage`/`discoveryDayNudge` defined in Task 3, consumed in Task 7.

**Known simplification (flagged, not a gap):** Task 7 uses the active feature's `setAt` as the first-discovery-session proxy for the day-count, deferring precise first-session tracking to the demo-step plan. Documented in Task 7.
