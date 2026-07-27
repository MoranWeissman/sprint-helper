# Discovery Meetings Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Dated discovery-meeting summaries stored as markdown files in the feature's `discovery/meetings/` folder and shown in a new Meetings sub-tab under Discovery, with the managed `discovery` skill teaching chats to write them.

**Architecture:** Pure listing/parsing helpers join the existing artifact helpers in `server/discovery-store.ts`; the existing `/api/discovery/<id>` doc route ships the meetings in its payload (no new request); `DnDView.tsx` grows a fourth sub-tab whose cards reuse the Overview description's block renderer; the seed `discovery` skill gains the meeting-writing flow.

**Tech Stack:** TypeScript, Vitest, Vite middleware routes (vite.config.ts), React (no new deps).

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-27-discovery-meetings-design.md`.
- Meetings dir: `<feature folder>/discovery/meetings/`, files `YYYY-MM-DD.md` (same-day extra meetings: `YYYY-MM-DD-<slug>.md`).
- Payload shape (exact): `meetings: Array<{ file: string; date: string; title: string; body: string }>`, sorted by filename DESCENDING.
- A file without a date prefix is still listed, `date: ''` — never silently dropped. Missing folder → `[]`, never an error.
- `body` ships raw markdown with `#`-headings normalized to `**bold**` lines; NO HTML strings in the payload, no `dangerouslySetInnerHTML` anywhere.
- Sub-tab order: Review · Meetings · Walkthrough · Demo. Feature-switch still resets to Review. URL value: `?sub=meetings`.
- Plain-English UI copy; no agile jargon. Empty state text (exact): `No meeting summaries yet. Tell your work chat about a discovery meeting and it will land here.`
- Dashboard style: calm, existing `dnd-*` classes/tokens; no new colors, no pulsing.
- Managed-skill edits happen at the SEED (`~/projects/github-moran/features/.claude/skills/discovery/SKILL.md`) ONLY — never hand-copy to other locations; `skills_sync` fans them out (Moran runs it after his MCP reload).
- Vite middleware routes and UI are user-smoked; only pure helpers get unit tests (project convention).
- Verification commands: `npx vitest run server/discovery-store.test.ts`, `npm run typecheck`, `npm test`, `npm run build`.

---

### Task 1: meetings helpers in `server/discovery-store.ts`

**Files:**
- Modify: `server/discovery-store.ts` (append after `hasHtmlArtifact`, ~line 36)
- Test: `server/discovery-store.test.ts` (append; the file exists with mkdtemp temp-dir style)

**Interfaces:**
- Consumes: existing `DISCOVERY_DIR` constant in the same file; `node:fs` functions already imported there (`readFileSync`, `existsSync`) plus `readdirSync` (add to the import).
- Produces (Tasks 2–3 rely on these exact names):
  - `MEETINGS_DIR = 'meetings'`
  - `interface DiscoveryMeeting { file: string; date: string; title: string; body: string }`
  - `listMeetings(featureFolderPath: string): DiscoveryMeeting[]`

- [ ] **Step 1: Write the failing tests**

Append to `server/discovery-store.test.ts` (inside the file, as a new top-level describe; the imports line at the top gains `listMeetings, MEETINGS_DIR`):

