# End-of-day Wrap Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An evening wrap card on the Daily view (what today gave / still open / tomorrow's first move) that appears after work goes quiet, plus a chat-side "wrapping up" instruction block.

**Architecture:** New pure-ish module `server/wrap.ts` (today-window SQL + pure builder) feeds a new `wrap` field on the dashboard payload; a new `WrapCard` component owns the client-side quiet rule (`wrapVisible`) so the clock is never frozen by the payload cache. "What today gave" reuses the existing `standup.today` rows — no new server work for that part.

**Tech Stack:** TypeScript, better-sqlite3, Vite/React, Vitest 4 (in-memory DB harness via `vi.hoisted` + `vi.mock('./db', …)`).

**Spec:** `docs/superpowers/specs/2026-07-05-end-of-day-wrap-design.md`

## Global Constraints

- Quiet-rule constants live client-side next to `wrapVisible`: `QUIET_AFTER_HOUR = 14`, `QUIET_GAP_MINUTES = 60`. Boundary values pass: exactly 14:00 → visible-eligible; exactly 60 min gap → visible-eligible.
- The client payload field is OPTIONAL (`wrap?: ApiWrap`) and the card's first line is `if (!wrap) return null;` — a stale dev server must never crash the page (2026-07-05 lesson).
- `displayName` format is exactly `**<title>** (#<id>)`, falling back to `#<id>` when the title is unknown — same as `server/needs-you.ts`.
- Done-ness uses the dashboard's existing `DONE_STATES` against `taskMeta` state — never re-derive done from session data.
- Paused sessions never appear in "still open" — only sessions with `ended_at IS NULL`.
- UI copy is plain English (no agile jargon). Empty-states copy verbatim: `Everything closed. Clean end.` and `Nothing carried over — pick fresh tomorrow.`
- CSS namespace `wrap-*`; dark/warm tokens only; no animation/pulsing; no font-size ≤ 12px combined with `--ink-4`.
- All timestamps compared as ISO-UTC strings (repo convention — `standup.ts` does the same); SQLite `MAX(ts)` over these TEXT columns is chronologically correct because `Date.toISOString()` output is fixed-width UTC.
- Commit after each green test run. Never commit a failing state.

---

### Task 1: `server/wrap.ts` — wrap block builder + tests

**Files:**
- Create: `server/wrap.ts`
- Test: `server/wrap.test.ts`

**Interfaces:**
- Consumes: `getDb()` from `./db`, `DEFAULT_WORKING_DAYS` from `./capacity`, `Session` type from `./sessions`.
- Produces (Task 2 relies on these exact names):
  - `interface WrapOpenSession { workItemId: number; displayName: string; startedAt: string }`
  - `interface WrapFirstMove { workItemId: number; displayName: string; remainingHours: number | null }`
  - `interface WrapBlock { isWorkingDay: boolean; lastActivityAt: string | null; stillOpen: WrapOpenSession[]; firstMove: WrapFirstMove | null }`
  - `interface WrapActivityRow { workItemId: number; lastTs: string }`
  - `todayActivityRows(now?: Date): WrapActivityRow[]`
  - `isWorkingDayFor(now: Date): boolean`
  - `buildWrap(opts): WrapBlock` (signature in code below)

- [ ] **Step 1: Write the failing test**

Create `server/wrap.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';

// Same harness as sessions.test.ts: fresh in-memory db per test, final schema.
const h = vi.hoisted(() => ({ db: { value: null as null | InstanceType<typeof Database> } }));
vi.mock('./db', () => ({ getDb: () => h.db.value }));

import { todayActivityRows, buildWrap, isWorkingDayFor } from './wrap';
import type { Session } from './sessions';

function makeDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE sessions (
      id            TEXT PRIMARY KEY,
      work_item_id  INTEGER NOT NULL,
      started_at    TEXT NOT NULL,
      ended_at      TEXT,
      client        TEXT NOT NULL DEFAULT 'claude-code',
      summary       TEXT,
      cwd           TEXT,
      waiting_note  TEXT,
      waiting_since TEXT
    );
    CREATE TABLE session_events (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id      TEXT NOT NULL,
      work_item_id    INTEGER NOT NULL,
      type            TEXT NOT NULL,
      text            TEXT NOT NULL,
      created_at      TEXT NOT NULL,
      standup_summary TEXT
    );
  `);
  return db;
}

