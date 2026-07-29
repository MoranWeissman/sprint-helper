# Discovery Tune-up Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Discovery gets two new tags (`dep`, `mitigation`), a pushback list ("what we don't accept as-is"), and an agree-per-part flow whose coverage is enforced by the story-close gate; the skills teach focus, the client step, and the explain-agree rhythm.

**Architecture:** All data-shape and gate logic lives in the pure module `server/discovery.ts` (parse-tolerant, never throws). The dashboard reads the parsed doc through the existing `/api/discovery/<id>` payload — no route changes. Skill behavior changes land in the SEED skill files only and fan out via `skills_sync`.

**Tech Stack:** TypeScript, Vitest, React, plain CSS (OKLCH tokens).

**Spec:** `docs/superpowers/specs/2026-07-29-discovery-tuneup-design.md`

## Global Constraints

- Plain English in every user-facing string. Banned words (from `~/.claude/CLAUDE.md`): "slack", "burndown", "scope" (noun), "velocity", "WIP", "work item", "blockers" (collective), "cleanup moves". Short sentences.
- Functional color only, existing tokens only: dep = `--st-waiting` family (amber), mitigation = `--st-done` family (muted sage). No new color tokens, no bright red/green.
- Never combine font-size ≤ 11px with `--ink-4`.
- Parse code never throws; missing fields default to safe empties. OLD `discovery.json` files (no `pushback`, no `agreed`, old tags only) must still parse and render.
- Old API payloads without the new fields must not crash the client (`?? []`).
- The gate's CONTENT requirements (flow + one complete group) are unchanged; agreement coverage is ADDED. `dep`/`mitigation` add no finish requirement.
- Skill edits go to SEED files under `~/projects/github-moran/features/.claude/skills/` ONLY — never to workspace or global copies (`skills_sync` fans out).
- Commits in the sprint-helper repo end with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

---

### Task 1: Server — tags, pushback, agreed, gate, markdown

**Files:**
- Modify: `server/discovery.ts`
- Test: `server/discovery.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `DiscoveryTag` now `'diff'|'risk'|'fact'|'option'|'dep'|'mitigation'`; `DiscoveryDoc` gains `pushback: string[]` and `agreed: string[]`; `discoveryFinishedCheck` additionally fails for unagreed non-empty parts with missing-entries shaped `your agreement on <part label>`; `renderDiscoveryMarkdown` appends ` · agreed ✓` to agreed section headers and prints a `## What we don't accept as-is` section (after the problem section) when `pushback` is non-empty. Task 2 relies on these exact field names.

- [ ] **Step 1: Write the failing tests**

Append to `server/discovery.test.ts` (inside the existing `describe('parseDiscoveryDoc')` block for the first two, new `describe` blocks for the rest):

```ts
  it('keeps the new dep and mitigation tags, still drops unknown ones', () => {
    const doc = {
      problem: 'x', flow: [], groups: [
        { name: 'g', items: [
          { text: 'needs platform-team access first', tags: ['dep'] },
          { text: 'start with one shared app', tags: ['mitigation', 'bogus'] },
        ] },
      ], lanes: { ours: '', techLead: '' },
      demo: { status: 'none', shape: '', date: '' }, openQuestions: [],
    };
    const parsed = parseDiscoveryDoc(JSON.stringify(doc));
    expect(parsed!.groups[0].items[0].tags).toEqual(['dep']);
    expect(parsed!.groups[0].items[1].tags).toEqual(['mitigation']);
  });

  it('reads pushback and agreed, defaulting to empty arrays', () => {
    const withBoth = parseDiscoveryDoc(JSON.stringify({
      pushback: ['this bundles two features', 7], agreed: ['problem', 'flow'],
    }));
    expect(withBoth!.pushback).toEqual(['this bundles two features']); // non-string dropped
    expect(withBoth!.agreed).toEqual(['problem', 'flow']);
    const without = parseDiscoveryDoc('{}');
    expect(without!.pushback).toEqual([]);
    expect(without!.agreed).toEqual([]);
  });
```

