# Session-Logging-Gap Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop a Claude Code session from working a whole task and recording nothing — by nudging at session start, refusing a no-notes close, and warning when a session was never opened.

**Architecture:** Three MCP-server-side moves. (1) `orient` packet gains a `sessionReminder` string set only when no session is open. (2) `session_end`'s catch-up check stops accepting a bare summary as a substitute for a real log on a long session — the decision is extracted into a pure, unit-tested function. (3) `session_end` returns a plain "untracked session" warning when no open session matched but the agent was clearly closing out work. No client or dashboard change.

**Tech Stack:** TypeScript, `@modelcontextprotocol/sdk`, Vitest 4 (`vitest run`). Pure logic lives in small leaf modules under `server/` and is unit-tested; MCP-handler glue in `mcp/server.ts` is not unit-tested by repo convention (covered by live smoke).

## Global Constraints

- **Option 1 only.** Do NOT auto-open a session on `orient` (don't guess the work item). Do NOT retroactively create a session at close (that was Option 2, rejected). Do NOT add a fourth "log as you go" paragraph to SERVER_INSTRUCTIONS — the rule is already there three times.
- **Un-deferring tools is out of scope** — that is the Claude Code client's behavior, not the server's lever.
- **Plain English in all user-facing copy** (error messages, reminder text, instruction line). Short sentences. No jargon ("slack", "burndown", "WIP", etc.).
- **`SESSION_LOG_REQUIRED_AFTER_MINUTES = 45`** is the existing threshold constant in `mcp/server.ts` — reuse it, do not introduce a second.
- **Substantive log** means a `session_log` event of type `progress`, `blocker`, or `decision` (matches the existing `hadSubstantiveLog` definition at `mcp/server.ts:2142`).
- Commit per task. Run `npm test` (and `npx tsc -b` where types change) before each commit.

---

### Task 1: `orient` nudges when no session is open (Move 1)

Add a `sessionReminder` field to the orient packet, computed from how many sessions are open, plus a one-line pointer in SERVER_INSTRUCTIONS telling the assistant to surface it.

**Files:**
- Modify: `server/orient.ts` (add `sessionReminderFor` helper near `plainCapacitySummary` ~line 133; add `sessionReminder` to the `OrientPacket` interface ~line 82; set it in the returned object ~line 291)
- Create: `server/orient.test.ts`
- Modify: `mcp/server.ts` (one bullet in the OPENING GREETING block, ~line 134)

**Interfaces:**
- Produces: `sessionReminderFor(liveSessionCount: number): string | null` — returns the reminder string when `liveSessionCount === 0`, else `null`.
- Produces: `OrientPacket.sessionReminder: string | null` — consumed only by the assistant reading the packet (no other code depends on it).

- [ ] **Step 1: Write the failing test**

Create `server/orient.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { sessionReminderFor } from './orient';

describe('sessionReminderFor', () => {
  it('returns a reminder when no session is open', () => {
    const msg = sessionReminderFor(0);
    expect(msg).not.toBeNull();
    expect(msg).toContain('session_start');
  });

  it('returns null when a session is already open', () => {
    expect(sessionReminderFor(1)).toBeNull();
  });

  it('returns null when several sessions are open', () => {
    expect(sessionReminderFor(3)).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run server/orient.test.ts`
Expected: FAIL — `sessionReminderFor` is not exported from `./orient`.

- [ ] **Step 3: Add the `sessionReminderFor` helper**

In `server/orient.ts`, directly below the `plainCapacitySummary` function (ends ~line 147), add:

```ts
/**
 * One-line nudge for the assistant when NO work session is open. Naming
 * `session_start` here is also what prompts the assistant to reach for that
 * (possibly deferred) tool. Returns null when a session is already open —
 * don't nag. See SERVER_INSTRUCTIONS → OPENING GREETING.
 */
export function sessionReminderFor(liveSessionCount: number): string | null {
  if (liveSessionCount > 0) return null;
  return "You don't have a work session open. When you start working a task, call session_start on it so your progress gets recorded.";
}
```

- [ ] **Step 4: Add the field to `OrientPacket`**

In `server/orient.ts`, inside the `OrientPacket` interface, add after the `liveNow: OrientLiveSession[];` line (~line 93):

```ts
  /**
   * One-line plain-English nudge to open a session, set ONLY when no session
   * is open (liveNow is empty). Null when a session is already open. The
   * assistant surfaces this in its greeting. See SERVER_INSTRUCTIONS →
   * OPENING GREETING.
   */
  sessionReminder: string | null;
```

- [ ] **Step 5: Set the field in the returned packet**

In `server/orient.ts`, in the object returned by `buildOrientPacket`, add right after the `liveNow,` line (~line 300):

```ts
    sessionReminder: sessionReminderFor(liveNow.length),
```

- [ ] **Step 6: Run the test + typecheck to verify they pass**

Run: `npx vitest run server/orient.test.ts && npx tsc -b`
Expected: test PASS (3 passing); `tsc -b` clean (no errors).

- [ ] **Step 7: Add the SERVER_INSTRUCTIONS pointer**

In `mcp/server.ts`, in the OPENING GREETING bullet list, insert a new bullet immediately before the `- end by leading him to action` bullet (currently ~line 134):

```
  - if \`sessionReminder\` is set, surface it — there's no session open, so
    remind Moran (and yourself) to call session_start on the task before
    working, so the work gets recorded;
```

- [ ] **Step 8: Typecheck and commit**

Run: `npx tsc -b`
Expected: clean.

```bash
git add server/orient.ts server/orient.test.ts mcp/server.ts
git commit -m "feat(orient): sessionReminder nudge when no session is open"
```

---

### Task 2: `session_end` close-time check — a bare summary no longer substitutes (Move 2)

Extract the catch-up-log decision into a pure, unit-tested function, then change the `session_end` handler to drop the summary escape and use it. After this, a session open past the threshold needs at least one real `session_log` entry to close — a closing summary alone won't pass.

**Files:**
- Create: `server/session-close.ts`
- Create: `server/session-close.test.ts`
- Modify: `mcp/server.ts` (Rule 1 block, ~lines 2142-2155)

**Interfaces:**
- Produces: `catchUpLogRequired(opts: { minutesOpen: number; hadSubstantiveLog: boolean; thresholdMinutes: number }): boolean` — true when the session has run at/over the threshold AND no substantive log exists. Consumed by `mcp/server.ts`'s `session_end` handler.
- Consumes (from existing code): `hadSubstantiveLog` (boolean, `mcp/server.ts:2142`), `minutesOpen` (number, `mcp/server.ts:2145`), `SESSION_LOG_REQUIRED_AFTER_MINUTES` (number, `mcp/server.ts:2100`).

- [ ] **Step 1: Write the failing test**

Create `server/session-close.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { catchUpLogRequired } from './session-close';

const THRESHOLD = 45;

describe('catchUpLogRequired', () => {
  it('requires a log when the session ran long with no substantive log', () => {
    expect(
      catchUpLogRequired({ minutesOpen: 60, hadSubstantiveLog: false, thresholdMinutes: THRESHOLD }),
    ).toBe(true);
  });

  it('does not require a log when a substantive log already exists', () => {
    expect(
      catchUpLogRequired({ minutesOpen: 60, hadSubstantiveLog: true, thresholdMinutes: THRESHOLD }),
    ).toBe(false);
  });

  it('does not require a log for a short session with no log', () => {
    expect(
      catchUpLogRequired({ minutesOpen: 10, hadSubstantiveLog: false, thresholdMinutes: THRESHOLD }),
    ).toBe(false);
  });

  it('requires a log exactly at the threshold', () => {
    expect(
      catchUpLogRequired({ minutesOpen: 45, hadSubstantiveLog: false, thresholdMinutes: THRESHOLD }),
    ).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run server/session-close.test.ts`
Expected: FAIL — cannot find module `./session-close`.

- [ ] **Step 3: Create the pure module**

Create `server/session-close.ts`:

```ts
/**
 * Pure decisions for closing a Claude Code session. Kept out of mcp/server.ts
 * so the logic can be unit-tested without standing up the MCP server.
 */

/**
 * Should session_end refuse to close because the session ran a real stretch
 * but recorded nothing about what happened?
 *
 * A "substantive log" is a session_log entry of type progress / blocker /
 * decision. A closing summary does NOT count — that's the loophole this
 * closes: an agent that batches everything into one closing summary used to
 * sail through. Short sessions (under the threshold) are never required to
 * log, so a quick one-step task isn't forced to log twice.
 */
export function catchUpLogRequired(opts: {
  minutesOpen: number;
  hadSubstantiveLog: boolean;
  thresholdMinutes: number;
}): boolean {
  return opts.minutesOpen >= opts.thresholdMinutes && !opts.hadSubstantiveLog;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run server/session-close.test.ts`
Expected: PASS (4 passing).

- [ ] **Step 5: Wire it into the `session_end` handler**

In `mcp/server.ts`, add the import alongside the other `./server/...` imports near the top of the file (find the existing block of `import { ... } from './...'` / `from '../server/...'` lines and match its style — the project imports server modules with a relative path; mirror the path used by neighbours such as the `listEventsForSession` / `listActiveSessions` imports):

```ts
import { catchUpLogRequired } from '../server/session-close.js';
```

> Note for implementer: match the EXACT relative path + extension convention already used in `mcp/server.ts` for other `server/` imports (check whether neighbours use `.js`, no extension, or `../server/`). Do not invent a new style.

Then replace the Rule 1 block. The current code (`mcp/server.ts` ~2146-2155) is:

```ts
      const haveSummary = summary != null && summary.trim() !== '';

      // Rule 1 (catch-up log): a session that ran a real stretch but recorded
      // nothing about what happened shouldn't close silently. Satisfiable by a
      // session_log progress/blocker/decision entry OR a non-empty summary here.
      if (minutesOpen >= SESSION_LOG_REQUIRED_AFTER_MINUTES && !hadSubstantiveLog && !haveSummary) {
        return errorResult(
          `This session has been open about ${Math.round(minutesOpen)} minutes but nothing was logged about what happened. Before closing, either call session_log with a 'progress' entry describing what got done, or pass a one-line \`summary\` to session_end. (This catches the case where sub-agents did the work and it never got written down.)`,
        );
      }
