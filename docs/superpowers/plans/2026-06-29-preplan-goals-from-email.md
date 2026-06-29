# Pre-plan Goals From Email Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the assistant read the PM's goals email in chat and set owner-aware goals onto the current sprint's pre-plan record, with the page showing them read-only and flagging the user's own.

**Architecture:** A pre-plan goal stops being a bare string and becomes a record `{ text, owner, isMine }`. `getPrePlanState` migrates legacy `string[]` on read. A new MCP tool `preplan_set_goals` lets the assistant replace the current sprint's goals (resolving the sprint server-side, local-only). The page's goals box turns read-only and owner-aware, with an instruction line pointing at the chat flow.

**Tech Stack:** TypeScript, `@modelcontextprotocol/sdk` + zod, Vite + React 18, Vitest 4 (`vitest run`). No new dependencies. No Azure DevOps writes.

## Global Constraints

- **Local only.** Nothing on the Pre-plan page or in `preplan_set_goals` writes to Azure DevOps.
- **A goal is `{ text: string; owner: string | null; isMine: boolean }`** — `PrePlanGoal`. `PrePlanState.goals` and the payload's `goals` become `PrePlanGoal[]`.
- **Story links stay index-based** (`goalIndex: number | null` against the goals array) — do NOT change to id-based.
- **Legacy migration on read:** a `string` goal element becomes `{ text: <string>, owner: null, isMine: false }`. No DB migration — normalize in `getPrePlanState`.
- **`preplan_set_goals` REPLACES** the current sprint's goals (a "set", not "append"); resolves the current sprint name SERVER-SIDE (never trust an agent-passed sprint); preserves per-story `goalIndex` links that still point at a valid index, resets links ≥ new length to null.
- **The goals box becomes READ-ONLY display** — the chat is the single way to set goals. The page stops sending `goals` on the `/api/preplan` POST.
- **Plain English** in all UI copy and the tool/instruction text. No jargon ("slack", "burndown", "WIP", "scope" noun, "velocity", "work item").
- **No small-and-gray** for the owner / "mine" markers (never ≤11px combined with the faintest ink).
- Repo convention: pure logic in `server/*.ts` is unit-tested; MCP-handler + vite + React glue are not (user smokes). Commit per task; `npm test` + `npx tsc -b` green before each commit.
- Reload: server/page changes need a **dashboard restart**; the new tool + instructions need an **MCP reload** (`/exit` + `claude --resume`).

## Type definitions (shared vocabulary — defined in Task 1, used throughout)

```ts
// server/preplan.ts
export interface PrePlanGoal {
  text: string;          // the goal itself
  owner: string | null;  // from the email's Owner column; null when none
  isMine: boolean;       // decided by the assistant (story-first, owner-name fallback)
}
// PrePlanState.goals: PrePlanGoal[]   (was string[])
// PrePlanPayload.goals: PrePlanGoal[] (was string[])
```

---

### Task 1: `PrePlanGoal` type + legacy-safe state read + text-consumer switch

Introduce the goal record, migrate `getPrePlanState` to normalize old `string[]` goals, and switch the two text consumers (`suggestGoalIndex`, `summarizeCoverage`) and `buildPrePlanPayload` to read `goal.text`. This is the data-model heart; do it first so everything downstream sees records.

**Files:**
- Modify: `server/preplan.ts`
- Modify: `server/preplan.test.ts`

**Interfaces:**
- Produces: `PrePlanGoal` (type above); `PrePlanState.goals: PrePlanGoal[]`; `PrePlanPayload.goals: PrePlanGoal[]`.
- Produces: `normalizeGoals(raw: unknown): PrePlanGoal[]` — turns a stored `string[]` OR `PrePlanGoal[]` (or junk) into `PrePlanGoal[]`. Exported for test.
- Changes: `suggestGoalIndex(storyTitle: string, goals: PrePlanGoal[]): number | null` and `summarizeCoverage(cards, goals: PrePlanGoal[])` now take goal records (read `.text`).
- Consumes: existing `getSetting`/`setSetting`, `buildDashboardCached`.