```ts
describe('discoveryFinishedCheck — agreement coverage', () => {
  // A doc that satisfies the CONTENT gate (flow + one complete group).
  function contentOkDoc() {
    const doc = emptyDiscoveryDoc();
    doc.flow = ['step 1', 'step 2'];
    doc.groups = [{ name: 'CD pipeline', items: [
      { text: 'a', tags: ['diff'] }, { text: 'b', tags: ['risk'] }, { text: 'c', tags: ['fact'] },
    ] }];
    return doc;
  }

  it('fails when non-empty parts are not agreed, naming each plainly', () => {
    const r = discoveryFinishedCheck(contentOkDoc());
    expect(r.ok).toBe(false);
    expect(r.missing).toContain('your agreement on the end-to-end flow');
    expect(r.missing).toContain('your agreement on the group "CD pipeline"');
  });

  it('passes when every non-empty part is agreed; empty parts need no mark', () => {
    const doc = contentOkDoc(); // problem, lanes, pushback, openQuestions all empty
    doc.agreed = ['flow', 'group:CD pipeline'];
    const r = discoveryFinishedCheck(doc);
    expect(r.ok).toBe(true);
    expect(r.missing).toEqual([]);
  });

  it('requires agreement on problem, lanes, pushback, and open questions once they have content', () => {
    const doc = contentOkDoc();
    doc.agreed = ['flow', 'group:CD pipeline'];
    doc.problem = 'Move CD to GitHub.';
    doc.lanes.ours = 'the flow shape';
    doc.pushback = ['this is a runbook, not a requirement'];
    doc.openQuestions = ['who owns the runner?'];
    const r = discoveryFinishedCheck(doc);
    expect(r.ok).toBe(false);
    expect(r.missing).toContain('your agreement on the problem');
    expect(r.missing).toContain('your agreement on the lanes');
    expect(r.missing).toContain("your agreement on the list of things we don't accept as-is");
    expect(r.missing).toContain('your agreement on the open questions');
  });

  it('a renamed group is not covered by its old mark', () => {
    const doc = contentOkDoc();
    doc.agreed = ['flow', 'group:Old name'];
    expect(discoveryFinishedCheck(doc).ok).toBe(false);
  });

  it('dep/mitigation items alone still do not complete a group', () => {
    const doc = emptyDiscoveryDoc();
    doc.flow = ['step 1'];
    doc.groups = [{ name: 'g', items: [
      { text: 'a', tags: ['dep'] }, { text: 'b', tags: ['mitigation'] },
    ] }];
    doc.agreed = ['flow', 'group:g'];
    expect(discoveryFinishedCheck(doc).ok).toBe(false); // no diff/risk/fact-or-option
  });
});

describe('renderDiscoveryMarkdown — pushback + agreed marks', () => {
  it('prints the pushback section only when non-empty, and marks agreed sections', () => {
    const doc = emptyDiscoveryDoc();
    doc.problem = 'Move CD to GitHub.';
    doc.flow = ['step 1'];
    doc.pushback = ['this bundles two features'];
    doc.agreed = ['problem', 'pushback'];
    const md = renderDiscoveryMarkdown(doc, { featureDisplayName: '**F** (#1)' });
    expect(md).toContain("## What we're solving · agreed ✓");
    expect(md).toContain("## What we don't accept as-is · agreed ✓");
    expect(md).toContain('- this bundles two features');
    expect(md).toContain('## The feature end-to-end\n'); // flow not agreed → no mark
    const empty = renderDiscoveryMarkdown(emptyDiscoveryDoc(), { featureDisplayName: 'F' });
    expect(empty).not.toContain("What we don't accept");
  });
});
```

Also UPDATE three existing tests (they will rightly break):

1. In `describe('discoveryFinishedCheck')`, the test `passes with a flow + one complete group`: after building the doc, add `doc.agreed = ['flow', 'group:g'];` so it still passes under the new coverage check.
2. In `emptyDiscoveryDoc is a well-formed empty doc`: add `expect(e.pushback).toEqual([]);` and `expect(e.agreed).toEqual([]);`.
3. In `server/discovery-store.test.ts`, the test `discoveryStatus reports has/finished/demo from the folder` (~line 46) builds a doc with a flow and one group and expects `st.finished` to be `true` — add `doc.agreed = ['flow', 'group:g'];` there too (use the group name that test actually uses). Include this file in the Task 1 commit.

