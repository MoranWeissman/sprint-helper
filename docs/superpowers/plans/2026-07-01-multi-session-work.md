# Multi-Session Work Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let 2-3 parallel Claude Code chats each own their session, show every live task in Focus (main + "Also running" cards, sticky pick), and surface a calm "Needs you" rail card when a background chat waits on Moran or finishes a task.

**Architecture:** Three nullable columns on `sessions` (`cwd`, `waiting_note`, `waiting_since`). The session layer stamps the chat's repo folder at start and exposes pure ownership/waiting helpers. Orient labels each live session with a pre-shipped `repoHint`; `session_log`/`session_end` warn on cross-repo use; a new `session_waiting` MCP tool sets the flag, and the next log/end clears it. The dashboard payload adds `needsYou` + `activeSession.waiting`; the client makes the Focus pick sticky, renders the other live tasks as small cards, and adds a `Needs you` rail card.

**Tech Stack:** TypeScript, better-sqlite3, `@modelcontextprotocol/sdk` + zod, Vite + React 18, Vitest 4 (`npx vitest run`). No new dependencies.

## Global Constraints

- **Local only.** Nothing in this feature writes to Azure DevOps (the existing ADO writes inside `session_log`/`session_end` are untouched).
- **Additive migration only:** three nullable columns on `sessions` via the idempotent `pragma_table_info` pattern already in `server/db.ts:116-146`. Old rows read as null.
- **Ownership vocabulary:** `sessionOwnershipHint(sessionCwd, chatCwd)` returns `'mine' | 'other-repo' | 'unknown'`; `'unknown'` (either side null) NEVER warns and NEVER claims a match.
- **Waiting clears itself:** any `session_log` event and any `session_end` on a session null both `waiting_note` and `waiting_since`. No manual dismiss anywhere.
- **`recentlyFinished` = sessions ended in the last 4 hours whose work item is in a done state NOW.** A pause also ends a session — paused work must never show as finished. `RECENTLY_FINISHED_HOURS = 4`.
- **The cross-repo speed bump is a warning, not a wall** — the tool call still succeeds; the response carries a `cwdWarning` string.
- **Dashboard-only alerts.** No browser popups. Calm styling: no pulsing, reuse existing tokens (`--ink-1/2/3`, `--accent`, `--line`, `--surface-*`), never font-size ≤11px combined with the faintest ink.
- **Plain English** in all UI copy, tool descriptions, and instruction text. No jargon ("slack", "burndown", "WIP", "scope" noun, "velocity", "work item" — say task/story).
- Repo convention: pure logic in `server/*.ts` is unit-tested (in-memory SQLite via the `vi.mock('./db', ...)` pattern in `server/helper-notes.test.ts:1-29`); MCP handlers + vite + React glue are NOT unit-tested (user smokes). Commit per task; `npm test` + `npx tsc -b` green before each commit.
- Reload: server/page changes need a **dashboard restart**; the new tool + instructions need an **MCP reload** (`/exit` + `claude --resume`).
- Line numbers in this plan were verified against HEAD `eccb4c4` but may drift — locate by the quoted anchor code, not the number.

## Shared vocabulary (defined in Tasks 1-2, used throughout)

```ts
// server/sessions.ts
export type SessionOwnership = 'mine' | 'other-repo' | 'unknown';
export function chatCwdBasename(): string | null;                       // basename(process.cwd()) or null
export function sessionOwnershipHint(sessionCwd: string | null, chatCwd: string | null): SessionOwnership;
export function getSession(sessionId: string): Session | null;
export function setSessionWaiting(opts: { sessionId: string; question: string }): Session | null;
export function listRecentlyEnded(hoursBack: number, now?: Date): Session[];
// Session gains: cwd: string | null; waitingNote: string | null; waitingSince: string | null;

// server/needs-you.ts
export const RECENTLY_FINISHED_HOURS = 4;
export interface NeedsYouWaiting { workItemId: number; displayName: string; question: string; waitingSince: string; }
export interface NeedsYouFinished { workItemId: number; displayName: string; summary: string | null; endedAt: string; }
export interface NeedsYouBlock { waiting: NeedsYouWaiting[]; recentlyFinished: NeedsYouFinished[]; }
export function buildNeedsYou(opts: {
  activeSessions: Session[];
  recentlyEnded: Session[];
  titleFor: (workItemId: number) => string | null;
  isDone: (workItemId: number) => boolean;
}): NeedsYouBlock;

// server/orient.ts
export function repoHintFor(sessionCwd: string | null, chatCwd: string | null): string;
// OrientLiveSession gains: cwd: string | null; repoHint: string;
```

---

### Task 1: Session columns + cwd stamp + ownership hint

**Files:**
- Modify: `server/db.ts` (migrate(), after the `helper_notes.work_item_id` block ending ~line 146)
- Modify: `server/sessions.ts`
- Create: `server/sessions.test.ts`

**Interfaces:**
- Produces: the three columns; `Session.cwd/waitingNote/waitingSince`; `chatCwdBasename()`; `sessionOwnershipHint()`; `startSession` accepting optional `cwd` (defaults to `chatCwdBasename()`) and backfilling a null `cwd` on its idempotent path.
- Consumes: existing `getDb()`, `startSession` shape (`server/sessions.ts:85-116`).

- [ ] **Step 1: Write the failing tests**

Create `server/sessions.test.ts` (same in-memory pattern as `server/helper-notes.test.ts`):

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';

// The store reads the live SQLite via getDb(). Swap in a fresh in-memory db
// per test, carrying the final sessions/session_events shape.
const h = vi.hoisted(() => ({ db: { value: null as null | InstanceType<typeof Database> } }));
vi.mock('./db', () => ({ getDb: () => h.db.value }));

import { startSession, sessionOwnershipHint } from './sessions';

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
      session_id      TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
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

describe('startSession cwd stamp', () => {
  it('stores the given cwd on a new session', () => {
    const s = startSession({ workItemId: 1, cwd: 'repo-x' });
    expect(s.cwd).toBe('repo-x');
    expect(s.waitingNote).toBeNull();
    expect(s.waitingSince).toBeNull();
  });

  it('stores null when cwd is explicitly null (unknown launch dir)', () => {
    const s = startSession({ workItemId: 2, cwd: null });
    expect(s.cwd).toBeNull();
  });

  it('is idempotent and backfills a null cwd on the existing open session', () => {
    // Simulate an OLD session row (pre-migration: cwd null).
    h.db.value!
      .prepare(`INSERT INTO sessions (id, work_item_id, started_at, client) VALUES ('old-1', 3, '2026-06-30T08:00:00.000Z', 'claude-code')`)
      .run();
    const s = startSession({ workItemId: 3, cwd: 'repo-x' });
    expect(s.id).toBe('old-1'); // same session, not a new one
    expect(s.cwd).toBe('repo-x'); // learned its home
    const stored = h.db.value!.prepare(`SELECT cwd FROM sessions WHERE id = 'old-1'`).get() as { cwd: string };
    expect(stored.cwd).toBe('repo-x');
  });

  it('does not overwrite an existing cwd on the idempotent path', () => {
    startSession({ workItemId: 4, cwd: 'repo-x' });
    const again = startSession({ workItemId: 4, cwd: 'repo-y' });
    expect(again.cwd).toBe('repo-x');
  });
});