- [ ] **Step 1: Write the failing test**

Add to `server/preplan.test.ts`:

```ts
import { normalizeGoals, type PrePlanGoal } from './preplan';

describe('normalizeGoals (legacy migration)', () => {
  it('turns a legacy string[] into goal records (owner null, isMine false)', () => {
    expect(normalizeGoals(['Ship X', 'Finish Y'])).toEqual([
      { text: 'Ship X', owner: null, isMine: false },
      { text: 'Finish Y', owner: null, isMine: false },
    ]);
  });
  it('passes through proper goal records', () => {
    const recs: PrePlanGoal[] = [{ text: 'A', owner: 'Gleb', isMine: false }];
    expect(normalizeGoals(recs)).toEqual(recs);
  });
  it('fills missing owner/isMine on partial records', () => {
    expect(normalizeGoals([{ text: 'A' }])).toEqual([{ text: 'A', owner: null, isMine: false }]);
  });
  it('returns [] for non-arrays and drops empty/blank text', () => {
    expect(normalizeGoals(undefined)).toEqual([]);
    expect(normalizeGoals([{ owner: 'x' }, '', '  '])).toEqual([]);
  });
});
```

Also UPDATE the existing `suggestGoalIndex` / `summarizeCoverage` tests so they pass goal **records** instead of bare strings. Find the existing describe blocks for those two and change their `goals` arguments from `['Goal A', ...]` to `[{ text: 'Goal A', owner: null, isMine: false }, ...]`. Keep the same expectations (index results don't change). For `summarizeCoverage`, the returned `text` field still equals the goal's text — assert `text: 'Goal A'` etc. (the coverage output stays `{ index, text, storyCount }`, text pulled from `goal.text`).

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run server/preplan.test.ts`
Expected: FAIL — `normalizeGoals` not exported; and the updated suggest/coverage tests fail to typecheck/run against the old `string[]` signatures.

- [ ] **Step 3: Add the type + normalizer**

In `server/preplan.ts`, add the `PrePlanGoal` interface right above `PrePlanCard` (after line 13):

```ts
export interface PrePlanGoal {
  text: string;
  owner: string | null;
  isMine: boolean;
}
```

Change `PrePlanPayload.goals` (line 40) and `PrePlanState.goals` (line 47) from `string[]` to `PrePlanGoal[]`.

Add the normalizer near the state helpers (above `getPrePlanState`):

```ts
/**
 * Coerce stored goals into PrePlanGoal[]. Accepts the legacy `string[]` shape
 * (each string → {text, owner:null, isMine:false}) and partial/!full records.
 * Drops entries with empty text. Anything not an array → [].
 */
export function normalizeGoals(raw: unknown): PrePlanGoal[] {
  if (!Array.isArray(raw)) return [];
  const out: PrePlanGoal[] = [];
  for (const g of raw) {
    if (typeof g === 'string') {
      const text = g.trim();
      if (text) out.push({ text, owner: null, isMine: false });
    } else if (g && typeof g === 'object' && typeof (g as { text?: unknown }).text === 'string') {
      const text = (g as { text: string }).text.trim();
      if (!text) continue;
      const owner = (g as { owner?: unknown }).owner;
      out.push({
        text,
        owner: typeof owner === 'string' && owner.trim() ? owner.trim() : null,
        isMine: (g as { isMine?: unknown }).isMine === true,
      });
    }
  }
  return out;
}
```

- [ ] **Step 4: Wire the normalizer into `getPrePlanState`**

In `getPrePlanState`, replace the `goals:` line in the returned object:

```ts
    return {
      goals: normalizeGoals(parsed.goals),
      stories: parsed.stories && typeof parsed.stories === 'object' ? parsed.stories : {},
    };
```

- [ ] **Step 5: Switch the text consumers to read `goal.text`**

In `suggestGoalIndex`, change the signature to `goals: PrePlanGoal[]` and tokenize `g.text`:

```ts
export function suggestGoalIndex(storyTitle: string, goals: PrePlanGoal[]): number | null {
  if (goals.length === 0) return null;
  const titleTokens = tokenize(storyTitle);
  if (titleTokens.size === 0) return null;
  let bestIdx = -1;
  let bestOverlap = 0;
  goals.forEach((g, i) => {
    const gTokens = tokenize(g.text);
    let overlap = 0;
    for (const t of gTokens) if (titleTokens.has(t)) overlap++;
    if (overlap > bestOverlap) {
      bestOverlap = overlap;
      bestIdx = i;
    }
  });
  return bestOverlap >= 2 ? bestIdx : null;
}
```

In `summarizeCoverage`, change `goals: PrePlanGoal[]` and read `.text`:

```ts
export function summarizeCoverage(
  cards: Array<{ goalIndex: number | null }>,
  goals: PrePlanGoal[],
): PrePlanCoverageGoal[] {
  return goals.map((g, index) => ({
    index,
    text: g.text,
    storyCount: cards.filter(c => c.goalIndex === index).length,
  }));
}
```

`buildPrePlanPayload` already passes `state.goals` to both and returns `goals: state.goals` — no change needed there beyond the types flowing through. `buildCards` calls `suggestGoalIndex(s.title, state.goals)` — now passes records, which is correct.

- [ ] **Step 6: Run tests + typecheck**

Run: `npx vitest run server/preplan.test.ts && npx tsc -b`
Expected: preplan tests PASS (new normalize block + updated suggest/coverage); `tsc -b` exit 0. (Note: `src/lib/api.ts` + `PrePlanView.tsx` still type `goals` as `string[]` — they're fixed in Tasks 3 & 4. `tsc -b` here covers the server project; if the repo's `tsc -b` also builds the client and errors on the not-yet-updated client types, that is EXPECTED and resolved in Task 3/4. If so, note it and proceed — do not "fix" the client here.)

> Reality check on build coupling: if `npx tsc -b` fails ONLY due to client files reading `payload.goals` as `string[]`, that's the cross-task seam. Confirm the failures are exclusively that, commit the server change, and let Task 3 close the client side. If you can run just the server typecheck (e.g. `npx tsc -p tsconfig.json` for the server project), prefer that for a clean Task-1 gate.

- [ ] **Step 7: Commit**

```bash
git add server/preplan.ts server/preplan.test.ts
git commit -m "feat(preplan): goals become {text,owner,isMine} records with legacy migration"
```

---

### Task 2: `preplan_set_goals` MCP tool + a tested merge helper

Add the tool the assistant calls after reading the email. Extract the goal-replacement merge (with link-resetting) into a pure, tested helper; the tool handler is thin glue.

**Files:**
- Modify: `server/preplan.ts` (add pure `setGoals` merge helper)
- Modify: `server/preplan.test.ts` (test the merge)
- Modify: `mcp/server.ts` (import + register `preplan_set_goals`)

**Interfaces:**
- Produces: `setGoals(state: PrePlanState, goals: PrePlanGoal[]): PrePlanState` — returns a new state with `goals` replaced and per-story `goalIndex` links reset to null when they point at an index ≥ the new goals length (out of range). Pure; exported for test.
- Consumes (tool): `buildPrePlanPayload` (to resolve current sprint name), `getPrePlanState`, `savePrePlanState`, `setGoals`, `normalizeGoals`.

- [ ] **Step 1: Write the failing test for `setGoals`**

Add to `server/preplan.test.ts`:

```ts
import { setGoals } from './preplan';

describe('setGoals (replace + link safety)', () => {
  const base = {
    goals: [{ text: 'old', owner: null, isMine: false }],
    stories: {
      '1': { call: 'on-track' as const, goalIndex: 0 },
      '2': { call: 'at-risk' as const, goalIndex: 2 }, // points past a shorter new list
      '3': { call: 'on-track' as const, goalIndex: null },
    },
  };
  it('replaces goals and keeps in-range links, resets out-of-range to null', () => {
    const next = setGoals(base, [
      { text: 'g0', owner: 'Gleb', isMine: false },
      { text: 'g1', owner: 'Moran', isMine: true },
    ]);
    expect(next.goals).toHaveLength(2);
    expect(next.stories['1'].goalIndex).toBe(0);   // 0 < 2 → kept
    expect(next.stories['2'].goalIndex).toBeNull(); // 2 >= 2 → reset
    expect(next.stories['3'].goalIndex).toBeNull(); // already null
    expect(next.stories['1'].call).toBe('on-track'); // calls untouched
  });
  it('resets all links when goals cleared', () => {
    const next = setGoals(base, []);
    expect(next.goals).toEqual([]);
    expect(next.stories['1'].goalIndex).toBeNull();
  });
  it('does not mutate the input state', () => {
    const snapshot = JSON.stringify(base);
    setGoals(base, []);
    expect(JSON.stringify(base)).toBe(snapshot);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run server/preplan.test.ts`
Expected: FAIL — `setGoals` not exported.

- [ ] **Step 3: Implement `setGoals`**

In `server/preplan.ts`, add below `savePrePlanState`:

```ts
/**
 * Replace a sprint's goals. Per-story call choices are untouched; a story's
 * goalIndex link is kept when it still points at a valid goal, else reset to
 * null (the goal set was replaced, so stale links drop). Pure — returns a new
 * state, does not mutate the input.
 */
export function setGoals(state: PrePlanState, goals: PrePlanGoal[]): PrePlanState {
  const stories: PrePlanState['stories'] = {};
  for (const [id, s] of Object.entries(state.stories)) {
    const keep = s.goalIndex != null && s.goalIndex < goals.length;
    stories[id] = { call: s.call, goalIndex: keep ? s.goalIndex : null };
  }
  return { goals, stories };
}
```

- [ ] **Step 4: Run the `setGoals` test**

Run: `npx vitest run server/preplan.test.ts`
Expected: PASS (the new setGoals block + everything from Task 1).

- [ ] **Step 5: Register the MCP tool**

In `mcp/server.ts`, add the import near the other `../server/*` imports (match the existing style — e.g. alongside `import { findGaps } from '../server/planning.js';`):

```ts
import { buildPrePlanPayload, getPrePlanState, savePrePlanState, setGoals, normalizeGoals } from '../server/preplan.js';
```

> Implementer: confirm the exact extension/path convention used by neighbouring `../server/*` imports in this file (`.js`) and match it.

Then register the tool next to the other sprint-wide tools (e.g. just after the `planning_gaps` registration, ~line 1849+). Use the file's existing `jsonResult` / `errorResult` helpers:

```ts
server.registerTool(
  'preplan_set_goals',
  {
    title: 'Set the pre-plan goals from the PM email',
    description:
      "Set the sprint goals on Moran's PRIVATE pre-plan page (local only — never writes to Azure DevOps). Use this when Moran pastes the delivery manager's goals email (or says 'set my goals'). BEFORE calling: (1) confirm the email's sprint matches the current sprint — if it names a different sprint, ask Moran rather than mis-filing; (2) take ONLY the current-sprint goal rows — drop the table header row ('Goal'/'Status'/'Owner'), drop owner-name-only lines, and IGNORE any previous-sprint 'Is Achieved' table; (3) for each goal capture its `text` and `owner` (from the Owner column; null if none); (4) set `isMine`: a goal is Moran's if it lines up with one of HIS stories in the current sprint (check via sprint_snapshot / list_my_work_items) — if no story of his matches, fall back to whether the owner name is Moran (you know his name). This REPLACES the whole goal set for the current sprint each call, so always pass the full cleaned list. Returns how many were saved and the sprint name. After saving, tell Moran it's set and remind him to refresh the Pre-plan page.",
    inputSchema: {
      goals: z
        .array(
          z.object({
            text: z.string().min(1).describe('The goal itself, e.g. "GitOps - finish Phase 1".'),
            owner: z.string().nullish().describe('The Owner column value, e.g. "Gleb" or "Maxim + Vis". Null/omit when none.'),
            isMine: z.boolean().optional().describe("True when this goal is Moran's (story-match first, owner-name fallback). Defaults false."),
          }),
        )
        .describe('The full, cleaned list of current-sprint goals. Replaces any existing goals for the sprint.'),
    },
  },
  async ({ goals }) => {
    const payload = await buildPrePlanPayload();
    const sprintName = payload.sprintName;
    if (!sprintName) return errorResult('No current sprint — set a sprint first.');
    const cleaned = normalizeGoals(
      goals.map(g => ({ text: g.text, owner: g.owner ?? null, isMine: g.isMine ?? false })),
    );
    const next = setGoals(getPrePlanState(sprintName), cleaned);
    savePrePlanState(sprintName, next);
    return jsonResult({ saved: cleaned.length, sprintName });
  },
);
```

- [ ] **Step 6: Typecheck**

Run: `npx tsc -b`
Expected: exit 0 (server side clean; client `goals` type mismatch may still surface here — resolved in Tasks 3/4, same note as Task 1 Step 6).

- [ ] **Step 7: Commit**

```bash
git add server/preplan.ts server/preplan.test.ts mcp/server.ts
git commit -m "feat(preplan): preplan_set_goals MCP tool + tested setGoals merge"
```

---

### Task 3: SERVER_INSTRUCTIONS pre-plan-goals block

A short block so the assistant fires `preplan_set_goals` proactively when Moran pastes the goals email. Points at the tool; does not re-teach parsing (the tool description carries the steps).

**Files:**
- Modify: `mcp/server.ts` (SERVER_INSTRUCTIONS string — add a block near the `KEEPING MORAN'S NOTES` section, ~line 1029)

**Interfaces:** none (prose).

- [ ] **Step 1: Add the instruction block**

In `mcp/server.ts`, find the `KEEPING MORAN'S NOTES` section (~line 1029) and add a new block just before or after it (match the surrounding template-literal style — these are inside the big SERVER_INSTRUCTIONS backtick string):

```
PRE-PLAN GOALS (his dashboard's Pre-plan page):
  - When Moran pastes the delivery manager's goals email, or says "set my
    goals" / "here are the sprint goals", call \`preplan_set_goals\`.
  - The tool description has the exact steps: confirm the sprint matches the
    current one, take only the current-sprint goal rows (drop the header and
    owner-name lines and the previous-sprint table), capture each goal's owner,
    and mark which are Moran's (his story matches first, else owner name).
  - It's local prep only — it never writes to Azure DevOps. After it saves,
    tell him it's set and to refresh the Pre-plan page.
```

- [ ] **Step 2: Typecheck (string-only change, sanity)**

Run: `npx tsc -b`
Expected: exit 0 (still possibly blocked only by the client `goals` type until Task 4 — same cross-task note).

- [ ] **Step 3: Commit**

```bash
git add mcp/server.ts
git commit -m "docs(preplan): SERVER_INSTRUCTIONS block for setting goals from the email"
```

---

### Task 4: Client types — `ApiPrePlanGoal`, payload mirror, stop sending `goals` on POST

Mirror the server's goal record on the client and stop the page from pushing free-text goals.

**Files:**
- Modify: `src/lib/api.ts`

**Interfaces:**
- Produces: `ApiPrePlanGoal { text: string; owner: string | null; isMine: boolean }`.
- Changes: `ApiPrePlanPayload.goals: ApiPrePlanGoal[]` (was `string[]`).
- Changes: `savePrePlan` body type drops `goals` (page no longer sets goals; the box is read-only). Keep `story`.

- [ ] **Step 1: Add `ApiPrePlanGoal` + update the payload**

In `src/lib/api.ts`, add above `ApiPrePlanCoverageGoal` (line 668):

```ts
export interface ApiPrePlanGoal {
  text: string;
  owner: string | null;
  isMine: boolean;
}
```

Change `ApiPrePlanPayload.goals` (line 676) from `goals: string[];` to `goals: ApiPrePlanGoal[];`.

- [ ] **Step 2: Drop `goals` from the `savePrePlan` body type**

Change `savePrePlan`'s parameter (line 689-692) to drop the `goals` field:

```ts
export async function savePrePlan(body: {
  story?: { id: string; call?: ApiPrePlanCall; goalIndex?: number | null };
}): Promise<ApiPrePlanPayload> {
```

(The POST endpoint still accepts `goals` server-side for backward-safety; the page just stops sending it. Leave the server endpoint as-is.)

- [ ] **Step 3: Typecheck**

Run: `npx tsc -b`
Expected: now fails ONLY in `src/components/PrePlanView.tsx` (it reads `data.goals` as strings and calls `savePrePlan({ goals })`). That's the Task 5 surface — confirm the remaining errors are all in PrePlanView and proceed.

- [ ] **Step 4: Commit**

```bash
git add src/lib/api.ts
git commit -m "feat(preplan): client goal records; stop sending goals on save"
```

---

### Task 5: PrePlanView — instruction line, read-only owner-aware goals, drop the textarea

Turn the goals box into a read-only owner-aware list, add the instruction line, and remove the now-dead manual-save path. Goal dropdown options + coverage read `goal.text`.

**Files:**
- Modify: `src/components/PrePlanView.tsx`
- Modify: `src/styles/dashboard.css` (goal list + owner / "mine" markers + instruction line)

**Interfaces:**
- Consumes: `ApiPrePlanGoal`, `ApiPrePlanPayload`, `savePrePlan` (now goals-free), `fetchPrePlan`.

- [ ] **Step 1: Replace the goals section (instruction + read-only list)**

In `src/components/PrePlanView.tsx`, remove the `goalsDraft` state (line 32), the `saveGoals` function (lines 65-73 area), and the `<textarea>` block (lines 86-97). Replace the `<section className="preplan-goals">` with:

```tsx
      <section className="preplan-goals">
        <p className="preplan-goals-hint">
          Paste your goals email into a chat and ask me to set them up. They’ll appear here.
        </p>
        {data.goals.length === 0 ? (
          <p className="preplan-goals-empty">No goals set yet.</p>
        ) : (
          <ul className="preplan-goals-list">
            {data.goals.map((g, i) => (
              <li key={i} className={`preplan-goal-item${g.isMine ? ' is-mine' : ''}`}>
                <span className="preplan-goal-text">Goal {i + 1}: {g.text}</span>
                {g.owner && <span className="preplan-goal-owner">{g.owner}</span>}
                {g.isMine && <span className="preplan-goal-mine">mine</span>}
              </li>
            ))}
          </ul>
        )}
      </section>
```

Also remove the `setGoalsDraft(d.goals.join('\n'))` line inside the `load()` callback (the draft state is gone). And remove `setGoalsDraft(d.goals.join('\n'))` from anywhere else it appears.

- [ ] **Step 2: Fix the goal dropdown + coverage to read `goal.text`**

The card-row goal `<select>` (lines 184-195) maps `goals` (now `ApiPrePlanGoal[]`). Update the `PrePlanCardRow` prop type and the option rendering:

In the `PrePlanCardRow` props type, change `goals: string[];` to `goals: ApiPrePlanGoal[];` (add the import of `ApiPrePlanGoal` at the top with the other api imports). Update the option text to use `g.text`:

```tsx
            {goals.map((g, i) => (
              <option key={i} value={i}>{`Goal ${i + 1}: ${g.text.length > 40 ? g.text.slice(0, 39) + '…' : g.text}`}</option>
            ))}
```

The coverage `<section>` already reads `g.text` from the coverage payload (which is `PrePlanCoverageGoal`, unchanged) — leave it. Confirm `data.goals.length > 0` guards still work (they do — `goals` is still an array).

- [ ] **Step 3: Add CSS for the instruction line + goals list + markers**

In `src/styles/dashboard.css`, find the existing `.preplan-goals` / `.preplan-goals-box` block and ADD (reuse real tokens — `--ink-1/2/3`, `--surface-1/2`, `--line`, `--accent`, `--st-going`; honor no-small-and-gray):

```css
.preplan-goals-hint { margin: 0 0 10px; font-size: 13px; color: var(--ink-2); }
.preplan-goals-empty { margin: 0; color: var(--ink-3); font-size: 14px; }
.preplan-goals-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
.preplan-goal-item { display: flex; align-items: center; gap: 10px; background: var(--surface-2, #1c1c22); border: 1px solid var(--line, #333); border-radius: 8px; padding: 8px 12px; }
.preplan-goal-item.is-mine { border-left: 3px solid var(--accent, #5b8def); }
.preplan-goal-text { color: var(--ink-1); font-size: 14px; flex: 1; }
.preplan-goal-owner { color: var(--ink-2); font-size: 13px; }
.preplan-goal-mine { color: var(--accent, #5b8def); font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; }
```

You may remove the now-unused `.preplan-goals-box` textarea rule if present (optional cleanup — leave if uncertain).

- [ ] **Step 4: Typecheck + full suite**

Run: `npx tsc -b && npm test`
Expected: `tsc -b` exit 0 (all cross-task type seams now closed); full suite green.

- [ ] **Step 5: Commit**

```bash
git add src/components/PrePlanView.tsx src/styles/dashboard.css
git commit -m "feat(preplan): read-only owner-aware goals list + chat-flow instruction line"
```

---

## Manual Smoke (flag for Moran — needs dashboard restart + MCP reload)

The tool + instructions need `/exit` + `claude --resume`; the page + server need `npm run dev` restarted. Then:

1. **Paste the real PM email into a chat**, say "set my goals" → assistant confirms the sprint, sets ~4 goals with owners, flags yours → tool returns `{ saved: 4, sprintName }`.
2. **Refresh the Pre-plan page** → goals show as a read-only list, each with its owner, yours marked "mine"; no header/owner-name junk; coverage clean and owner-aware.
3. **Old sprint with legacy string goals** (if any) → still renders (owner blank, not "mine"), no crash.
4. **Per-story call + goal-link** still save and persist (unchanged behavior).
5. **No ADO writes** — board unchanged after all of the above.

## Self-Review Notes

- **Spec coverage:** goal record + migration → Task 1; `preplan_set_goals` + server-side sprint + replace/link-reset → Task 2; proactive firing → Task 3 (instructions); client mirror + stop-sending-goals → Task 4; instruction line + read-only owner-aware list + "mine" marker → Task 5. Out-of-scope items (box parsing, copy-prompt detour, hand-edit, ADO writes, email auto-import, previous-sprint table) are in Global Constraints / not built.
- **Type consistency:** `PrePlanGoal` (server) ↔ `ApiPrePlanGoal` (client) field-for-field; `goals` is `PrePlanGoal[]` everywhere after Task 1/4; `goalIndex` stays index-based; `setGoals` reset rule (`< goals.length`) matches the test.
- **Cross-task build seam:** Tasks 1-4 each may leave `tsc -b` red ONLY at the not-yet-updated client files; Task 5 closes it. Each task's own logic test passes in isolation. Flagged in the steps so an implementer doesn't "fix" the seam in the wrong task. The full green gate is Task 5 Step 4.
- **Placeholder scan:** no TBD/placeholder; every code step has complete code.
- **Reuse vs new:** `normalizeGoals` is reused by both `getPrePlanState` (read migration) and the tool handler (defensive clean) — one normalizer, two callers. DRY.