```ts
describe('listMeetings', () => {
  const meetingsDir = () => join(dir, DISCOVERY_DIR, MEETINGS_DIR);
  const addMeeting = (name: string, content: string) => {
    mkdirSync(meetingsDir(), { recursive: true });
    writeFileSync(join(meetingsDir(), name), content);
  };

  it('returns [] when the meetings folder does not exist', () => {
    expect(listMeetings(dir)).toEqual([]);
  });

  it('lists meetings newest first by filename', () => {
    addMeeting('2026-07-20.md', '# Kickoff\nFirst talk.');
    addMeeting('2026-07-27.md', '# Platform team\nSecond talk.');
    const out = listMeetings(dir);
    expect(out.map(m => m.file)).toEqual(['2026-07-27.md', '2026-07-20.md']);
  });

  it('extracts title from the first # heading and body without it', () => {
    addMeeting('2026-07-27.md', '# Platform team — deploy flow\n\nWe agreed on X.\n');
    const [m] = listMeetings(dir);
    expect(m.title).toBe('Platform team — deploy flow');
    expect(m.body).toBe('We agreed on X.');
    expect(m.date).toBe('2026-07-27');
  });

  it('falls back to the filename when there is no # heading', () => {
    addMeeting('2026-07-27-sync.md', 'Just notes, no heading.');
    const [m] = listMeetings(dir);
    expect(m.title).toBe('2026-07-27-sync');
    expect(m.body).toBe('Just notes, no heading.');
    expect(m.date).toBe('2026-07-27');
  });

  it('keeps a file without a date prefix, with empty date', () => {
    addMeeting('notes.md', '# Old notes\nBody.');
    const [m] = listMeetings(dir);
    expect(m.file).toBe('notes.md');
    expect(m.date).toBe('');
    expect(m.title).toBe('Old notes');
  });

  it('normalizes ##/### sub-headings in the body to the house **bold** lines', () => {
    addMeeting('2026-07-27.md', '# Title\n\n## Decisions\n- moved to argocd\n### Details\ntext');
    const [m] = listMeetings(dir);
    expect(m.body).toBe('**Decisions**\n- moved to argocd\n**Details**\ntext');
  });

  it('ignores non-md files and subdirectories', () => {
    addMeeting('2026-07-27.md', '# Real\nBody.');
    writeFileSync(join(meetingsDir(), 'image.png'), 'binary');
    mkdirSync(join(meetingsDir(), 'drafts'), { recursive: true });
    expect(listMeetings(dir).map(m => m.file)).toEqual(['2026-07-27.md']);
  });

  it('never throws on an unreadable folder path', () => {
    expect(listMeetings(join(dir, 'no-such-feature'))).toEqual([]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run server/discovery-store.test.ts`
Expected: FAIL — `listMeetings` / `MEETINGS_DIR` are not exported.

- [ ] **Step 3: Write minimal implementation**

In `server/discovery-store.ts`: add `readdirSync` to the `node:fs` import, then append after `hasHtmlArtifact` (~line 36):

```ts
/** Discovery-meeting summaries live under `discovery/meetings/`, one dated
 *  markdown file per meeting (`YYYY-MM-DD.md`, extra same-day meetings get a
 *  slug suffix). Chat-written, human-readable, never overwritten — the record
 *  of what each discovery meeting said. */
export const MEETINGS_DIR = 'meetings';

export interface DiscoveryMeeting {
  file: string;
  /** The filename's YYYY-MM-DD prefix; '' when the name has none. */
  date: string;
  /** First `# ` heading's text; the filename (no extension) when absent. */
  title: string;
  /** Raw markdown after the title line; `#`-headings normalized to the house
   *  `**bold**` header lines so the dashboard's existing block renderer shows
   *  them as collapsible sections. */
  body: string;
}

/** List a feature's meeting summaries, newest first (filename descending —
 *  the date prefix makes that chronological). Missing folder → []. Never throws. */