describe('sessionOwnershipHint', () => {
  it("returns 'mine' when both sides match", () => {
    expect(sessionOwnershipHint('repo-x', 'repo-x')).toBe('mine');
  });
  it("returns 'other-repo' when both known and different", () => {
    expect(sessionOwnershipHint('repo-x', 'repo-y')).toBe('other-repo');
  });
  it("returns 'unknown' when either side is null", () => {
    expect(sessionOwnershipHint(null, 'repo-x')).toBe('unknown');
    expect(sessionOwnershipHint('repo-x', null)).toBe('unknown');
    expect(sessionOwnershipHint(null, null)).toBe('unknown');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run server/sessions.test.ts`
Expected: FAIL — `sessionOwnershipHint` not exported; `cwd` not accepted/returned by `startSession`.

- [ ] **Step 3: Add the migration**

In `server/db.ts`, inside `migrate(db)`, after the `helper_notes.work_item_id` block (the last existing idempotent ADD COLUMN):

```ts
  // Idempotent ADD COLUMNs for multi-session work (2026-07-01).
  // cwd: the repo folder name (basename) of the chat that started the session
  //   — with several chats running in parallel, this is how each chat
  //   recognizes its OWN session instead of adopting another chat's.
  // waiting_note / waiting_since: set (via session_waiting) when a chat stops
  //   mid-task to ask Moran a question; the dashboard's "Needs you" card reads
  //   them. Cleared automatically by the session's next log or end.
  const hasSessionCwd = db
    .prepare("SELECT 1 FROM pragma_table_info('sessions') WHERE name = 'cwd'")
    .get();
  if (!hasSessionCwd) {
    db.exec('ALTER TABLE sessions ADD COLUMN cwd TEXT');
  }
  const hasWaitingNote = db
    .prepare("SELECT 1 FROM pragma_table_info('sessions') WHERE name = 'waiting_note'")
    .get();
  if (!hasWaitingNote) {
    db.exec('ALTER TABLE sessions ADD COLUMN waiting_note TEXT');
  }
  const hasWaitingSince = db
    .prepare("SELECT 1 FROM pragma_table_info('sessions') WHERE name = 'waiting_since'")
    .get();
  if (!hasWaitingSince) {
    db.exec('ALTER TABLE sessions ADD COLUMN waiting_since TEXT');
  }
```

- [ ] **Step 4: Extend the row/domain types + mapper in `server/sessions.ts`**

Add `import { basename } from 'node:path';` next to the existing `node:crypto` import. Extend `SessionRow` (`server/sessions.ts:19-26`):

```ts
export interface SessionRow {
  id: string;
  work_item_id: number;
  started_at: string;
  ended_at: string | null;
  client: string;
  summary: string | null;
  cwd: string | null;
  waiting_note: string | null;
  waiting_since: string | null;
}
```

Extend `Session` (`server/sessions.ts:37-44`):

```ts
export interface Session {
  id: string;
  workItemId: number;
  startedAt: string;
  endedAt: string | null;
  client: string;
  summary: string | null;
  /** Repo folder name of the chat that started this session; null on old rows. */
  cwd: string | null;
  /** The question this session's chat is waiting on Moran for; null = not waiting. */
  waitingNote: string | null;
  /** When the chat started waiting (ISO); null = not waiting. */
  waitingSince: string | null;
}
```

Extend `toSession` (`server/sessions.ts:55-64`) with the three mappings:

```ts
    cwd: r.cwd ?? null,
    waitingNote: r.waiting_note ?? null,
    waitingSince: r.waiting_since ?? null,
```

(The `?? null` matters: rows selected before the migration types can come back with `undefined` fields in tests — normalize.)

- [ ] **Step 5: Add `chatCwdBasename` + `sessionOwnershipHint`, and stamp/backfill in `startSession`**

Add above `startSession`:

```ts
/**
 * The repo folder name this MCP process was started in. Each Claude Code chat
 * launches its own server process in the chat's working directory, so this
 * identifies the chat's repo. Null when it can't be determined — matching is
 * skipped for null, never guessed.
 */
export function chatCwdBasename(): string | null {
  try {
    const b = basename(process.cwd());
    return b && b !== '/' && b !== '.' ? b : null;
  } catch {
    return null;
  }
}

export type SessionOwnership = 'mine' | 'other-repo' | 'unknown';

/**
 * Whose session is this, from THIS chat's point of view? 'unknown' (either
 * side null) must never warn and never claim a match.
 */
export function sessionOwnershipHint(
  sessionCwd: string | null,
  chatCwd: string | null,
): SessionOwnership {
  if (sessionCwd == null || chatCwd == null) return 'unknown';
  return sessionCwd === chatCwd ? 'mine' : 'other-repo';
}
```

Replace `startSession` (`server/sessions.ts:85-116`) with:

```ts
export function startSession({
  workItemId,
  client = 'claude-code',
  cwd,
}: {
  workItemId: number;
  client?: string;
  /** Repo folder of the calling chat. Omit to auto-detect from process.cwd(). */
  cwd?: string | null;
}): Session {
  const db = getDb();
  const chatCwd = cwd !== undefined ? cwd : chatCwdBasename();
  const existing = db
    .prepare<[number], SessionRow>(
      `SELECT * FROM sessions
       WHERE work_item_id = ? AND ended_at IS NULL
       ORDER BY started_at DESC LIMIT 1`,
    )
    .get(workItemId);
  if (existing) {
    // Old (pre-migration) sessions learn their home on first touch. Never
    // overwrite a known cwd — the first chat to open the session owns it.
    if (existing.cwd == null && chatCwd != null) {
      db.prepare(`UPDATE sessions SET cwd = ? WHERE id = ?`).run(chatCwd, existing.id);
      return toSession({ ...existing, cwd: chatCwd });
    }
    return toSession(existing);
  }

  const id = randomUUID();
  const startedAt = new Date().toISOString();
  db.prepare(
    `INSERT INTO sessions (id, work_item_id, started_at, client, cwd)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(id, workItemId, startedAt, client, chatCwd);
  return {
    id,
    workItemId,
    startedAt,
    endedAt: null,
    client,
    summary: null,
    cwd: chatCwd,
    waitingNote: null,
    waitingSince: null,
  };
}
```

Also update `endSession`'s early-return object construction (`server/sessions.ts:144`) — it spreads `toSession(row)` so no change needed there; just confirm it compiles.

- [ ] **Step 6: Run tests + typecheck**

Run: `npx vitest run server/sessions.test.ts && npx tsc -b`
Expected: sessions tests PASS; `tsc -b` exit 0. If other files break on the new `Session` fields, they only ADD fields — construction sites (none besides `startSession`) are the only risk; fix by adding the three null fields where TypeScript demands.

- [ ] **Step 7: Run the full suite and commit**

Run: `npm test`
Expected: all green.

```bash
git add server/db.ts server/sessions.ts server/sessions.test.ts
git commit -m "feat(sessions): cwd + waiting columns, chat ownership hint, cwd stamp/backfill"
```

---

### Task 2: Waiting set/clear + recently-ended selector + `getSession`

**Files:**
- Modify: `server/sessions.ts`
- Modify: `server/sessions.test.ts`

**Interfaces:**
- Produces: `setSessionWaiting({sessionId, question}): Session | null`; automatic clearing inside `logEvent` and `endSession`; `listRecentlyEnded(hoursBack, now?): Session[]`; `getSession(sessionId): Session | null`.
- Consumes: Task 1's columns and `toSession`.

- [ ] **Step 1: Write the failing tests**

Add to `server/sessions.test.ts` (extend the import line with the new names):

```ts
import {
  startSession, sessionOwnershipHint, setSessionWaiting, logEvent, endSession,
  listRecentlyEnded, getSession,
} from './sessions';

describe('waiting flag', () => {
  it('sets the question and timestamp on an open session', () => {
    const s = startSession({ workItemId: 10, cwd: 'repo-x' });
    const w = setSessionWaiting({ sessionId: s.id, question: 'Which cluster should I target?' });
    expect(w?.waitingNote).toBe('Which cluster should I target?');
    expect(w?.waitingSince).not.toBeNull();
  });

  it('returns null for a missing or ended session (nothing stored)', () => {
    expect(setSessionWaiting({ sessionId: 'nope', question: 'q' })).toBeNull();
    const s = startSession({ workItemId: 11, cwd: 'repo-x' });
    endSession({ sessionId: s.id });
    expect(setSessionWaiting({ sessionId: s.id, question: 'q' })).toBeNull();
  });

  it('clears on the next session_log event', () => {
    const s = startSession({ workItemId: 12, cwd: 'repo-x' });
    setSessionWaiting({ sessionId: s.id, question: 'q' });
    logEvent({ sessionId: s.id, type: 'progress', text: 'he answered; moving on' });
    expect(getSession(s.id)?.waitingNote).toBeNull();
    expect(getSession(s.id)?.waitingSince).toBeNull();
  });

  it('clears on session end', () => {
    const s = startSession({ workItemId: 13, cwd: 'repo-x' });
    setSessionWaiting({ sessionId: s.id, question: 'q' });
    endSession({ sessionId: s.id, summary: 'done for now' });
    expect(getSession(s.id)?.waitingNote).toBeNull();
    expect(getSession(s.id)?.waitingSince).toBeNull();
  });
});

describe('listRecentlyEnded', () => {
  it('returns sessions ended inside the window and skips older or open ones', () => {
    const now = new Date('2026-07-01T12:00:00.000Z');
    const db = h.db.value!;
    const ins = db.prepare(
      `INSERT INTO sessions (id, work_item_id, started_at, ended_at, client) VALUES (?, ?, ?, ?, 'claude-code')`,
    );
    ins.run('recent', 20, '2026-07-01T09:00:00.000Z', '2026-07-01T10:30:00.000Z'); // 1.5h ago — in
    ins.run('old', 21, '2026-07-01T01:00:00.000Z', '2026-07-01T02:00:00.000Z');    // 10h ago — out
    ins.run('open', 22, '2026-07-01T11:00:00.000Z', null);                          // open — out
    const got = listRecentlyEnded(4, now);
    expect(got.map(s => s.id)).toEqual(['recent']);
  });
});
```

Note: `h` is the hoisted db holder from Task 1's test file — the new describe blocks live in the same file and reuse it.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run server/sessions.test.ts`
Expected: FAIL — `setSessionWaiting`, `listRecentlyEnded`, `getSession` not exported.

- [ ] **Step 3: Implement**

In `server/sessions.ts`, add after `endSession`:

```ts
/**
 * Flag an open session as waiting on Moran (the chat stopped mid-task to ask
 * him a question). The dashboard's "Needs you" card reads this. Returns null
 * for a missing or already-ended session — nothing is stored. Cleared
 * automatically by the session's next logEvent or endSession.
 */
export function setSessionWaiting({
  sessionId,
  question,
}: {
  sessionId: string;
  question: string;
}): Session | null {
  const db = getDb();
  const row = db
    .prepare<[string], SessionRow>(`SELECT * FROM sessions WHERE id = ?`)
    .get(sessionId);
  if (!row || row.ended_at != null) return null;
  const since = new Date().toISOString();
  db.prepare(`UPDATE sessions SET waiting_note = ?, waiting_since = ? WHERE id = ?`).run(
    question,
    since,
    sessionId,
  );
  return toSession({ ...row, waiting_note: question, waiting_since: since });
}

/** The chat is active again — whatever it was waiting on is stale. */
function clearSessionWaiting(sessionId: string): void {
  getDb()
    .prepare(`UPDATE sessions SET waiting_note = NULL, waiting_since = NULL WHERE id = ?`)
    .run(sessionId);
}

export function getSession(sessionId: string): Session | null {
  const row = getDb()
    .prepare<[string], SessionRow>(`SELECT * FROM sessions WHERE id = ?`)
    .get(sessionId);
  return row ? toSession(row) : null;
}

/**
 * Sessions that ENDED within the last `hoursBack` hours, newest first. NOTE:
 * a pause also ends a session — callers deciding "finished" must additionally
 * check the work item's real state (see server/needs-you.ts).
 */
export function listRecentlyEnded(hoursBack: number, now: Date = new Date()): Session[] {
  const cutoff = new Date(now.getTime() - hoursBack * 3_600_000).toISOString();
  return getDb()
    .prepare<[string], SessionRow>(
      `SELECT * FROM sessions
       WHERE ended_at IS NOT NULL AND datetime(ended_at) >= datetime(?)
       ORDER BY datetime(ended_at) DESC`,
    )
    .all(cutoff)
    .map(toSession);
}
```

Wire the clearing:
- In `logEvent` (`server/sessions.ts:155-192`), right after the successful INSERT (before the `return` object), add:

```ts
  clearSessionWaiting(sessionId);
```

- In `endSession` (`server/sessions.ts:122-145`), change the UPDATE statement to also null the waiting fields:

```ts
  db.prepare(
    `UPDATE sessions SET ended_at = ?, summary = ?, waiting_note = NULL, waiting_since = NULL WHERE id = ?`,
  ).run(endedAt, summary ?? row.summary, sessionId);
```

(Note `endSession` calls `logEvent` when a summary is present — harmless double clear.)

- [ ] **Step 4: Run tests + typecheck + full suite**

Run: `npx vitest run server/sessions.test.ts && npx tsc -b && npm test`
Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add server/sessions.ts server/sessions.test.ts
git commit -m "feat(sessions): waiting flag with auto-clear + recently-ended selector"
```

---

### Task 3: Orient — `cwd` + pre-shipped `repoHint` on live sessions

**Files:**
- Modify: `server/orient.ts`
- Modify: `server/orient.test.ts`

**Interfaces:**
- Consumes: `sessionOwnershipHint`, `chatCwdBasename` from Task 1; `Session.cwd`.
- Produces: `repoHintFor(sessionCwd, chatCwd): string` (pure, exported); `OrientLiveSession.cwd: string | null` + `OrientLiveSession.repoHint: string`.

- [ ] **Step 1: Write the failing test**

Add to `server/orient.test.ts`:

```ts
import { repoHintFor } from './orient';

describe('repoHintFor', () => {
  it('says it matches this chat when repos agree', () => {
    expect(repoHintFor('sprint-helper', 'sprint-helper')).toBe(
      'started from `sprint-helper` — matches this chat',
    );
  });
  it("marks a different repo as another chat's work", () => {
    expect(repoHintFor('devex-infrastructure', 'sprint-helper')).toBe(
      "started from `devex-infrastructure` — a different chat's work",
    );
  });
  it('names the repo without a claim when this chat is unknown', () => {
    expect(repoHintFor('devex-infrastructure', null)).toBe(
      'started from `devex-infrastructure`',
    );
  });
  it('says repo unknown for old sessions with no cwd', () => {
    expect(repoHintFor(null, 'sprint-helper')).toBe('repo unknown (older session)');
    expect(repoHintFor(null, null)).toBe('repo unknown (older session)');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run server/orient.test.ts`
Expected: FAIL — `repoHintFor` not exported.

- [ ] **Step 3: Implement**

In `server/orient.ts`:

1. Extend the sessions import (`server/orient.ts:17`):

```ts
import {
  chatCwdBasename,
  getLastEventTimestampMap,
  listActiveSessions,
  sessionOwnershipHint,
  type SessionRow,
} from './sessions';
```

2. Add two fields to `OrientLiveSession` (`server/orient.ts:26-63`), after `parentStoryDisplayName`:

```ts
  /** Repo folder the session's chat was started in; null on older sessions. */
  cwd: string | null;
  /**
   * Pre-shipped plain-English read on whose session this is, compared against
   * THIS chat's repo. Echo verbatim — don't assemble your own phrasing. See
   * SERVER_INSTRUCTIONS → PARALLEL CHATS.
   */
  repoHint: string;
```

3. Add the pure helper near `sessionReminderFor` (`server/orient.ts:162-165`):

```ts
/**
 * Plain-English label for a live session's home repo, from this chat's point
 * of view. 'unknown' sides never warn and never claim a match.
 */
export function repoHintFor(sessionCwd: string | null, chatCwd: string | null): string {
  const ownership = sessionOwnershipHint(sessionCwd, chatCwd);
  if (ownership === 'mine') return `started from \`${sessionCwd}\` — matches this chat`;
  if (ownership === 'other-repo') return `started from \`${sessionCwd}\` — a different chat's work`;
  return sessionCwd ? `started from \`${sessionCwd}\`` : 'repo unknown (older session)';
}
```

4. In `buildOrientPacket`, before the `liveNow` map (`server/orient.ts:235-254`), compute the chat's repo once, and add the two fields to the mapped object:

```ts
  const chatCwd = chatCwdBasename();
```

and inside the returned object of the `.map`:

```ts
      cwd: s.cwd,
      repoHint: repoHintFor(s.cwd, chatCwd),
```

- [ ] **Step 4: Run tests + typecheck + full suite**

Run: `npx vitest run server/orient.test.ts && npx tsc -b && npm test`
Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add server/orient.ts server/orient.test.ts
git commit -m "feat(orient): live sessions carry cwd + pre-shipped repoHint"
```

---

### Task 4: MCP — `session_waiting` tool, cross-repo speed bump, instruction blocks

**Files:**
- Modify: `mcp/server.ts`

**Interfaces:**
- Consumes: `setSessionWaiting`, `getSession`, `chatCwdBasename`, `sessionOwnershipHint`, `Session` from Tasks 1-2; the file's existing `jsonResult`/`errorResult` helpers and `invalidateDashboardCache`.
- Produces: the `session_waiting` tool; `cwdWarning` field on `session_log`/`session_end` responses; two SERVER_INSTRUCTIONS blocks.

No unit tests (MCP-handler glue by repo convention) — user smokes. `npx tsc -b` + `npm test` still gate the commit.

- [ ] **Step 1: Extend the sessions import**

In `mcp/server.ts`, find the existing import from `../server/sessions.js` (it already brings `startSession`, `endSession`, `logEvent`, `listActiveSessions`, `listEventsForSession`, `isSessionEventType`) and add: `chatCwdBasename`, `getSession`, `sessionOwnershipHint`, `setSessionWaiting`, and the type `Session` (match the file's `.js`-extension import style).

- [ ] **Step 2: Add the cross-repo warning helper**

Near `SESSION_LOG_REQUIRED_AFTER_MINUTES` (`mcp/server.ts:2146`), add:

```ts
/**
 * Cross-repo speed bump (not a wall): when a chat logs against a session that
 * a chat in a DIFFERENT repo started, warn — but let the call through.
 * 'unknown' (old sessions, odd launch dirs) never warns.
 */
function buildCwdWarning(session: Session | null): string | null {
  if (!session) return null;
  if (sessionOwnershipHint(session.cwd, chatCwdBasename()) !== 'other-repo') return null;
  return `⚠️ This session was started from \`${session.cwd}\` — a different chat's work. Make sure you're in the right chat before logging here.`;
}
```

- [ ] **Step 3: Wire the warning into `session_log` and `session_end`**

In the `session_log` handler (`mcp/server.ts:2075-2141`): right before `const event = logEvent(...)` (line ~2095) add:

```ts
    const cwdWarning = buildCwdWarning(getSession(sessionId));
```

(The read must happen BEFORE `logEvent`, which clears the waiting flag — same row, and reading first also keeps the warning based on the pre-call state.) Then add `...(cwdWarning ? { cwdWarning } : {}),` to EVERY `jsonResult({...})` in this handler (there are three: the no-remaining path at ~2113, the applied path at ~2121, and the error path at ~2131).

In the `session_end` handler (`mcp/server.ts:2173-2286`): right after the `haveSummary` line (~2182) add:

```ts
    const cwdWarning = buildCwdWarning(getSession(sessionId));
```

and add `...(cwdWarning ? { cwdWarning } : {}),` to the done-path `jsonResult` (~2261) and both pause-path `jsonResult`s (~2275 and ~2282).

- [ ] **Step 4: Register `session_waiting`**

Immediately after the `session_end` registration closes (`mcp/server.ts:2287`, before the "Helper's notes" section divider), add:

```ts
server.registerTool(
  'session_waiting',
  {
    title: "Flag that you're waiting on Moran",
    description:
      "Call this right BEFORE you stop mid-task to ask Moran a question, so his dashboard shows the task is waiting for him (the 'Needs you' card). Pass the open sessionId and the question as ONE short plain-English sentence — write it like you'd text him, no file paths or tool names. The flag clears itself on this session's next session_log or session_end; no cleanup call needed. Local only — never writes to Azure DevOps. Don't call it for the final 'is this task done?' close-out question at session end — session_end itself covers that moment.",
    inputSchema: {
      sessionId: z.string().describe('Session id returned by session_start.'),
      question: z
        .string()
        .min(1)
        .describe('The question Moran needs to answer. One short plain sentence.'),
    },
  },
  async ({ sessionId, question }) => {
    const session = setSessionWaiting({ sessionId, question });
    if (!session) {
      return errorResult(
        `No open session matched ${sessionId} — nothing was flagged. The 'Needs you' card only tracks open sessions.`,
      );
    }
    // The dashboard reads waiting_note/waiting_since via /api/dashboard.
    invalidateDashboardCache();
    return jsonResult({ waiting: true, question, sessionId: session.id });
  },
);
```

- [ ] **Step 5: Add the two SERVER_INSTRUCTIONS blocks**

Both go inside the big SERVER_INSTRUCTIONS template literal — escape embedded backticks as \` exactly like the neighboring text.

**Block A — PARALLEL CHATS.** Place it right after the STALE LIVE SESSION section (the block around `mcp/server.ts:367-400` that explains `liveNow` and sessionId). Text:

```
PARALLEL CHATS — several sessions can be live at once, one per chat:
  - Every \`orient\` liveNow entry carries \`repoHint\` — echo it, don't
    rephrase. A session that "matches this chat" is probably this chat's
    own work; a "different chat's work" session belongs to another window.
  - Pick up ONLY a session whose repo matches this chat. If MORE than one
    live session matches, ask Moran by task title which one this chat is
    on. Never assume.
  - Never pick up, log against, or close a different chat's session
    without asking Moran first. \`session_log\` / \`session_end\` return a
    \`cwdWarning\` when you cross that line — if you see one, stop and
    check with him before continuing.
  - Never switch this chat to a different session mid-conversation unless
    Moran asks for it.
```

**Block B — WAITING ON MORAN.** Place it right after the session-log cadence section (the block around `mcp/server.ts:736-795` that says when to write session_log entries). Text:

```
WAITING ON MORAN — his dashboard can show that a chat needs him:
  - When you are about to STOP mid-task because you need Moran's answer
    (a real question, not the session_end close-out), call
    \`session_waiting\` with the open sessionId and the question as one
    short plain sentence. His dashboard then shows the task under
    "Needs you" until you're working again.
  - No cleanup: your next \`session_log\` or \`session_end\` clears it.
  - Local only — nothing reaches Azure DevOps.
```

- [ ] **Step 6: Typecheck + full suite**

Run: `npx tsc -b && npm test`
Expected: exit 0; all tests green (no behavior under test changed).

- [ ] **Step 7: Commit**

```bash
git add mcp/server.ts
git commit -m "feat(mcp): session_waiting tool, cross-repo cwdWarning, parallel-chat instructions"
```

---

### Task 5: Dashboard payload — `needsYou` block + `activeSession.waiting` + client type mirrors

**Files:**
- Create: `server/needs-you.ts`
- Create: `server/needs-you.test.ts`
- Modify: `server/dashboard.ts`
- Modify: `src/lib/api.ts`

**Interfaces:**
- Consumes: `Session` (with `waitingNote`/`waitingSince`), `listActiveSessions`, `listRecentlyEnded` from Tasks 1-2; `DONE_STATES` set (`server/dashboard.ts:213`).
- Produces: `buildNeedsYou(...)`, `NeedsYouBlock`, `RECENTLY_FINISHED_HOURS` (shapes in the shared vocabulary above); `DashboardPayload.needsYou: NeedsYouBlock`; `activeSession` projection gains `waiting: boolean`; client mirrors `ApiNeedsYou*` + `ApiActiveSession.waiting`.

- [ ] **Step 1: Write the failing tests**

Create `server/needs-you.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { buildNeedsYou } from './needs-you';
import type { Session } from './sessions';

function sess(over: Partial<Session>): Session {
  return {
    id: 's1',
    workItemId: 1,
    startedAt: '2026-07-01T08:00:00.000Z',
    endedAt: null,
    client: 'claude-code',
    summary: null,
    cwd: 'repo-x',
    waitingNote: null,
    waitingSince: null,
    ...over,
  };
}

describe('buildNeedsYou', () => {
  it('lists waiting sessions with question and pre-formatted displayName', () => {
    const got = buildNeedsYou({
      activeSessions: [
        sess({ workItemId: 10, waitingNote: 'Which cluster?', waitingSince: '2026-07-01T09:00:00.000Z' }),
        sess({ id: 's2', workItemId: 11 }), // live but not waiting
      ],
      recentlyEnded: [],
      titleFor: id => (id === 10 ? 'Deploy ArgoCD' : null),
      isDone: () => false,
    });
    expect(got.waiting).toEqual([
      {
        workItemId: 10,
        displayName: '**Deploy ArgoCD** (#10)',
        question: 'Which cluster?',
        waitingSince: '2026-07-01T09:00:00.000Z',
      },
    ]);
  });

  it('keeps only ended sessions whose task is really done (a pause is not a finish)', () => {
    const got = buildNeedsYou({
      activeSessions: [],
      recentlyEnded: [
        sess({ id: 'e1', workItemId: 20, endedAt: '2026-07-01T10:00:00.000Z', summary: 'shipped it' }),
        sess({ id: 'e2', workItemId: 21, endedAt: '2026-07-01T10:30:00.000Z', summary: 'paused for lunch' }),
      ],
      titleFor: id => (id === 20 ? 'Fix Datadog values' : 'Paused task'),
      isDone: id => id === 20,
    });
    expect(got.recentlyFinished).toEqual([
      {
        workItemId: 20,
        displayName: '**Fix Datadog values** (#20)',
        summary: 'shipped it',
        endedAt: '2026-07-01T10:00:00.000Z',
      },
    ]);
  });

  it('falls back to a bare #id displayName when the title is unknown', () => {
    const got = buildNeedsYou({
      activeSessions: [sess({ workItemId: 30, waitingNote: 'q', waitingSince: '2026-07-01T09:00:00.000Z' })],
      recentlyEnded: [],
      titleFor: () => null,
      isDone: () => false,
    });
    expect(got.waiting[0].displayName).toBe('#30');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run server/needs-you.test.ts`
Expected: FAIL — `server/needs-you.ts` doesn't exist.

- [ ] **Step 3: Implement `server/needs-you.ts`**

```ts
/**
 * The "Needs you" block for the dashboard's right rail: which live chats are
 * waiting on Moran's answer, and which tasks other chats finished recently.
 * Pure — all inputs injected, no DB or clock access here.
 */
import type { Session } from './sessions';

/** How long a finished task stays on the card before aging out. */
export const RECENTLY_FINISHED_HOURS = 4;

export interface NeedsYouWaiting {
  workItemId: number;
  /** Pre-formatted `**title** (#id)`, or `#id` when the title is unknown. */
  displayName: string;
  question: string;
  waitingSince: string;
}

export interface NeedsYouFinished {
  workItemId: number;
  displayName: string;
  summary: string | null;
  endedAt: string;
}

export interface NeedsYouBlock {
  waiting: NeedsYouWaiting[];
  recentlyFinished: NeedsYouFinished[];
}

export function buildNeedsYou(opts: {
  activeSessions: Session[];
  /** Sessions ended within the window (see listRecentlyEnded). */
  recentlyEnded: Session[];
  titleFor: (workItemId: number) => string | null;
  /** True when the work item's REAL state is a done state right now. */
  isDone: (workItemId: number) => boolean;
}): NeedsYouBlock {
  const displayName = (id: number) => {
    const title = opts.titleFor(id);
    return title ? `**${title}** (#${id})` : `#${id}`;
  };

  const waiting = opts.activeSessions
    .filter(s => s.waitingSince != null && s.waitingNote != null)
    .map(s => ({
      workItemId: s.workItemId,
      displayName: displayName(s.workItemId),
      question: s.waitingNote as string,
      waitingSince: s.waitingSince as string,
    }));

  // A pause also ends a session — only tasks that are REALLY done now count
  // as finished. Everything else ages out silently.
  const recentlyFinished = opts.recentlyEnded
    .filter(s => s.endedAt != null && opts.isDone(s.workItemId))
    .map(s => ({
      workItemId: s.workItemId,
      displayName: displayName(s.workItemId),
      summary: s.summary,
      endedAt: s.endedAt as string,
    }));

  return { waiting, recentlyFinished };
}
```

- [ ] **Step 4: Run the needs-you tests**

Run: `npx vitest run server/needs-you.test.ts`
Expected: PASS.

- [ ] **Step 5: Wire into `server/dashboard.ts`**

1. Imports: add `listActiveSessions`, `listRecentlyEnded` to the existing `./sessions` import, and:

```ts
import { buildNeedsYou, RECENTLY_FINISHED_HOURS, type NeedsYouBlock } from './needs-you';
```

2. `DashboardPayload` interface: after the `carryForward` field (`server/dashboard.ts:208`), add:

```ts
  /**
   * Which chats are waiting on Moran + which tasks finished in the last few
   * hours. Drives the "Needs you" rail card. Always present (empty lists when
   * quiet).
   */
  needsYou: NeedsYouBlock;
```

3. In `buildDashboard`, where the payload object is assembled (the block containing `activeSessions: activeSessions.size` at `server/dashboard.ts:525`), build the block from data already in scope. The items fetched for the sprint are what `projectWorkItem` runs over; build title/state lookups from that same source list (the array iterated at `server/dashboard.ts:389` — verify its variable name, likely `items` or similar):

```ts
  // "Needs you": waiting chats + recently finished tasks. Titles/states come
  // from the fetched sprint items; a session on an item outside this sprint
  // falls back to a bare #id (waiting still shows; finished is dropped since
  // we can't confirm it's done).
  const titleByIdForNeedsYou = new Map<number, string>();
  const stateByIdForNeedsYou = new Map<number, string>();
  for (const w of items) {
    titleByIdForNeedsYou.set(Number(w.id), w.title);
    stateByIdForNeedsYou.set(Number(w.id), w.state);
  }
  const needsYou = buildNeedsYou({
    activeSessions: listActiveSessions(),
    recentlyEnded: listRecentlyEnded(RECENTLY_FINISHED_HOURS),
    titleFor: id => titleByIdForNeedsYou.get(id) ?? null,
    isDone: id => DONE_STATES.has(stateByIdForNeedsYou.get(id) ?? ''),
  });
```

and add `needsYou,` to the returned payload object. Reuse an existing title/state map if one is already in scope at that point (don't build a duplicate — check for the `taskMeta`/`titleById` structures first; the code above is the fallback shape).

4. The empty/no-sprint payload default (the object containing `activeSessions: 0` at `server/dashboard.ts:361`): add

```ts
      needsYou: { waiting: [], recentlyFinished: [] },
```

5. `projectWorkItem` (`server/dashboard.ts:744-788`): change the `activeSession` line (781) to:

```ts
    activeSession: session
      ? { id: session.id, startedAt: session.startedAt, waiting: session.waitingSince != null }
      : undefined,
```

and extend the corresponding `activeSession` type on the projected item interface (`server/dashboard.ts:86`) to `{ id: string; startedAt: string; waiting: boolean }`.

- [ ] **Step 6: Mirror on the client (`src/lib/api.ts`)**

1. `ApiActiveSession` (`src/lib/api.ts:24-27`):

```ts
export interface ApiActiveSession {
  id: string;
  startedAt: string;
  /** True when this session's chat is stopped, waiting on Moran's answer. */
  waiting?: boolean;
}
```

2. Add next to the other Api types (near `ApiHelperNote`):

```ts
export interface ApiNeedsYouWaiting {
  workItemId: number;
  displayName: string;
  question: string;
  waitingSince: string;
}

export interface ApiNeedsYouFinished {
  workItemId: number;
  displayName: string;
  summary: string | null;
  endedAt: string;
}

export interface ApiNeedsYou {
  waiting: ApiNeedsYouWaiting[];
  recentlyFinished: ApiNeedsYouFinished[];
}
```

3. In the payload interface that mirrors `DashboardPayload` (the one containing `activeSessions: number;` at `src/lib/api.ts:203` and a `carryForward` field), add after `carryForward`:

```ts
  needsYou: ApiNeedsYou;
```

- [ ] **Step 7: Typecheck + full suite**

Run: `npx tsc -b && npm test`
Expected: exit 0, all green (the client only ADDED fields; nothing consumes them until Task 6).

- [ ] **Step 8: Commit**

```bash
git add server/needs-you.ts server/needs-you.test.ts server/dashboard.ts src/lib/api.ts
git commit -m "feat(dashboard): needsYou payload block + waiting flag on active sessions"
```

---

### Task 6: Client — sticky Focus pick, "Also running" cards, "Needs you" rail card

**Files:**
- Modify: `src/components/Dashboard.tsx`
- Modify: `src/styles/dashboard.css`

**Interfaces:**
- Consumes: `ApiNeedsYou`, `ApiActiveSession.waiting`, `payload.needsYou` from Task 5; existing `liveItems` (`Dashboard.tsx:140-152`), `focalId` state (`:157`), `R21Focus` props (`:820-835`), the `r22-rail-card` pattern (`:1421` / `:1567`).
- Produces: localStorage key `sh.focus.pick`; `R21Focus` prop change `secondary/onPromoteSecondary` → `others: ApiWorkItem[]` / `onPromote(id: string)`; new `RailNeedsYou` component.

No unit tests (React glue by repo convention) — user smokes. `npx tsc -b` + `npm test` gate the commit.

- [ ] **Step 1: Make the Focus pick sticky**

In `Dashboard.tsx`, replace the `focalId` state (`:157`) with a localStorage-seeded version plus a persisting setter:

```tsx
  // The Focus pick survives refreshes — Focus must never swap tasks on its
  // own while the picked task is still live (multi-session rule).
  const [focalId, setFocalIdState] = useState<string | null>(() => {
    if (typeof window === 'undefined') return null;
    return window.localStorage.getItem('sh.focus.pick');
  });
  const setFocalId = (id: string | null) => {
    setFocalIdState(id);
    if (id == null) window.localStorage.removeItem('sh.focus.pick');
    else window.localStorage.setItem('sh.focus.pick', id);
  };
```

Extend the existing reset effect (`:163-168`) to also drop a pick whose session ended while others are still live:

```tsx
  useEffect(() => {
    if (liveItems.length === 0) {
      setShowBoard(false);
      setFocalId(null);
      return;
    }
    // The picked task stopped being live (its session ended) but others are
    // still going — clear the stale pick so the fallback (newest live) rules.
    if (focalId != null && !liveItems.some(w => w.id === focalId)) {
      setFocalId(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveItems, focalId]);
```

(If the file doesn't use eslint disable comments, match its local style; `focalTask`'s existing `?? liveItems[0]` fallback already covers the in-between render.)

- [ ] **Step 2: Replace the single `secondary` with the full "Also running" list**

In the Dashboard body, replace `secondaryLive` (`:173-176`) with:

```tsx
  const otherLive = useMemo(
    () => liveItems.filter(w => !focalTask || w.id !== focalTask.id),
    [liveItems, focalTask],
  );
```

Update the `R21Focus` call site (`:290-299`): replace the `secondary={secondaryLive}` and `onPromoteSecondary={...}` props with:

```tsx
                  others={otherLive}
                  onPromote={id => setFocalId(id)}
```

Update `R21Focus`'s props (`:820-835`): replace `secondary: ApiWorkItem | null;` and `onPromoteSecondary: () => void;` with:

```tsx
  others: ApiWorkItem[];
  onPromote: (id: string) => void;
```

(and the matching destructuring). Replace the old bottom block (`:989-995`, the `{secondary && (<button className="r21-also" ...>)}`) with a strip rendered right AFTER the `</section>` that closes `r21-focal-current` (`:942`):

```tsx
      {others.length > 0 && (
        <section className="r21-also-live" aria-label="Also running">
          <div className="r21-also-live-head">
            <span className="r21-also-live-label">Also running</span>
            <span className="r21-also-live-count">{others.length}</span>
          </div>
          <div className="r21-also-live-row">
            {others.map(w => (
              <button
                key={w.id}
                type="button"
                className={`r21-also-card${w.activeSession?.waiting ? ' is-waiting' : ''}`}
                onClick={() => onPromote(w.id)}
                title="Make this the focus instead"
              >
                <span className="r21-also-card-title">{w.title}</span>
                <span className="r21-also-card-meta">
                  {w.parent && <span className="r21-also-card-story">{w.parent.title}</span>}
                  {w.activeSession && (
                    <span className="r21-also-card-since">started {fmtEventStamp(w.activeSession.startedAt)}</span>
                  )}
                </span>
                {w.activeSession?.waiting && (
                  <span className="r21-also-card-waiting">waiting for you</span>
                )}
              </button>
            ))}
          </div>
        </section>
      )}
```

Also mark the MAIN task when IT is the one waiting — in the `r21-focal-current-head` (`:908-912`), after the `r21-live-pill`:

```tsx
          {task.activeSession?.waiting && <span className="r21-waiting-pill">waiting for you</span>}
```

- [ ] **Step 3: Add the `RailNeedsYou` card**

Add the component near `RailNotes` (`:1567`). It needs a tiny age formatter — add beside it:

```tsx
function ageShort(iso: string, now: Date): string {
  const min = Math.max(0, Math.floor((now.getTime() - new Date(iso).getTime()) / 60000));
  if (min < 60) return `${min}m`;
  return `${Math.floor(min / 60)}h ${min % 60}m`;
}

// displayName arrives as **title** (#id) — render the title plain.
function plainTitle(displayName: string): string {
  return displayName.replace(/\*\*/g, '').replace(/\s*\(#\d+\)\s*$/, '');
}

function RailNeedsYou({ needsYou, now }: { needsYou: ApiNeedsYou; now: Date }) {
  if (needsYou.waiting.length === 0 && needsYou.recentlyFinished.length === 0) return null;
  return (
    <section className="r22-rail-card r22-rail-needs-you" aria-label="Needs you">
      <div className="r22-rail-card-head">
        <span className="r22-rail-card-label">Needs you</span>
        {needsYou.waiting.length > 0 && (
          <span className="r22-rail-card-meta">{needsYou.waiting.length} waiting</span>
        )}
      </div>
      <ul className="needsyou-list">
        {needsYou.waiting.map(w => (
          <li key={`w-${w.workItemId}-${w.waitingSince}`} className="needsyou-row is-waiting">
            <span className="needsyou-title">{plainTitle(w.displayName)}</span>
            <span className="needsyou-question">{w.question}</span>
            <span className="needsyou-age">waiting {ageShort(w.waitingSince, now)}</span>
          </li>
        ))}
        {needsYou.recentlyFinished.map(f => (
          <li key={`f-${f.workItemId}-${f.endedAt}`} className="needsyou-row is-finished">
            <span className="needsyou-title">{plainTitle(f.displayName)}</span>
            {f.summary && <span className="needsyou-summary">{f.summary}</span>}
            <span className="needsyou-age">finished {ageShort(f.endedAt, now)} ago</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
```

Render it ABOVE `RailNotes` inside the rail (`:1372`):

```tsx
          <RailNeedsYou needsYou={needsYou} now={now} />
          <RailNotes notes={helperNotes} onRefresh={onRefresh} />
```

Thread the props: the rail lives in a component that already receives dashboard data (`helperNotes` reaches `RailNotes` there) — pass `needsYou={data.needsYou}` and the existing `now` value down the same path. Import `ApiNeedsYou` in the api-imports at the top of Dashboard.tsx.

- [ ] **Step 4: CSS**

In `src/styles/dashboard.css`, add near the other `r21-focal-*` rules (reuse the file's real tokens; if a fallback value is used elsewhere for a token, copy that convention):

```css
/* Also-running strip — other live tasks under the main focal card. Calm. */
.r21-also-live { margin-top: 14px; }
.r21-also-live-head { display: flex; align-items: baseline; gap: 8px; margin-bottom: 8px; }
.r21-also-live-label { font-size: 12px; letter-spacing: 0.08em; text-transform: uppercase; color: var(--ink-2); }
.r21-also-live-count { font-size: 12px; color: var(--ink-2); }
.r21-also-live-row { display: flex; flex-wrap: wrap; gap: 10px; }
.r21-also-card {
  display: flex; flex-direction: column; align-items: flex-start; gap: 4px;
  background: var(--surface-2); border: 1px solid var(--line); border-radius: 10px;
  padding: 10px 14px; cursor: pointer; text-align: left; max-width: 320px;
}
.r21-also-card:hover { border-color: var(--accent); }
.r21-also-card.is-waiting { border-left: 3px solid var(--accent); }
.r21-also-card-title { font-size: 14px; color: var(--ink-1); }
.r21-also-card-meta { display: flex; gap: 8px; font-size: 12px; color: var(--ink-2); }
.r21-also-card-waiting { font-size: 12px; font-weight: 600; color: var(--accent); text-transform: uppercase; letter-spacing: 0.04em; }
.r21-waiting-pill { font-size: 12px; font-weight: 600; color: var(--accent); text-transform: uppercase; letter-spacing: 0.04em; }

/* Needs-you rail card rows */
.needsyou-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 10px; }
.needsyou-row { display: flex; flex-direction: column; gap: 2px; padding: 8px 10px; border-radius: 8px; background: var(--surface-2); border: 1px solid var(--line); }
.needsyou-row.is-waiting { border-left: 3px solid var(--accent); }
.needsyou-title { font-size: 13px; font-weight: 600; color: var(--ink-1); }
.needsyou-question { font-size: 13px; color: var(--ink-1); }
.needsyou-summary { font-size: 13px; color: var(--ink-2); }
.needsyou-age { font-size: 12px; color: var(--ink-2); }
```

If the old `.r21-also` rule (the removed single button) exists and is now unused, remove it.

- [ ] **Step 5: Typecheck + full suite**

Run: `npx tsc -b && npm test`
Expected: exit 0, all green — this is the whole feature's green gate.

- [ ] **Step 6: Commit**

```bash
git add src/components/Dashboard.tsx src/styles/dashboard.css
git commit -m "feat(focus): sticky pick + also-running cards + needs-you rail card"
```

---

## Manual Smoke (flag for Moran — needs dashboard restart + MCP reload in EACH chat)

**Smoke 0 first — the cwd assumption:** after MCP reload, start a session from a repo chat, then check the row: `sqlite3 ~/.sprint-helper/data.db "SELECT id, work_item_id, cwd FROM sessions WHERE ended_at IS NULL"`. `cwd` must be that repo's folder name. If it's wrong, STOP and report — piece 1 rests on it.

1. Two chats in two repos, a session each → each chat's greeting names its own task via `repoHint`; neither adopts the other's.
2. Focus shows both: main + one "Also running" card; tap swaps; refresh keeps the pick.
3. From the background chat: assistant calls `session_waiting` before asking → within ~15s the "Needs you" card shows the task + question + "waiting Xm", and the small card gets the mark. Answer in that chat → next `session_log` clears it.
4. Cross-repo `session_log` (deliberate) → response carries the `cwdWarning` line.
5. Finish a task in one chat (`session_end` done) → shows under finished for a while; PAUSE a task → does NOT show as finished.
6. Board and Azure DevOps unchanged by any of the new surfaces.

## Self-Review Notes

- **Spec coverage:** columns+stamp+ownership → Task 1; waiting set/clear + recently-ended → Task 2; orient repoHint → Task 3; tool + speed bump + instruction blocks → Task 4; payload + mirrors → Task 5; sticky pick + strip + rail card → Task 6. Out-of-scope items (grid, popups, chat registry, stop-detection) are named in the spec, not built.
- **Type consistency:** `Session.cwd/waitingNote/waitingSince` (T1/T2) feed `repoHintFor` (T3), `buildCwdWarning` (T4), `buildNeedsYou` (T5); `NeedsYouBlock` ↔ `ApiNeedsYou` field-for-field; `activeSession.waiting` server (T5 step 5) ↔ `ApiActiveSession.waiting` (T5 step 6) ↔ usage (T6).
- **Placeholder scan:** every code step carries complete code; the two spots where a local variable name must be verified in situ (`items` in Task 5 step 5; rail data-threading in Task 6 step 3) say exactly what to look for and what shape to produce.
- **Order matters:** Tasks build strictly on earlier exports; `tsc -b` is expected green after EVERY task (no cross-task seam this time — client fields are additive).