- [ ] **Step 2: Run tests to verify the new ones fail**

Run: `npx vitest run server/discovery.test.ts`
Expected: FAIL — new tests fail (unknown fields / tags dropped, no agreement check, no pushback section). Type errors on `doc.pushback` / `doc.agreed` are expected at this point too.

- [ ] **Step 3: Implement in `server/discovery.ts`**

Tag union (replace lines defining `DiscoveryTag` and `VALID_TAGS`):

```ts
export type DiscoveryTag = 'diff' | 'risk' | 'fact' | 'option' | 'dep' | 'mitigation';
const VALID_TAGS: ReadonlySet<string> = new Set(['diff', 'risk', 'fact', 'option', 'dep', 'mitigation']);
```

`DiscoveryDoc` gains two fields (after `openQuestions`):

```ts
  /** "What we don't accept as-is" — pushback one-liners for the product talk.
   *  Empty = the feature is accepted as written. Never blocks closing by content. */
  pushback: string[];
  /** Parts USER agreed after a plain-English walk-through. Keys: 'problem',
   *  'flow', 'lanes', 'pushback', 'openQuestions', and `group:<group name>`.
   *  The close gate requires every non-empty part to be listed here. */
  agreed: string[];
```

`emptyDiscoveryDoc`: add `pushback: [], agreed: [],`.

`parseDiscoveryDoc` return object: add `pushback: strArray(o.pushback), agreed: strArray(o.agreed),`.

`discoveryFinishedCheck` — append before the final `return`:

```ts
  // Agree-per-part: every part with content must be walked through with USER
  // and marked agreed before the story can close. Empty parts need no mark.
  const parts: { key: string; present: boolean; label: string }[] = [
    { key: 'problem', present: doc.problem.trim() !== '', label: 'the problem' },
    { key: 'flow', present: doc.flow.length > 0, label: 'the end-to-end flow' },
    ...doc.groups.map(g => ({
      key: `group:${g.name}`, present: g.items.length > 0, label: `the group "${g.name}"`,
    })),
    {
      key: 'lanes',
      present: doc.lanes.ours.trim() !== '' || doc.lanes.techLead.trim() !== '',
      label: 'the lanes',
    },
    { key: 'pushback', present: doc.pushback.length > 0, label: "the list of things we don't accept as-is" },
    { key: 'openQuestions', present: doc.openQuestions.length > 0, label: 'the open questions' },
  ];
  for (const p of parts) {
    if (p.present && !doc.agreed.includes(p.key)) {
      missing.push(`your agreement on ${p.label}`);
    }
  }
```

`renderDiscoveryMarkdown` — add a helper at the top of the function, mark the headers, and insert the pushback section right after the problem section:

```ts
  const agreedMark = (key: string): string => (doc.agreed.includes(key) ? ' · agreed ✓' : '');
```

- `## What we're solving` → `` `## What we're solving${agreedMark('problem')}` ``
- After the problem lines, insert:

```ts
  if (doc.pushback.length > 0) {
    lines.push(`## What we don't accept as-is${agreedMark('pushback')}`, '');
    doc.pushback.forEach(p => lines.push(`- ${p}`));
    lines.push('');
  }
```

- `## The feature end-to-end` → `` `## The feature end-to-end${agreedMark('flow')}` ``
- `### ${g.name}` → `` `### ${g.name}${agreedMark(`group:${g.name}`)}` ``
- `## Lanes` → `` `## Lanes${agreedMark('lanes')}` ``
- `## Open questions for the platform-team talk` → `` `## Open questions for the platform-team talk${agreedMark('openQuestions')}` ``

- [ ] **Step 4: Run the full suite + typecheck**

Run: `npx vitest run && npm run typecheck`
Expected: PASS, everything green (including `discovery-store.test.ts` — it parses old-shaped JSON, which stays valid).

- [ ] **Step 5: Commit**