```

Replace it with (note: the `const haveSummary` line is REMOVED from here — it moves to handler top in Task 3; for now just delete the Rule 1 dependence on it):

```ts
      // Rule 1 (catch-up log): a session that ran a real stretch but recorded
      // nothing about what happened shouldn't close silently. A closing summary
      // alone is NOT enough on a long session — it needs at least one real
      // session_log entry (progress / blocker / decision).
      if (
        catchUpLogRequired({
          minutesOpen,
          hadSubstantiveLog,
          thresholdMinutes: SESSION_LOG_REQUIRED_AFTER_MINUTES,
        })
      ) {
        return errorResult(
          `This session has been open about ${Math.round(minutesOpen)} minutes but nothing was logged about what got done. A closing summary on its own isn't enough on a session this long — call session_log with at least one 'progress' entry naming what happened, then call session_end again. (This is what catches the case where sub-agents did the work and it never got written down.)`,
        );
      }
```

> The `const haveSummary = ...` line is still referenced nowhere else in the handler YET — Task 3 re-introduces it at the top of the handler for Move 3. To keep this task self-contained and the build green, leave `haveSummary` defined where it is for now ONLY IF something still uses it; since Rule 1 no longer uses it and Rule 2 never did, deleting it here would leave an unused-variable error is NOT a risk (it's a `const`, unused `const` is a TS6133 error under this repo's strict config). Therefore: DELETE the `const haveSummary = summary != null && summary.trim() !== '';` line in this task. Task 3 re-adds it at the handler top where Move 3 uses it.

- [ ] **Step 6: Run full test suite + typecheck**

Run: `npm test && npx tsc -b`
Expected: all tests PASS (including the new `session-close.test.ts`); `tsc -b` clean (no unused-variable error from the removed `haveSummary`).

- [ ] **Step 7: Commit**

```bash
git add server/session-close.ts server/session-close.test.ts mcp/server.ts
git commit -m "fix(session_end): a closing summary no longer substitutes for a real log on a long session"
```

---

### Task 3: `session_end` warns when there was no open session at all (Move 3)

When `session_end` is called but no open session matches the id AND the agent was clearly closing out work (it passed a `summary` or `done`), return a plain warning that the session went untracked and nothing was recorded — instead of the bare "Session not found". This is a message only; no write, no retroactive session.

**Files:**
- Modify: `mcp/server.ts` (re-add `haveSummary` at handler top ~line 2127; branch the `if (!session)` path ~line 2171)

**Interfaces:**
- Consumes: `endSession({ sessionId, summary })` returns `null` when no open session matched (existing behavior, `mcp/server.ts:2170`).
- Consumes: `done` (boolean | undefined) and `summary` (string | undefined) handler args.

- [ ] **Step 1: Re-add `haveSummary` at the top of the handler**

In `mcp/server.ts`, inside the `session_end` handler, immediately after the opening `done && completedHoursAfter === undefined` guard block closes (right before the `// ---- Pre-close speed bumps` comment, ~line 2133), add:

```ts
    // Computed once up here: used both by the no-open-session warning below
    // (Move 3) and saved as the closing summary when the session does close.
    const haveSummary = summary != null && summary.trim() !== '';
```

- [ ] **Step 2: Branch the no-session path**

In `mcp/server.ts`, find (~line 2170):

```ts
    const session = endSession({ sessionId, summary });
    if (!session) return errorResult(`Session not found: ${sessionId}`);
```

Replace with:

```ts
    const session = endSession({ sessionId, summary });
    if (!session) {
      // No open session matched. If the agent was clearly closing out work
      // (it passed a summary or done=true), this is the "never opened one"
      // case — warn plainly so Moran sees the session went untracked. This is
      // a message only: we do NOT retroactively create a session (Option 1).
      if (haveSummary || done) {
        return errorResult(
          `No open session matched ${sessionId}, so nothing was recorded against the task during this chat — it went untracked. If work happened here, next time call session_start on the task before working so it gets logged. (Nothing was written to Azure DevOps.)`,
        );
      }
      return errorResult(`Session not found: ${sessionId}`);
    }
```

- [ ] **Step 3: Typecheck + full test suite**

Run: `npx tsc -b && npm test`
Expected: `tsc -b` clean (the re-added `haveSummary` is now used by the warning branch — no unused-variable error); all tests PASS.