beforeEach(() => {
  h.db.value = makeDb();
});

// A fixed "now": 2026-07-05 16:30 local. Sessions/events are inserted with
// ISO-UTC strings placed clearly inside or outside the local day so the
// window logic is unambiguous regardless of the machine's timezone offset:
// we derive in-window timestamps FROM `now` itself.
const NOW = new Date(2026, 6, 5, 16, 30, 0); // local time, July = month 6
const iso = (minutesBeforeNow: number) =>
  new Date(NOW.getTime() - minutesBeforeNow * 60_000).toISOString();

function insertSession(id: string, workItemId: number, startedAt: string, endedAt: string | null) {
  h.db.value!
    .prepare('INSERT INTO sessions (id, work_item_id, started_at, ended_at) VALUES (?, ?, ?, ?)')
    .run(id, workItemId, startedAt, endedAt);
}

function insertEvent(sessionId: string, workItemId: number, createdAt: string) {
  h.db.value!
    .prepare(
      "INSERT INTO session_events (session_id, work_item_id, type, text, created_at) VALUES (?, ?, 'progress', 'worked', ?)",
    )
    .run(sessionId, workItemId, createdAt);
}

describe('todayActivityRows', () => {
  it('returns the newest timestamp per work item across starts, ends and events', () => {
    insertSession('s1', 101, iso(300), iso(200)); // started 5h ago, ended ~3h20m ago
    insertEvent('s1', 101, iso(250));
    insertSession('s2', 202, iso(90), null); // still open
    const rows = todayActivityRows(NOW);
    const byId = new Map(rows.map(r => [r.workItemId, r.lastTs]));
    expect(byId.get(101)).toBe(iso(200)); // the end is the newest touch on 101
    expect(byId.get(202)).toBe(iso(90)); // open session: only its start counts
  });

  it('ignores yesterday\'s activity and returns empty on an empty day', () => {
    // 30 hours ago is safely on a previous local day for a 16:30 "now".
    insertSession('old', 303, iso(30 * 60), iso(29 * 60));
    expect(todayActivityRows(NOW)).toEqual([]);
  });
});

function fakeSession(workItemId: number, startedAt: string): Session {
  return {
    id: `sess-${workItemId}`,
    workItemId,
    startedAt,
    endedAt: null,
    client: 'claude-code',
    summary: null,
    cwd: null,
    waitingNote: null,
    waitingSince: null,
  };
}

describe('buildWrap', () => {
  const titles = new Map<number, string>([[101, 'Fix login'], [202, 'Write docs']]);
  const base = {
    titleFor: (id: number) => titles.get(id) ?? null,
    isDone: (_id: number) => false,
    remainingFor: (_id: number) => null,
    isWorkingDay: true,
  };

  it('lastActivityAt is the newest row timestamp, null when nothing today', () => {
    const wrap = buildWrap({
      ...base,
      activityRows: [
        { workItemId: 101, lastTs: '2026-07-05T10:00:00.000Z' },
        { workItemId: 202, lastTs: '2026-07-05T12:00:00.000Z' },
      ],
      activeSessions: [],
    });
    expect(wrap.lastActivityAt).toBe('2026-07-05T12:00:00.000Z');
    const empty = buildWrap({ ...base, activityRows: [], activeSessions: [] });
    expect(empty.lastActivityAt).toBeNull();
    expect(empty.firstMove).toBeNull();
    expect(empty.stillOpen).toEqual([]);
  });

  it('firstMove picks the newest-touched not-done item, with hours when known', () => {
    const wrap = buildWrap({
      ...base,
      isDone: (id: number) => id === 202, // the newest one is done
      remainingFor: (id: number) => (id === 101 ? 3 : null),
      activityRows: [
        { workItemId: 101, lastTs: '2026-07-05T10:00:00.000Z' },
        { workItemId: 202, lastTs: '2026-07-05T12:00:00.000Z' },
      ],
      activeSessions: [],
    });
    expect(wrap.firstMove).toEqual({
      workItemId: 101,
      displayName: '**Fix login** (#101)',
      remainingHours: 3,
    });
  });

  it('firstMove is null when everything touched today is done', () => {
    const wrap = buildWrap({
      ...base,
      isDone: () => true,
      activityRows: [{ workItemId: 101, lastTs: '2026-07-05T10:00:00.000Z' }],
      activeSessions: [],
    });
    expect(wrap.firstMove).toBeNull();
  });

  it('stillOpen maps active sessions, with #id fallback for unknown titles', () => {
    const wrap = buildWrap({
      ...base,
      activityRows: [],
      activeSessions: [fakeSession(101, '2026-07-05T09:00:00.000Z'), fakeSession(999, '2026-07-05T11:00:00.000Z')],
    });
    expect(wrap.stillOpen).toEqual([
      { workItemId: 101, displayName: '**Fix login** (#101)', startedAt: '2026-07-05T09:00:00.000Z' },
      { workItemId: 999, displayName: '#999', startedAt: '2026-07-05T11:00:00.000Z' },
    ]);
  });
});