export function listMeetings(featureFolderPath: string): DiscoveryMeeting[] {
  const dir = join(featureFolderPath, DISCOVERY_DIR, MEETINGS_DIR);
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter(e => e.isFile() && e.name.endsWith('.md'))
      .map(e => e.name)
      .sort()
      .reverse()
      .map(file => {
        const raw = readFileSync(join(dir, file), 'utf8');
        const lines = raw.split('\n');
        const headIdx = lines.findIndex(l => /^#\s+\S/.test(l.trim()));
        const title =
          headIdx >= 0 ? lines[headIdx].trim().replace(/^#\s+/, '') : file.replace(/\.md$/, '');
        const bodyLines = headIdx >= 0 ? lines.slice(headIdx + 1) : lines;
        const body = bodyLines
          .map(l => {
            const h = l.trim().match(/^#{1,3}\s+(.+)$/);
            return h ? `**${h[1]}**` : l;
          })
          .join('\n')
          .trim();
        const date = /^(\d{4}-\d{2}-\d{2})/.exec(file)?.[1] ?? '';
        return { file, date, title, body };
      });
  } catch {
    return []; // missing folder or unreadable entry — an empty list, never an error
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run server/discovery-store.test.ts`
Expected: PASS (all, including the pre-existing tests in the file).

- [ ] **Step 5: Commit**

```bash
git add server/discovery-store.ts server/discovery-store.test.ts
git commit -m "feat(discovery): listMeetings helper — dated meeting summaries from discovery/meetings/"
```

---

### Task 2: doc route + payload type carry the meetings

**Files:**
- Modify: `vite.config.ts` (the `/api/discovery` middleware: the dynamic-import line ~434 and the DOC branch ~495–505)
- Modify: `src/lib/api.ts` (the `DiscoveryDocPayload` interface, ~line 269)

**Interfaces:**
- Consumes: Task 1's `listMeetings` (exact name).
- Produces: `DiscoveryDocPayload.meetings: ApiDiscoveryMeeting[]` and `interface ApiDiscoveryMeeting { file: string; date: string; title: string; body: string }` — Task 3's UI consumes both names exactly.

- [ ] **Step 1: Add `listMeetings` to the route's dynamic import**

In `vite.config.ts` ~line 434, extend the existing import line:

```ts
          const { discoveryStatus, readDiscoveryDoc, writeDiscoveryDoc, hasHtmlArtifact, htmlArtifactPath, listMeetings } = await import('./server/discovery-store');
```

- [ ] **Step 2: Ship meetings on the DOC branch**

In the DOC branch (the `if (!action)` block, ~line 495), extend the response object:

```ts
            res.end(JSON.stringify({
              folderPath,
              doc: readDiscoveryDoc(folderPath),
              hasWalkthrough: hasHtmlArtifact(folderPath, 'walkthrough'),
              hasDemoHtml: hasHtmlArtifact(folderPath, 'demo'),
              meetings: listMeetings(folderPath),
            }));
```

- [ ] **Step 3: Extend the payload interface**

In `src/lib/api.ts`, directly above `DiscoveryDocPayload` (~line 268), add:

```ts
/** One discovery-meeting summary (a dated markdown file the chat wrote). */
export interface ApiDiscoveryMeeting {
  file: string;
  /** YYYY-MM-DD from the filename; '' when the name has no date prefix. */
  date: string;
  title: string;
  /** Markdown body; headings pre-normalized to the house **bold** lines. */
  body: string;
}
```

and inside `DiscoveryDocPayload`, after `hasDemoHtml: boolean;`:

```ts
  /** Meeting summaries from discovery/meetings/, newest first. */
  meetings: ApiDiscoveryMeeting[];
```

- [ ] **Step 4: Verify typecheck**

Run: `npm run typecheck`
Expected: clean. (If `DnDView.tsx` or a test constructs a `DiscoveryDocPayload` literal, the new required field will error — fix by adding `meetings: []` to that literal; that is the only acceptable touch outside the two files.)

- [ ] **Step 5: Smoke the route**

Run (with `npm run dev` running in another terminal — ask the controller if unsure whether it is):

```bash
curl -s "http://localhost:5173/api/discovery" | head -c 300; echo
```

Pick a feature id from that output, then:

```bash
curl -s "http://localhost:5173/api/discovery/<id>" | python3 -m json.tool | grep -A2 meetings
```

Expected: a `"meetings": []` array (or entries, if that feature has files). If the dev server isn't running, note the smoke as pending-with-Task-3's smoke instead of blocking.

- [ ] **Step 6: Commit**

```bash
git add vite.config.ts src/lib/api.ts
git commit -m "feat(discovery): doc route + payload ship meeting summaries"
```

---

### Task 3: Meetings sub-tab in the dashboard

**Files:**
- Modify: `src/components/DnDView.tsx` (sub-tab type ~line 15, `DISCOVERY_SUBS` ~line 142, `DiscoverySubBar` tabs ~line 550, `DiscoveryFacet` body ~line 585; new `MeetingsFacet` component near `DiscoveryReview`)
- Modify: `src/styles/dashboard.css` (small additions at the end of the D&D block)

**Interfaces:**
- Consumes: Task 2's `ApiDiscoveryMeeting` + `payload.meetings`; existing `renderDescription(text)` helper (already in `DnDView.tsx`, renders paragraphs/bullets/`**bold**` sections); existing CSS classes `dnd-group`, `dnd-group-sum`, `dnd-group-chev`, `dnd-group-name`, `dnd-ov-body`, `dnd-artifact-empty`.
- Produces: the `meetings` sub-tab value in URLs (`?sub=meetings`).

- [ ] **Step 1: Widen the sub-tab type and list**

```ts
type DiscoverySub = 'review' | 'meetings' | 'walkthrough' | 'demo';
```

```ts
const DISCOVERY_SUBS: DiscoverySub[] = ['review', 'meetings', 'walkthrough', 'demo'];
```

(The `readUrlState` fallback-to-`'review'` logic and the feature-switch `setSub('review')` need NO change — verify, don't edit.)

- [ ] **Step 2: Add the tab, second in the strip**

In `DiscoverySubBar`'s `tabs` array:

```ts
  const tabs: { id: DiscoverySub; label: string; hint?: string }[] = [
    { id: 'review', label: 'Review' },
    { id: 'meetings', label: 'Meetings', hint: meetingCount > 0 ? String(meetingCount) : undefined },
    { id: 'walkthrough', label: 'Walkthrough' },
    { id: 'demo', label: 'Demo', hint: demoStatus === 'none' ? undefined : demoStatus },
  ];
```

Add `meetingCount: number` to `DiscoverySubBar`'s props (destructure it with the others); in `DiscoveryFacet` pass `meetingCount={payload.meetings.length}`.

- [ ] **Step 3: Add the `MeetingsFacet` component**

Place it next to the other facet components (after `DiscoveryReview`), consuming the existing `renderDescription`:

```tsx
/** The Meetings sub-tab: one collapsible card per discovery meeting, newest
 *  first, in the Review cards' style. The files on disk are the record; the
 *  dashboard only shows them. */
function MeetingsFacet(props: { meetings: ApiDiscoveryMeeting[] }): JSX.Element {
  const { meetings } = props;
  if (meetings.length === 0) {
    return (
      <p className="dnd-artifact-empty">
        No meeting summaries yet. Tell your work chat about a discovery meeting and it will land here.
      </p>
    );
  }
  return (
    <div className="dnd-meetings">
      {meetings.map(m => (
        <details key={m.file} className="dnd-group">
          <summary className="dnd-group-sum">
            <span className="dnd-group-chev" aria-hidden="true" />
            {m.date && <span className="dnd-meeting-date">{m.date}</span>}
            <span className="dnd-group-name">{m.title}</span>
          </summary>
          <div className="dnd-ov-body">{renderDescription(m.body)}</div>
        </details>
      ))}
    </div>
  );
}
```

Import `ApiDiscoveryMeeting` from `../lib/api` alongside the existing payload imports.

- [ ] **Step 4: Route the sub-tab in `DiscoveryFacet`**

After the `sub === 'review'` line:

```tsx
      {sub === 'meetings' && <MeetingsFacet meetings={payload.meetings} />}
```

- [ ] **Step 5: CSS for the date chip and list spacing**

Append to the D&D block in `src/styles/dashboard.css` (near the other `dnd-group` rules):

```css
/* ---- Meetings sub-tab ---- */
.dnd-meetings { display: flex; flex-direction: column; gap: 10px; padding-top: 4px; }
.dnd-meeting-date {
  font-family: var(--font-mono, ui-monospace, monospace);
  font-size: 12px; color: var(--ink-3);
  background: var(--bg-1); border: 1px solid var(--line-hair);
  border-radius: 6px; padding: 2px 7px; margin-right: 10px; flex: none;
}
```

- [ ] **Step 6: Verify typecheck + build + full suite**

Run: `npm run typecheck && npm run build && npm test`
Expected: all clean/green.

- [ ] **Step 7: Commit**

```bash
git add src/components/DnDView.tsx src/styles/dashboard.css
git commit -m "feat(dnd): Meetings sub-tab — dated meeting summaries as collapsible cards"
```

- [ ] **Step 8: USER SMOKE (route + UI together, per project convention)**

Ask the user to, in the running dashboard:
1. Open a feature's Discovery → the strip reads Review · Meetings · Walkthrough · Demo.
2. Meetings tab with no files → the exact empty-state line.
3. Drop a test file `discovery/meetings/2026-07-27.md` (`# Test meeting` + a few lines) into a feature's folder, refresh → a card appears, opens, renders the lines.
4. Refresh on `?sub=meetings` → still on Meetings; switch features → lands on Review.

---

### Task 4: teach the managed `discovery` skill the meeting flow

**Files:**
- Modify: `/Users/weissmmo/projects/github-moran/features/.claude/skills/discovery/SKILL.md` (the SEED copy — the ONLY copy to touch; `skills_sync` fans it out later)

**Interfaces:**
- Consumes: nothing from this repo (prose only).
- Produces: nothing code-level. NOT committed to this repo (the seed lives outside it) — the task's deliverable is the seed file's new section.

- [ ] **Step 1: Insert the section**

In the seed file, insert this section immediately BEFORE the line `## Every line must be exactly right — name the precise milestone`:

```markdown
## Discovery meetings — write the record, then offer the findings

When the user says he had a discovery meeting (any phrasing) and tells you
what was discussed, do two things in this order:

1. **Write the record.** Create `discovery/meetings/<YYYY-MM-DD>.md` in the
   feature's folder (create the folder if absent; today's date; if a file for
   the date exists, add a short slug: `<YYYY-MM-DD>-<slug>.md`). First line is
   `# <short title>` naming who/what it was ("Platform team — deploy flow"),
   then the summary: plain English, short sentences, what was said and agreed,
   who raised what, what stayed open. Record the MEETING — no tool talk, no
   file paths. `##` sub-headings are fine for topics. Never rewrite an
   existing meeting file; each meeting is its own file, a record.

2. **Then offer the findings.** Read your own summary against the current
   discovery and offer, in one plain line, what it adds — e.g. "I see 2 new
   risks and 1 answered question here — fold them into the discovery?" Only
   on a yes do you update `discovery.json` (tag items as usual). No yes, no
   change. The meeting file stays as-written either way.

The dashboard shows these files under Discovery → **Meetings**, newest first.
```

- [ ] **Step 2: Verify placement and the untouched copies**

Run:

```bash
grep -n "## Discovery meetings" ~/projects/github-moran/features/.claude/skills/discovery/SKILL.md
md5 -q ~/projects/github-moran/features/.claude/skills/discovery/SKILL.md ~/.claude/skills/sprint-helper-plus/skills/discovery/SKILL.md
```

Expected: the heading appears once, before the "Every line must be exactly right" section; the two checksums DIFFER (the seed changed, the global copy did not — that drift is intentional; `skills_sync` resolves it when the user runs it after his MCP reload). Do NOT copy the file anywhere.

- [ ] **Step 3: No commit**

The seed lives outside this repo. Note in the execution report that the seed was edited and the copies intentionally left for `skills_sync`.

---

## Self-Review

**1. Spec coverage:**
- Dated files in `discovery/meetings/`, `#` title line, same-day slug → Task 1 helper + Task 4 skill text. ✓
- History, never overwritten → Task 4 ("never rewrite an existing meeting file"). ✓
- Payload `{file,date,title,body}` newest-first, no-date fallback, missing folder → [] → Task 1 (impl + tests). ✓
- No new request; rides the doc route → Task 2 Step 2. ✓
- Heading normalization to `**bold**`, no HTML shipped, no dangerouslySetInnerHTML → Task 1 impl; Task 3 uses `renderDescription`. ✓
- Sub-tab strip order + `?sub=meetings` + reset-to-Review intact → Task 3 Steps 1–2 (+ explicit verify-don't-edit note). ✓
- Review-style collapsible cards, closed by default; exact empty-state line → Task 3 Step 3. ✓
- Skill flow: record first, offer-before-folding; seed-only edit; skills_sync fans out → Task 4. ✓
- Testing split per convention; user-smoke list → Task 1 tests; Task 3 Step 8. ✓
- Out-of-scope items: nothing in this plan builds a meeting HTML artifact, dashboard editing, or ADO calls. ✓

**2. Placeholder scan:** none — all code, copy, and commands are explicit.

**3. Type consistency:** `DiscoveryMeeting` (server) and `ApiDiscoveryMeeting` (client) carry identical fields `{file,date,title,body}`; `listMeetings(featureFolderPath)` name matches Task 2's import; `meetings` field name identical in route response, payload interface, and `DiscoveryFacet`/`MeetingsFacet` usage; `DiscoverySub` value `'meetings'` matches the URL string and the tabs array. ✓