- [ ] **Step 4: Commit**

```bash
git add mcp/server.ts
git commit -m "feat(session_end): warn when a session was never opened and work went untracked"
```

---

## Manual Smoke (flag for Moran — requires MCP reload)

These changes are all MCP-side; they take effect only after `/exit` + `claude --resume` in a chat (instructions + tools load at session start). After reload, verify:

1. **Untracked warning** — start a chat, do NOT open a session, then call `session_end` with a summary → see the "went untracked, nothing recorded" warning.
2. **No-summary-escape** — open a session, let it run 45+ minutes (or fake it), log nothing, try to close with only a `summary` → refused until one `progress` entry is logged.
3. **Orient reminder** — call `orient` with no session open → greeting carries the "open a session" nudge; with a session open → no nudge.

## Self-Review Notes

- **Spec coverage:** Move 1 → Task 1 (field + helper + instruction line). Move 2 → Task 2 (pure `catchUpLogRequired` + loophole removal). Move 3 → Task 3 (untracked warning). Out-of-scope items (auto-open, Option 2, un-defer, fourth paragraph) are in Global Constraints and not built.
- **Type consistency:** `sessionReminderFor(number): string | null` and `catchUpLogRequired({minutesOpen, hadSubstantiveLog, thresholdMinutes}): boolean` are referenced identically at definition and call sites.
- **`haveSummary` lifecycle:** removed from Rule 1 in Task 2 (would be unused → TS6133), re-added at handler top in Task 3 where Move 3 uses it. Tasks 2 and 3 must land together for a green build between them — if executing one at a time, expect Task 2's `tsc -b` to be green only because the line is deleted, and Task 3 to re-introduce it used. (No interim broken state: Task 2 deletes it, Task 3 adds it back used.)