```bash
git add server/discovery.ts server/discovery.test.ts
git commit -m "feat(discovery): dep/mitigation tags, pushback list, agree-per-part close gate

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: Dashboard — new chips, pushback card, agreed marks

**Files:**
- Modify: `src/lib/api.ts` (discovery types, ~lines 252–261)
- Modify: `src/components/DnDView.tsx` (`dominantTag`, `ContextItem`, `DiscoveryReview`)
- Modify: `src/styles/dashboard.css` (after the existing `.dnd-tag.is-option` rule, ~line 5461)

**Interfaces:**
- Consumes: Task 1's field names `pushback: string[]`, `agreed: string[]`, tags `'dep'`/`'mitigation'`, agreement keys `'problem'|'flow'|'lanes'|'pushback'|'openQuestions'|'group:<name>'`.
- Produces: exported type `ApiDiscoveryTag` in `src/lib/api.ts`.

There are no component unit tests for D&D (repo decision) — verification is typecheck + full suite + browser smoke by USER.

- [ ] **Step 1: Payload types in `src/lib/api.ts`**

Replace the `ApiDiscoveryItem` line and extend `ApiDiscoveryDoc`:

```ts
export type ApiDiscoveryTag = 'diff'|'risk'|'fact'|'option'|'dep'|'mitigation';
export interface ApiDiscoveryItem { text: string; tags: ApiDiscoveryTag[] }
```

In `ApiDiscoveryDoc`, after `openQuestions: string[];`:

```ts
  /** "What we don't accept as-is" — pushback for the product talk. Older payloads omit it. */
  pushback?: string[];
  /** Parts USER agreed after a walk-through (keys like 'flow', 'group:<name>'). Older payloads omit it. */
  agreed?: string[];
```

(Optional on purpose: a dev server started before this ships sends payloads without them — the `meetings` crash taught us to type that honestly.)

- [ ] **Step 2: Tags + review cards in `src/components/DnDView.tsx`**

Add `ApiDiscoveryTag` to the existing type-import from `../lib/api`.

Replace `dominantTag` and `ContextItem`'s prop type:

```ts
/** An item can carry several tags; the spine colour follows the most important
 *  one — a risk outranks a dependency, which outranks a change; a mitigation
 *  is calmer than all three; then an option, then a plain fact. */
