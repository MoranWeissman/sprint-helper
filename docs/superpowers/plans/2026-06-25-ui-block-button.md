# UI Block / Unblock button — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a one-click Block / Unblock button to the work item drawer header, for Task and User Story only, with no reason prompt.

**Architecture:** New `POST /api/workitem/<id>/block|unblock` actions inside the existing `/api/workitem/` Vite middleware call `transitionToBlocked`/`transitionFromBlocked` + `updateTags` (already in `server/writes.ts`) and invalidate the dashboard cache. A `BlockButton` in `WorkItemDrawer` (shown only for Task/User Story) calls a thin `src/lib/api.ts` helper, then the drawer's existing `refresh()`. Blocked-ness is decided client-side from the item's `state` + `tags`.

**Tech Stack:** TypeScript, React 18, Vite middleware, Vitest 4.

---

### Task 1: Guard test — `transitionToBlocked` throws for a type with no Blocked state

This documents WHY the button is Task/Story-only: a Bug has no Blocked state, so the
transition throws. Pin that behavior so a future refactor can't silently "fix" it into a
half-working state without us noticing.

**Files:**
- Test: `server/writes.test.ts` (append a new `describe` block)

- [ ] **Step 1: Read the existing test file head** to copy its import + ADO-mock style

Run: `sed -n '1,40p' server/writes.test.ts`
Expected: see how `setStateBucket` / `patchWorkItem` are mocked (vi.mock of `./ado` or similar).

- [ ] **Step 2: Write the failing test**

Add a test asserting that when every Blocked-bucket state name is rejected by ADO (the Bug
case), `transitionToBlocked` rejects. Mirror the existing mock setup in the file — make
`patchWorkItem` reject with a message containing `"valid state"` for any `System.State` write,
and make the pre-read (`fetchEffortFields`) resolve with a plausible state like `'Active'`.

```ts
describe('transitionToBlocked — no Blocked state available (Bug)', () => {
  it('rejects when ADO refuses every Blocked-bucket state', async () => {
    // patchWorkItem mocked to reject state writes with a "not a valid state" message,
    // fetchEffortFields mocked to resolve { fields: { 'System.State': 'Active' } }.
    await expect(transitionToBlocked(123)).rejects.toThrow();
  });
});
```

Match the file's actual mocking mechanism (don't invent one). If the file already has a
shared mock for `./ado`, extend it for this case rather than adding a second `vi.mock`.

- [ ] **Step 3: Run the test to verify it fails (or passes for the right reason)**

Run: `npm test -- writes`
Expected: the new test runs. If it already passes, confirm it passes BECAUSE the chain
exhausts and throws (not because the mock never rejects) — read the assertion output.

- [ ] **Step 4: Make it green if needed**

No production change should be required — `transitionToBlocked` already throws here. If the
test fails, the fault is in the mock setup; fix the test, not `writes.ts`.

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: all green (was 93 before; now 94).

- [ ] **Step 6: Commit**

```bash
git add server/writes.test.ts
git commit -m "test: transitionToBlocked throws when no Blocked state exists (Bug case)"
```

---

### Task 2: Block / Unblock API route

**Files:**
- Modify: `vite.config.ts` (the `/api/workitem/` middleware, path match around line 72–166)

- [ ] **Step 1: Widen the path regex to recognize the new actions**

Replace the match line:

```ts
const m = url.pathname.match(/^\/(\d+)(\/edit)?/);
```

with:

```ts
const m = url.pathname.match(/^\/(\d+)(?:\/(edit|block|unblock))?/);
```

and replace `const isEdit = !!m[2];` with:

```ts
const action = m[2]; // 'edit' | 'block' | 'unblock' | undefined
```

Then change the existing `if (isEdit) {` to `if (action === 'edit') {`.

- [ ] **Step 2: Add the block/unblock handler**

Immediately AFTER the closing `}` of the `if (action === 'edit') { ... }` block (before the
`getWorkItem` GET fallthrough), insert:

```ts
if (action === 'block' || action === 'unblock') {
  if (req.method !== 'POST') {
    res.statusCode = 405;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'POST only' }));
    return;
  }
  const { transitionToBlocked, transitionFromBlocked, updateTags } = await import('./server/writes');
  let state: string;
  if (action === 'block') {
    const change = await transitionToBlocked(id);
    await updateTags(id, { add: ['Blocked'] });
    state = change.toState;
  } else {
    const change = await transitionFromBlocked(id);
    await updateTags(id, { remove: ['Blocked'] });
    state = change.toState;
  }
  const { invalidateDashboardCache } = await import('./server/dashboard-cache');
  invalidateDashboardCache();
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify({ state }));
  return;
}
```

The outer `try/catch` already returns a 500 with the error message, so a write failure is
handled.

- [ ] **Step 3: Typecheck**

Run: `npx tsc -b`
Expected: no new errors (pre-existing `Dashboard.tsx`/`standup.ts` warnings may remain — leave them).

- [ ] **Step 4: Commit**

```bash
git add vite.config.ts
git commit -m "feat: POST /api/workitem/<id>/block + /unblock routes"
```

---

### Task 3: Client helpers

**Files:**
- Modify: `src/lib/api.ts` (in the "Work item edits" section, after `updateWorkItem`)

- [ ] **Step 1: Add the two helpers**