describe('isWorkingDayFor', () => {
  it('Sun-Thu true, Fri/Sat false', () => {
    expect(isWorkingDayFor(new Date(2026, 6, 5))).toBe(true);  // Sunday
    expect(isWorkingDayFor(new Date(2026, 6, 9))).toBe(true);  // Thursday
    expect(isWorkingDayFor(new Date(2026, 6, 10))).toBe(false); // Friday
    expect(isWorkingDayFor(new Date(2026, 6, 11))).toBe(false); // Saturday
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run server/wrap.test.ts`
Expected: FAIL — cannot resolve `./wrap`.

- [ ] **Step 3: Write the implementation**

Create `server/wrap.ts`:

```ts
/**
 * End-of-day wrap block for the Daily view: the facts the evening card needs
 * beyond what the standup block already carries. "What today gave" reuses
 * `standup.today` on the client; this module adds the quiet-rule inputs
 * (newest activity today), the open sessions, and tomorrow's first move.
 *
 * The show/hide decision itself lives on the CLIENT (`wrapVisible` in
 * WrapCard.tsx) — the payload is cached, so a server-computed "show now"
 * boolean would freeze inside the cache.
 */
import { getDb } from './db';
import { DEFAULT_WORKING_DAYS } from './capacity';
import type { Session } from './sessions';

export interface WrapOpenSession {
  workItemId: number;
  /** Pre-formatted `**title** (#id)`, or `#id` when the title is unknown. */
  displayName: string;
  startedAt: string;
}

export interface WrapFirstMove {
  workItemId: number;
  displayName: string;
  /** RemainingWork hours; null = unknown (render the line without hours). */
  remainingHours: number | null;
}

export interface WrapBlock {
  isWorkingDay: boolean;
  /** Newest session start/end/event today (ISO); null = nothing today. */
  lastActivityAt: string | null;
  stillOpen: WrapOpenSession[];
  firstMove: WrapFirstMove | null;
}

/** Per-item newest activity timestamp within today's local-day window. */
export interface WrapActivityRow {
  workItemId: number;
  lastTs: string;
}

interface ActivityQueryRow {
  work_item_id: number;
  last_ts: string;
}

export function isWorkingDayFor(now: Date): boolean {
  return DEFAULT_WORKING_DAYS.has(now.getDay());
}

/**
 * Newest activity timestamp per work item for TODAY (local day): session
 * starts, session ends, and any session event. MAX() over the TEXT columns
 * is chronologically correct — every timestamp is `Date.toISOString()`
 * output (fixed-width UTC), the repo-wide convention.
 */
export function todayActivityRows(now: Date = new Date()): WrapActivityRow[] {
  const dayStart = new Date(now);
  dayStart.setHours(0, 0, 0, 0);
  const dayEnd = new Date(dayStart);
  dayEnd.setDate(dayEnd.getDate() + 1);
  const s = dayStart.toISOString();
  const e = dayEnd.toISOString();
  const rows = getDb()
    .prepare<string[], ActivityQueryRow>(
      `SELECT work_item_id, MAX(ts) AS last_ts FROM (
         SELECT work_item_id, started_at AS ts FROM sessions
          WHERE datetime(started_at) >= datetime(?) AND datetime(started_at) < datetime(?)
         UNION ALL
         SELECT work_item_id, ended_at AS ts FROM sessions
          WHERE ended_at IS NOT NULL
            AND datetime(ended_at) >= datetime(?) AND datetime(ended_at) < datetime(?)
         UNION ALL
         SELECT work_item_id, created_at AS ts FROM session_events
          WHERE datetime(created_at) >= datetime(?) AND datetime(created_at) < datetime(?)
       )
       GROUP BY work_item_id`,
    )
    .all(s, e, s, e, s, e);
  return rows.map(r => ({ workItemId: r.work_item_id, lastTs: r.last_ts }));
}

export function buildWrap(opts: {
  activityRows: WrapActivityRow[];
  activeSessions: Session[];
  titleFor: (workItemId: number) => string | null;
  /** True when the work item's REAL state is a done state right now. */
  isDone: (workItemId: number) => boolean;
  /** RemainingWork hours for the item; null when unknown. */
  remainingFor: (workItemId: number) => number | null;
  isWorkingDay: boolean;
}): WrapBlock {
  const displayName = (id: number) => {
    const title = opts.titleFor(id);
    return title ? `**${title}** (#${id})` : `#${id}`;
  };

  let lastActivityAt: string | null = null;
  for (const r of opts.activityRows) {
    if (lastActivityAt == null || r.lastTs > lastActivityAt) lastActivityAt = r.lastTs;
  }

  const stillOpen: WrapOpenSession[] = opts.activeSessions.map(sess => ({
    workItemId: sess.workItemId,
    displayName: displayName(sess.workItemId),
    startedAt: sess.startedAt,
  }));

  // Tomorrow's first move: the item touched LAST today that isn't done.
  const candidates = [...opts.activityRows]
    .filter(r => !opts.isDone(r.workItemId))
    .sort((a, b) => (a.lastTs < b.lastTs ? 1 : a.lastTs > b.lastTs ? -1 : 0));
  const first = candidates[0];
  const firstMove: WrapFirstMove | null = first
    ? {
        workItemId: first.workItemId,
        displayName: displayName(first.workItemId),
        remainingHours: opts.remainingFor(first.workItemId),
      }
    : null;

  return { isWorkingDay: opts.isWorkingDay, lastActivityAt, stillOpen, firstMove };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run server/wrap.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Full suite + typecheck, then commit**

Run: `npm test` — expected: all green (167 existing + 7 new).
Run: `npx tsc -b` — expected: clean.

```bash
git add server/wrap.ts server/wrap.test.ts
git commit -m "feat(wrap): end-of-day wrap block builder"
```

---

### Task 2: Dashboard payload carries `wrap`

**Files:**
- Modify: `server/dashboard.ts`

**Interfaces:**
- Consumes from Task 1: `buildWrap`, `todayActivityRows`, `isWorkingDayFor`, `WrapBlock` from `./wrap`.
- Produces: `DashboardPayload.wrap: WrapBlock` (placed right after `needsYou`). Task 3's `ApiWrap` mirrors `WrapBlock` field-for-field.

- [ ] **Step 1: Add the import**

In `server/dashboard.ts`, next to the existing `./needs-you` import, add:

```ts
import { buildWrap, todayActivityRows, isWorkingDayFor, type WrapBlock } from './wrap';
```

- [ ] **Step 2: Add the payload field**

In `interface DashboardPayload`, directly after the `needsYou: NeedsYouBlock;` line, add:

```ts
  /** End-of-day wrap facts. Show/hide is decided client-side (WrapCard). */
  wrap: WrapBlock;
```

- [ ] **Step 3: Empty-payload branch**

In the `if (!iteration)` early return, directly after `needsYou: { waiting: [], recentlyFinished: [] },` add:

```ts
      wrap: {
        isWorkingDay: isWorkingDayFor(new Date()),
        lastActivityAt: null,
        stillOpen: [],
        firstMove: null,
      },
```

- [ ] **Step 4: Build the block in the main path**

Three edits in `buildDashboard`:

(a) The standup enrichment block already fetches out-of-sprint worked items. Capture their RemainingWork too. Replace this existing block:

```ts
  const missingWorkedIds = workedItemIdsForStandup().filter(id => !taskMeta.has(id));
  if (missingWorkedIds.length > 0) {
    try {
      const extra = await getWorkItemsWithParents(missingWorkedIds);
      mergeIntoTaskMeta(taskMeta, extra);
    } catch {
      // Best-effort enrichment — if the fetch fails the recap still renders
      // with bare ids rather than breaking the whole dashboard.
    }
  }
```

with:

```ts
  // RemainingWork lookup for the wrap card's "first move" line. Sprint items
  // first; out-of-sprint worked items are folded in below, best-effort.
  const remainingById = new Map<number, number>();
  for (const w of items) {
    if (w.remainingWork != null) remainingById.set(w.id, w.remainingWork);
  }
  const missingWorkedIds = workedItemIdsForStandup().filter(id => !taskMeta.has(id));
  if (missingWorkedIds.length > 0) {
    try {
      const extra = await getWorkItemsWithParents(missingWorkedIds);
      mergeIntoTaskMeta(taskMeta, extra);
      for (const w of extra) {
        if (w.remainingWork != null && !remainingById.has(w.id)) {
          remainingById.set(w.id, w.remainingWork);
        }
      }
    } catch {
      // Best-effort enrichment — if the fetch fails the recap still renders
      // with bare ids rather than breaking the whole dashboard.
    }
  }
```

(b) The needs-you build calls `listActiveSessions()`; the wrap block needs the same list. Just above the `const needsYou = buildNeedsYou({` line add:

```ts
  const liveSessions = listActiveSessions();
```

and inside the `buildNeedsYou` call change `activeSessions: listActiveSessions(),` to `activeSessions: liveSessions,`.

(c) Directly after the `buildNeedsYou` call (before the `return {`), add:

```ts
  // End-of-day wrap facts. Local SQLite only — no ADO calls, nothing to
  // swallow; titles/states reuse the enriched taskMeta like needsYou does.
  const wrap = buildWrap({
    activityRows: todayActivityRows(),
    activeSessions: liveSessions,
    titleFor: id => taskMeta.get(id)?.title ?? null,
    isDone: id => DONE_STATES.has(taskMeta.get(id)?.state ?? ''),
    remainingFor: id => remainingById.get(id) ?? null,
    isWorkingDay: isWorkingDayFor(new Date()),
  });
```

- [ ] **Step 5: Return it**

In the main `return {` object, directly after `needsYou,` add:

```ts
    wrap,
```

- [ ] **Step 6: Verify + commit**

Run: `npm test` — expected: all green (no dashboard unit tests break; buildDashboard itself is integration-level, not unit-tested).
Run: `npx tsc -b` — expected: clean.

```bash
git add server/dashboard.ts
git commit -m "feat(wrap): dashboard payload carries the wrap block"
```

---

### Task 3: Client — types, WrapCard, quiet rule, styles

**Files:**
- Modify: `src/lib/api.ts`
- Create: `src/components/WrapCard.tsx`
- Test: `src/components/WrapCard.test.ts`
- Modify: `src/components/Dashboard.tsx` (DailyView wiring)
- Modify: `src/styles/dashboard.css`

**Interfaces:**
- Consumes: `ApiWrap` mirrors Task 2's `WrapBlock`; `ApiStandupEntry` (existing) for the today rows; `useNow()` already ticks every second in Dashboard.tsx.
- Produces: `WrapCard({ wrap, standupToday, now, onOpenItem })` component; exported pure `wrapVisible(opts): boolean` + constants `QUIET_AFTER_HOUR`, `QUIET_GAP_MINUTES`.

- [ ] **Step 1: Write the failing test**

Create `src/components/WrapCard.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { wrapVisible } from './WrapCard';

// Local-time constructor: month is 0-based. 2026-07-05 is a Sunday (working day).
const at = (h: number, m = 0) => new Date(2026, 6, 5, h, m, 0);
const isoMinutesBefore = (now: Date, min: number) => new Date(now.getTime() - min * 60_000).toISOString();

const base = { isWorkingDay: true, workedToday: true };

describe('wrapVisible', () => {
  it('shows when afternoon + quiet + worked + working day', () => {
    const now = at(16, 30);
    expect(wrapVisible({ ...base, now, lastActivityAt: isoMinutesBefore(now, 90) })).toBe(true);
  });

  it('hidden before 14:00 even when quiet', () => {
    const now = at(13, 59);
    expect(wrapVisible({ ...base, now, lastActivityAt: isoMinutesBefore(now, 90) })).toBe(false);
  });

  it('boundary: exactly 14:00 and exactly 60 minutes of quiet both count', () => {
    const now = at(14, 0);
    expect(wrapVisible({ ...base, now, lastActivityAt: isoMinutesBefore(now, 60) })).toBe(true);
  });

  it('hidden while activity is fresher than the quiet gap', () => {
    const now = at(16, 30);
    expect(wrapVisible({ ...base, now, lastActivityAt: isoMinutesBefore(now, 59) })).toBe(false);
  });

  it('hidden on a day off, an empty day, or with no activity timestamp', () => {
    const now = at(16, 30);
    const quiet = isoMinutesBefore(now, 90);
    expect(wrapVisible({ ...base, isWorkingDay: false, now, lastActivityAt: quiet })).toBe(false);
    expect(wrapVisible({ ...base, workedToday: false, now, lastActivityAt: quiet })).toBe(false);
    expect(wrapVisible({ ...base, now, lastActivityAt: null })).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/components/WrapCard.test.ts`
Expected: FAIL — cannot resolve `./WrapCard`.

- [ ] **Step 3: Add the API types**

In `src/lib/api.ts`, directly after the `ApiNeedsYou` interface, add:

```ts
export interface ApiWrapOpenSession {
  workItemId: number;
  /** Pre-formatted `**title** (#id)` — same shape as needs-you rows. */
  displayName: string;
  startedAt: string;
}

export interface ApiWrapFirstMove {
  workItemId: number;
  displayName: string;
  /** Hours left on the item; null = unknown, render without the hours part. */
  remainingHours: number | null;
}

export interface ApiWrap {
  isWorkingDay: boolean;
  /** Newest session activity today (ISO); null = nothing happened today. */
  lastActivityAt: string | null;
  stillOpen: ApiWrapOpenSession[];
  firstMove: ApiWrapFirstMove | null;
}
```

In the payload interface, directly after the `needsYou: ApiNeedsYou;` line, add (OPTIONAL — a stale server may not send it):

```ts
  /** End-of-day wrap facts; absent on older server payloads. */
  wrap?: ApiWrap;
```

- [ ] **Step 4: Write the component**

Create `src/components/WrapCard.tsx`:

```tsx
import { useState } from 'react';
import type { ApiStandupEntry, ApiWrap } from '../lib/api';

/** The card never shows before this local hour. */
export const QUIET_AFTER_HOUR = 14;
/** Minutes without session activity that count as "work went quiet". */
export const QUIET_GAP_MINUTES = 60;

const DISMISS_KEY = 'sh.wrap.dismissed';

/**
 * The quiet rule. Lives on the client because the payload is cached — the
 * server ships facts (isWorkingDay, lastActivityAt) and the always-fresh
 * client clock decides, so the card appears on time, not up to a cache
 * interval late.
 */
export function wrapVisible(opts: {
  now: Date;
  isWorkingDay: boolean;
  lastActivityAt: string | null;
  workedToday: boolean;
}): boolean {
  if (!opts.isWorkingDay || !opts.workedToday || opts.lastActivityAt == null) return false;
  if (opts.now.getHours() < QUIET_AFTER_HOUR) return false;
  const gapMinutes = (opts.now.getTime() - Date.parse(opts.lastActivityAt)) / 60_000;
  return gapMinutes >= QUIET_GAP_MINUTES;
}

function localISODate(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** `**title** (#id)` → `title`; bare `#id` stays as-is. */
function plainTitle(displayName: string): string {
  const m = /^\*\*(.+)\*\* \(#\d+\)$/.exec(displayName);
  return m ? m[1] : displayName;
}

function minutesLabel(min: number): string {
  if (min < 60) return `${min}m`;
  const h = Math.floor(min / 60);
  const rest = min % 60;
  return rest === 0 ? `${h}h` : `${h}h ${rest}m`;
}

function runningFor(startedAt: string, now: Date): string {
  return minutesLabel(Math.max(0, Math.round((now.getTime() - Date.parse(startedAt)) / 60_000)));
}

export function WrapCard({
  wrap,
  standupToday,
  now,
  onOpenItem,
}: {
  wrap: ApiWrap | undefined;
  standupToday: ApiStandupEntry[];
  now: Date;
  onOpenItem: (id: string) => void;
}) {
  const [dismissedOn, setDismissedOn] = useState<string | null>(() => {
    try {
      return localStorage.getItem(DISMISS_KEY);
    } catch {
      return null;
    }
  });

  // Older server payloads don't carry the wrap block — render nothing, never crash.
  if (!wrap) return null;

  const todayKey = localISODate(now);
  if (dismissedOn === todayKey) return null;
  if (
    !wrapVisible({
      now,
      isWorkingDay: wrap.isWorkingDay,
      lastActivityAt: wrap.lastActivityAt,
      workedToday: standupToday.length > 0,
    })
  ) {
    return null;
  }

  const dismiss = () => {
    try {
      localStorage.setItem(DISMISS_KEY, todayKey);
    } catch {
      /* private-mode storage failure — dismiss still works for this render */
    }
    setDismissedOn(todayKey);
  };

  return (
    <section className="wrap-card" aria-label="End of day">
      <div className="wrap-head">
        <h2 className="wrap-title">Wrapping up the day</h2>
        <button type="button" className="wrap-dismiss" onClick={dismiss} title="Hide until tomorrow">
          ✕
        </button>
      </div>

      <h3 className="wrap-sec-h">What today gave</h3>
      <ul className="wrap-list">
        {standupToday.map(e => (
          <li key={e.workItemId} className="wrap-row">
            <span className="wrap-row-title">{plainTitle(e.displayName)}</span>
            {e.minutesInWindow != null && (
              <span className="wrap-row-meta">{minutesLabel(e.minutesInWindow)}</span>
            )}
            {e.summary && <p className="wrap-row-summary">{e.summary}</p>}
          </li>
        ))}
      </ul>

      <h3 className="wrap-sec-h">Still open</h3>
      {wrap.stillOpen.length === 0 ? (
        <p className="wrap-clean">Everything closed. Clean end.</p>
      ) : (
        <ul className="wrap-list">
          {wrap.stillOpen.map(s => (
            <li key={s.workItemId} className="wrap-row is-open">
              <button
                type="button"
                className="wrap-row-link"
                onClick={() => onOpenItem(String(s.workItemId))}
              >
                {plainTitle(s.displayName)}
              </button>
              <span className="wrap-row-meta">running {runningFor(s.startedAt, now)}</span>
            </li>
          ))}
        </ul>
      )}

      <h3 className="wrap-sec-h">Tomorrow's first move</h3>
      {wrap.firstMove == null ? (
        <p className="wrap-clean">Nothing carried over — pick fresh tomorrow.</p>
      ) : (
        <p className="wrap-first">
          Pick up{' '}
          <button
            type="button"
            className="wrap-row-link"
            onClick={() => onOpenItem(String(wrap.firstMove!.workItemId))}
          >
            {plainTitle(wrap.firstMove.displayName)}
          </button>
          {wrap.firstMove.remainingHours != null && <> — about {wrap.firstMove.remainingHours}h left</>}
          .
        </p>
      )}
    </section>
  );
}
```

Note on the "What today gave" duration: `minutesInWindow` is null while a session is live — the row then just shows title + summary. That matches the recap's own behavior.

- [ ] **Step 5: Run the test**

Run: `npx vitest run src/components/WrapCard.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 6: Wire into DailyView**

In `src/components/Dashboard.tsx`:

(a) Add the import near the other component imports:

```ts
import { WrapCard } from './WrapCard';
```

(b) In the `<DailyView … />` call site, add a prop after `needsYou={data.needsYou}`:

```tsx
              wrap={data.wrap}
```

(c) In `function DailyView({ … })`, add `wrap,` to the destructured props (after `needsYou,`) and to the props type (after `needsYou: ApiNeedsYou;`):

```ts
  wrap: ApiPayload['wrap'];
```

(d) In DailyView's JSX, directly ABOVE the `<StandupCard standup={standup} />` line, add:

```tsx
      {/* End-of-day wrap — appears only after work goes quiet in the
          afternoon. The evening twin of the standup card below it. */}
      <WrapCard wrap={wrap} standupToday={standup.today} now={now} onOpenItem={onOpenItem} />
```

- [ ] **Step 7: Styles**

In `src/styles/dashboard.css`, append a `wrap-*` block (follow the existing token names used by `r21-standup` / `needsyou-*` rules in this file — reuse the same `--surface-*`, `--line`, `--ink-*`, `--accent` variables):

```css
/* --- End-of-day wrap card ------------------------------------------- */
.wrap-card {
  background: var(--surface-2);
  border: 1px solid var(--line);
  border-radius: 10px;
  padding: 16px 18px;
  margin-bottom: 16px;
}
.wrap-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 4px;
}
.wrap-title {
  font-size: 15px;
  font-weight: 600;
  color: var(--ink-1);
  margin: 0;
}
.wrap-dismiss {
  background: none;
  border: none;
  color: var(--ink-3);
  font-size: 13px;
  cursor: pointer;
  padding: 2px 6px;
}
.wrap-dismiss:hover {
  color: var(--ink-1);
}
.wrap-sec-h {
  font-size: 12px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--ink-3);
  margin: 12px 0 6px;
}
.wrap-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.wrap-row-title {
  font-size: 13px;
  color: var(--ink-1);
  font-weight: 500;
}
.wrap-row-meta {
  font-size: 12px;
  color: var(--ink-3);
  margin-left: 8px;
}
.wrap-row-summary {
  font-size: 13px;
  color: var(--ink-2);
  margin: 2px 0 0;
  line-height: 1.5;
}
.wrap-row-link {
  background: none;
  border: none;
  padding: 0;
  font-size: 13px;
  font-weight: 500;
  color: var(--ink-1);
  cursor: pointer;
  text-decoration: underline;
  text-decoration-color: var(--line);
  text-underline-offset: 3px;
}
.wrap-row-link:hover {
  text-decoration-color: var(--accent);
}
.wrap-clean {
  font-size: 13px;
  color: var(--ink-2);
  margin: 0;
}
.wrap-first {
  font-size: 13px;
  color: var(--ink-1);
  margin: 0;
  padding-left: 10px;
  border-left: 2px solid var(--accent);
  line-height: 1.6;
}
```

If any variable name above doesn't exist in this stylesheet, match the exact variables the adjacent `needsyou-*` rules use instead — do not invent new tokens.

- [ ] **Step 8: Verify + commit**

Run: `npm test` — expected: all green.
Run: `npx tsc -b` — expected: clean.

```bash
git add src/lib/api.ts src/components/WrapCard.tsx src/components/WrapCard.test.ts src/components/Dashboard.tsx src/styles/dashboard.css
git commit -m "feat(wrap): evening wrap card on the Daily view"
```

---

### Task 4: SERVER_INSTRUCTIONS — "WRAPPING UP THE DAY" block

**Files:**
- Modify: `mcp/server.ts` (SERVER_INSTRUCTIONS string only — no code, no tools)

**Interfaces:**
- Consumes: nothing from other tasks (prose only).
- Produces: nothing consumed by code.

- [ ] **Step 1: Add the block**

In `mcp/server.ts`, find the `WAITING ON MORAN` block inside SERVER_INSTRUCTIONS (around line 822; it ends with `Local only — nothing reaches Azure DevOps.`). Directly AFTER that block (before `STANDUP BLURB`), insert:

```text
WRAPPING UP THE DAY — when Moran says he's finishing for today
("wrapping up", "done for today", "calling it a day", or similar):
  1. Look at the open sessions (orient, or sprint_snapshot if you need
     ids). If none are open, tell him the day is already closed.
  2. For each open session, ask ONE plain question: finished, or
     pausing until tomorrow? Then close it the normal way — done via
     \`session_end\` with the completed hours, or pause. Every effort
     rule stays exactly as it is.
  3. Before ending the LAST session, write one final \`session_log\`
     progress entry whose \`standupSummary\` ends with where to pick up
     tomorrow ("Next: …"). That line is the first thing
     tomorrow-morning Moran reads.
  4. Confirm the close in ONE short sentence. Nothing more — his
     dashboard's evening card does the showing.
```

Match the surrounding string's formatting exactly: it's a template literal, so backticks inside the text must stay escaped as `\`` (as shown above and as the neighboring blocks do).

- [ ] **Step 2: Verify + commit**

Run: `npx tsc -b` — expected: clean (string edit can't break types, but it proves the template literal wasn't broken).
Run: `npm test` — expected: all green.

```bash
git add mcp/server.ts
git commit -m "feat(wrap): WRAPPING UP instruction block for chats"
```

---

## After all tasks

- Full verification: `npm test` + `npx tsc -b` on the branch result.
- Final whole-branch review per superpowers:subagent-driven-development, then merge per superpowers:finishing-a-development-branch (local merge to main, Moran does not push).
- USER smokes (needs `npm run dev` restart — the 2026-07-05 rule: restart it yourself after the merge — plus a browser hard refresh; the instruction block needs `/exit` + `claude --resume` in work chats):
  1. Evening with activity + 60 quiet minutes → card appears at the top of Daily with the three parts; close button hides it for the day.
  2. With a running session → "Still open" lists it with a running time; with none → "Everything closed. Clean end."
  3. Say "wrapping up" in a work chat → it asks done-or-pause per open session, hours get updated, last note carries a "Next: …" line.