function dominantTag(tags: ApiDiscoveryTag[]): string {
  for (const t of ['risk', 'dep', 'diff', 'mitigation', 'option', 'fact'] as const) if (tags.includes(t)) return t;
  return 'fact';
}
```

```ts
function ContextItem(props: { item: { text: string; tags: ApiDiscoveryTag[] } }): JSX.Element {
```

Add the agreed-mark helper component next to `ContextItem`:

```tsx
/** The agree-per-part state of one Discovery card. Calm: the ✓ is quiet
 *  sage, the absence is muted text — never an alarm. */
function AgreedMark(props: { on: boolean }): JSX.Element {
  return props.on
    ? <span className="dnd-agreed is-on">agreed ✓</span>
    : <span className="dnd-agreed">not agreed yet</span>;
}
```

Rewrite `DiscoveryReview` (whole component):

```tsx
function DiscoveryReview(props: { doc: DiscoveryDocPayload['doc'] }): JSX.Element {
  const { doc } = props;
  if (!doc) return <div className="dnd-empty">This feature has no discovery yet.</div>;
  const agreed = doc.agreed ?? [];
  const pushback = doc.pushback ?? [];
  const mark = (key: string) => <AgreedMark on={agreed.includes(key)} />;
  return (
    <div className="dnd-discovery">
      <div className="dnd-problem">
        {doc.problem || '—'}
        {doc.problem !== '' && mark('problem')}
      </div>

      {pushback.length > 0 && (
        <>
          <h2 className="dnd-h2">What we don't accept as-is {mark('pushback')}</h2>
          <p className="dnd-section-note">Things in this feature we question — to raise with the product side before designing. Never blocks the work.</p>
          <ul className="dnd-push">{pushback.map((p, i) => <li key={i}>{p}</li>)}</ul>
        </>
      )}

      <h2 className="dnd-h2">The feature end-to-end {doc.flow.length > 0 && mark('flow')}</h2>
      <ol className="dnd-flow">{doc.flow.map((s, i) => <li key={i}>{s}</li>)}</ol>

      <h2 className="dnd-h2">Context groups</h2>
      {doc.groups.map((g, gi) => (
        <details key={gi} className="dnd-group">
          <summary className="dnd-group-sum">
            <span className="dnd-group-chev" aria-hidden="true" />
            <span className="dnd-group-name">{g.name}</span>
            {g.items.length > 0 && <AgreedMark on={agreed.includes(`group:${g.name}`)} />}
            <span className="dnd-group-count">{g.items.length}</span>
          </summary>
          <ul className="dnd-items">
            {g.items.map((it, ii) => <ContextItem key={ii} item={it} />)}
          </ul>
        </details>
      ))}

      <h2 className="dnd-h2">Lanes {(doc.lanes.ours !== '' || doc.lanes.techLead !== '') && mark('lanes')}</h2>
      <div className="dnd-lanes">
        <div className="dnd-lane">
          <div className="dnd-lane-lab">Ours</div>
          <p>{doc.lanes.ours || '—'}</p>
        </div>
        <div className="dnd-lane">
          <div className="dnd-lane-lab">Tech lead's</div>
          <p>{doc.lanes.techLead || '—'}</p>
        </div>
      </div>

      <h2 className="dnd-h2">Open questions {doc.openQuestions.length > 0 && mark('openQuestions')}</h2>
      <p className="dnd-section-note">Still unanswered — your agenda for the talk with the platform team.</p>
      {doc.openQuestions.length === 0
        ? <p className="dnd-muted">None noted.</p>
        : <ul className="dnd-qs">{doc.openQuestions.map((q, i) => <li key={i}>{q}</li>)}</ul>}
    </div>
  );
}
```

- [ ] **Step 3: CSS in `src/styles/dashboard.css`**

Add the item-spine rules directly after `.dnd-item.is-fact`:

```css
.dnd-item.is-dep    { border-left-color: var(--st-waiting); background: color-mix(in oklch, var(--st-waiting) 8%, var(--surface-2)); }
.dnd-item.is-mitigation { border-left-color: var(--st-done); background: color-mix(in oklch, var(--st-done) 7%, var(--surface-2)); }
```

Add the chip rules directly after `.dnd-tag.is-option`:

```css
.dnd-tag.is-dep { background: var(--st-waiting-bg); color: var(--st-waiting); }
.dnd-tag.is-mitigation { background: var(--st-done-bg); color: var(--st-done); }

/* Agree-per-part state on Discovery review cards. Quiet by design:
   the ✓ is muted sage, the "not agreed yet" is ink-3 — informative, not an alarm. */
.dnd-agreed {
  flex: none; font-size: 12px; font-weight: 600; letter-spacing: 0.02em;
  color: var(--ink-3); white-space: nowrap;
}
.dnd-agreed.is-on { color: var(--st-done); }
.dnd-problem .dnd-agreed { display: block; margin-top: 10px; }

/* "What we don't accept as-is" list — amber spine, same row anatomy as context items. */
.dnd-push { list-style: none; padding: 0; margin: 0 0 4px; display: grid; gap: 8px; }
.dnd-push li {
  padding: 12px 16px; font-size: 15px; color: var(--ink-1); line-height: 1.7;
  background: color-mix(in oklch, var(--st-waiting) 7%, var(--surface-2));
  border: 1px solid var(--line-hair); border-left: 3px solid var(--st-waiting);
  border-radius: 10px;
}
```

Note: `dep` and `option` deliberately share the amber family — both mean "not settled by us alone"; the chip label carries the difference. Do not invent a new color.

- [ ] **Step 4: Verify**

Run: `npm run typecheck && npx vitest run`
Expected: PASS. (No D&D component tests exist; that's the repo's decision, don't add any.)

- [ ] **Step 5: Commit**

```bash
git add src/lib/api.ts src/components/DnDView.tsx src/styles/dashboard.css
git commit -m "feat(dnd): dep/mitigation chips, pushback card, agreed-per-part marks on Discovery review

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: Seed skills — focus, pushback, client step, agree-per-part, walkthrough follow-up

**Files:**
- Modify: `~/projects/github-moran/features/.claude/skills/discovery/SKILL.md` (SEED)
- Modify: `~/projects/github-moran/features/.claude/skills/walkthrough/SKILL.md` (SEED)

**Interfaces:**
- Consumes: Task 1's exact keys: tags `dep`/`mitigation`, fields `pushback`/`agreed`, agreement keys `problem`/`flow`/`lanes`/`pushback`/`openQuestions`/`group:<name>`.
- Produces: nothing for other tasks.

Seed files only — do NOT touch workspace or global skill copies. Prose edits, no tests; verification is re-reading the file for contradictions.

- [ ] **Step 1: Edit `discovery/SKILL.md`**

**(a)** Replace the opening paragraph (the one beginning `Discovery is the first work under a feature.`) with:

```markdown
Discovery is the first work under a feature. It is **fast because it is focused**:
cover only the MAIN gaps, risks, mitigations, and dependencies. Every line still
has to be exactly right — speed comes from writing less, never from checking less.
It does NOT pick sides or weigh trade-offs — that is the later Design phase.
```

**(b)** In `## The rules`, replace the `**High level only.**` bullet with:

```markdown
- **High level only, main things only.** Topics are one-liners, never blocks of
  detail. A few context groups covering the MAIN areas — if an area has no real
  gap, risk, or dependency, it gets NO group at all; silence means "nothing
  important there". Before writing any line, ask: *would this line change a
  decision in design?* If no — leave it out.
```

**(c)** In the JSON shape example, add after the `"fact", "option"` example item:

```json
        { "text": "waits on someone/something outside the team", "tags": ["dep"] },
        { "text": "the answer to the risk above", "tags": ["mitigation"] }
```

and add two top-level fields to the example, after `"openQuestions"`:

```json
  "pushback": ["one-liner: what we don't accept as-is, and why"],
  "agreed": ["problem", "flow", "group:<group name>", "lanes", "pushback", "openQuestions"]
```

**(d)** Update the field rules line listing allowed tags to:

```markdown
- Every item's `tags` may only contain: `diff`, `risk`, `fact`, `option`, `dep`,
  `mitigation`. Nothing else.
```

and add two rule bullets below it:

```markdown
- `pushback` is an array of one-liners: what we don't accept in the feature
  as written (see "Check the feature before you start"). Empty = accepted as-is.
- `agreed` is the agree-per-part record (see "Agree per part"). NEVER write a
  key into `agreed` without USER's explicit yes on that part.
```

**(e)** In the `## Fact vs diff vs risk` section, after the "Quick chain to remember" line, add:

```markdown
Two more tags complete the set:

- **dep** = the work waits on someone or something OUTSIDE the team — the
  platform team, another system, a license, an approval. Not a risk (nothing
  is lost yet) and not a fact (it can be chased). Tag it `dep` so it's visible.
- **mitigation** = the ANSWER to a risk, written as its own item right under
  that risk ("risk: double the ArgoCD apps → more cost" → "mitigation: start
  with one shared app, split later"). A risk with no mitigation is fine — it
  honestly means the answer isn't known yet. A mitigation with no nearby risk
  is a smell: what is it answering?
```

**(f)** Add a new section right after `## The rules`:

```markdown
## Check the feature before you start — what we don't accept as-is

The VERY FIRST step of a discovery, before any group is written: read the
feature's description and check two things:

1. **Too fat?** Does it bundle several unrelated things that should be
   separate features?
2. **Runbook?** Does it contain design instructions dressed as requirements —
   telling the team HOW to build instead of WHAT is needed?

Every finding becomes a one-liner in `pushback` ("what we don't accept
as-is"). Empty list = the feature is accepted as written. The list NEVER
blocks the discovery — it arms USER's talk with the product side, nothing
more. The dashboard shows it as its own card.
```

**(g)** Add a new section after the pushback section:

```markdown
## Client-facing or backend? — decide early

Early in the discovery, decide: is this feature something an end-client (for
this team, usually a developer) USES DIRECTLY — a command they run, a screen
they see? Or is it behind-the-scenes plumbing nobody touches?

- Can't tell → ask USER one plain question: "who uses this directly?"
- Record the answer as a normal `fact` item in a fitting context group
  (e.g. "used directly by developers via the CLI").
- **Client-facing** → once the concept demo is built, nudge USER once:
  "want to show this to the end-clients before design starts?" Their feedback
  comes back as a discovery meeting (see the meetings section) and folds in
  the normal way.
- **Backend** → at most suggest a quick opinion from a developer or team
  lead. Optional, never a step, never a nag.
```

**(h)** Add a new section right before `## When it's finished`:

```markdown
## Agree per part — never hand USER a finished wall

Build the discovery ONE PART at a time: the "accept as-is" check, the problem, the
flow, each context group, the lanes, the open questions. After drafting each
part:

1. **Explain it to USER in simple, non-academic English.** Simplify the
   WORDING, never the content — every detail stays, said plainly.
2. **Ask for USER's take and wait.** This is a conversation, not a broadcast.
3. Only when USER agrees, add that part's key to `agreed` and move on.
   Keys: `problem`, `flow`, `lanes`, `pushback`, `openQuestions`, and
   `group:<group name>` for each group.
4. If an already-agreed part changes later (an edit, a meeting finding folded
   in), REMOVE its key from `agreed` and re-walk that part with USER.

The story-close gate enforces coverage: a discovery cannot close while any
non-empty part is missing from `agreed`. Racing ahead and writing everything
alone just means walking it all back part by part at the end.
```

**(i)** In `## When it's finished`, replace the paragraph with:

```markdown
A discovery is finished when the file has a non-empty `flow`, at least one
group whose items include a `diff`, a `risk`, and a `fact` or `option`, AND
every non-empty part is listed in `agreed`. The discovery story on the board
will not close until all of that holds.
```

- [ ] **Step 2: Edit `walkthrough/SKILL.md`**

**(a)** In `## What each slide holds`, insert a new list entry after `2. **What we're solving**` (renumber the rest):

```markdown
3. **What we don't accept as-is** — the `pushback` list, one line per item.
   ONLY when the list is non-empty; skip the slide otherwise. It sits early
   because it frames the product conversation.
```

**(b)** In the functional-color line of the palette section, extend the meanings to:

```markdown
- Functional color, same meanings as the concept demo AND the dashboard — a
  color always says the same thing everywhere: teal/blue = the idea/happy
  path, green = success, mitigations, and the closing summary, amber =
  today/debate/open questions/dependencies (`dep`), red = risks and removed
  things, violet = accent flourish. Never recolor by taste.
```

**(c)** In the `**Map the discovery onto these:**` paragraph, replace `tag the context-group items with the chips (diff / risk stand out; fact / option quieter)` with:

```markdown
tag the context-group items with the chips (diff / risk / dep stand out;
fact / option quieter; mitigation green, paired under its risk)
```

- [ ] **Step 3: Self-check + commit if the seed folder is a git repo**

Re-read both edited files top to bottom: no contradictions with the untouched text (e.g. nothing still claims "fast but not fast-and-dirty", the finished-rule matches (i), the JSON example parses as valid JSON).

```bash
git -C ~/projects/github-moran/features rev-parse --git-dir >/dev/null 2>&1 \
  && git -C ~/projects/github-moran/features add .claude/skills/discovery/SKILL.md .claude/skills/walkthrough/SKILL.md \
  && git -C ~/projects/github-moran/features commit -m "skills: discovery tune-up — focus, dep/mitigation, pushback, client step, agree-per-part" \
  || echo "seed folder is not a git repo — no commit needed"
```

---

## Final QA (controller, after all tasks)

- `npm run typecheck && npx vitest run && npm run build` — all green.
- Headless-Chrome smoke against the live dev server (see memory: UI smoke trick) on the CD feature's Review tab: new cards render, nothing crashes on the OLD doc (no `pushback`/`agreed` — every part should read "not agreed yet" only where content exists).
- Remind USER: run `skills_sync` in a connected chat (seed is ahead again), and the next discovery will run the new flow.