```ts
/** Block a work item (Task / User Story). Returns the new ADO state. */
export async function postWorkItemBlock(workItemId: string): Promise<{ state: string }> {
  return postBlockAction(workItemId, 'block');
}

/** Clear a block on a work item. Returns the new ADO state. */
export async function postWorkItemUnblock(workItemId: string): Promise<{ state: string }> {
  return postBlockAction(workItemId, 'unblock');
}

async function postBlockAction(workItemId: string, action: 'block' | 'unblock'): Promise<{ state: string }> {
  const r = await fetch(`/api/workitem/${encodeURIComponent(workItemId)}/${action}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  });
  const body = await r.json();
  if (!r.ok || 'error' in body) {
    throw new Error(body.error ?? `${action} failed`);
  }
  return body;
}
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc -b`
Expected: no new errors.

- [ ] **Step 3: Commit**

```bash
git add src/lib/api.ts
git commit -m "feat: postWorkItemBlock / postWorkItemUnblock client helpers"
```

---

### Task 4: BlockButton in the drawer header

**Files:**
- Modify: `src/components/WorkItemDrawer.tsx`

- [ ] **Step 1: Import the helpers**

Add to the existing import from `../lib/api`:

```ts
import { useWorkItem, postWorkItemBlock, postWorkItemUnblock, type ApiWorkItemDetail, type ApiWorkItemRef, type ApiWorkItemComment } from '../lib/api';
```

(Keep `useState` available — add it to the existing `react` import: `import { useEffect, useMemo, useState } from 'react';`)

- [ ] **Step 2: Add the BlockButton component** (bottom of the file, near the other helpers)

```tsx
const BLOCKABLE_TYPES = new Set(['task', 'user story']);

function isBlockedNow(state: string, tags?: string): boolean {
  const s = state.trim().toLowerCase();
  if (s === 'blocked' || s === 'on hold') return true;
  if (tags && tags.split(';').some(t => t.trim().toLowerCase() === 'blocked')) return true;
  return false;
}

function BlockButton({ item, onChanged }: { item: ApiWorkItemDetail; onChanged: () => void }) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!BLOCKABLE_TYPES.has(item.type.trim().toLowerCase())) return null;

  const blocked = isBlockedNow(item.state, item.tags);

  async function toggle() {
    setPending(true);
    setError(null);
    try {
      if (blocked) await postWorkItemUnblock(String(item.id));
      else await postWorkItemBlock(String(item.id));
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'failed');
    } finally {
      setPending(false);
    }
  }

  return (
    <span className="ember-drawer-block">
      <button
        className={`ember-block-btn ${blocked ? 'is-blocked' : ''}`}
        onClick={toggle}
        disabled={pending}
        title={blocked ? 'Clear the block in Azure DevOps' : 'Mark blocked in Azure DevOps'}
      >
        {pending ? '…' : blocked ? 'Unblock' : 'Block'}
      </button>
      {error && <span className="ember-block-error dim-small">{error}</span>}
    </span>
  );
}
```

- [ ] **Step 3: Render it in the header**

The header's right-side `<span>` currently holds refresh + close. The button needs the loaded
item, which lives in `state.data.item`. Add it as the first child of that `<span>`, guarded on
`state.status === 'ok'`:

```tsx
<span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
  {state.status === 'ok' && <BlockButton item={state.data.item} onChanged={refresh} />}
  <button className="ember-sync" onClick={refresh} title="Refresh from Azure DevOps">
    <span className="ember-sync-icon">↻</span>
  </button>
  <button className="ember-drawer-close" onClick={onClose} aria-label="Close (Esc)">
    ✕
  </button>
</span>
```

- [ ] **Step 4: Typecheck**

Run: `npx tsc -b`
Expected: no new errors.

- [ ] **Step 5: Commit**

```bash
git add src/components/WorkItemDrawer.tsx
git commit -m "feat: Block/Unblock button in the work item drawer header"
```

---

### Task 5: Styling

**Files:**
- Modify: `src/styles/dashboard.css`

- [ ] **Step 1: Find the existing drawer-header button styles** to match shape/sizing

Run: `grep -n "ember-sync\|ember-drawer-close\|--st-blocked\|r21-blocked-pill" src/styles/dashboard.css`
Expected: locate the header button block + the blocked color token to reuse.

- [ ] **Step 2: Add minimal styles** near the other `.ember-drawer-*` header rules

```css
.ember-drawer-block { display: inline-flex; align-items: center; gap: 8px; }
.ember-block-btn {
  font-size: 12px;
  padding: 4px 10px;
  border-radius: 6px;
  border: 1px solid var(--st-blocked, #c0743a);
  background: transparent;
  color: var(--st-blocked, #c0743a);
  cursor: pointer;
}
.ember-block-btn:hover:not(:disabled) { background: var(--st-blocked-bg, rgba(192,116,58,0.12)); }
.ember-block-btn:disabled { opacity: 0.5; cursor: default; }
.ember-block-btn.is-blocked {
  /* Already blocked → the button clears it. Read as the live/active accent so
     it doesn't shout "blocked" twice (the State pill already says that). */
  border-color: var(--st-going, #4a7fb0);
  color: var(--st-going, #4a7fb0);
}
.ember-block-error { color: var(--st-blocked, #c0743a); }
```

Use the actual token names found in Step 1 (`--st-blocked` / `--st-blocked-bg` / `--st-going`).
If a token doesn't exist, drop the fallback hex's variable and keep the hex.

- [ ] **Step 3: Build to confirm CSS is valid**

Run: `npm run build`
Expected: build succeeds.

- [ ] **Step 4: Commit**

```bash
git add src/styles/dashboard.css
git commit -m "style: Block/Unblock drawer button"
```

---

## After all tasks

- `npm test` → all green (94).
- `npx tsc -b` → no new errors.
- Flag for Moran: dashboard dev-server restart (`npm run dev`) to pick up the new route +
  hard-refresh for the UI, then the live smoke from the spec.
