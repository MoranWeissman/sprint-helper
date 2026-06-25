# Closing the mid-session logging gap — design

**Date:** 2026-06-25
**Status:** approved in chat (Option 1 path)

## Problem

A session worked a full task and recorded nothing between `orient` (start) and
`session_end` (close). When asked why, the session blamed (1) no instruction to log as it
goes, (2) `session_log` being a deferred tool, (3) its own batch-at-the-end habit.

## What the code actually shows (the session's self-diagnosis is mostly wrong)

- **Claim 1 is false.** SERVER_INSTRUCTIONS already has a `CHECKPOINT LOGGING` section AND a
  `THE SUB-AGENT TRAP` section that quotes the exact "I'll consolidate at session_end → WRONG"
  excuse. The rule exists three times over (those sections + the 45-min nudge + the close-time
  check). A fourth copy won't help an agent ignoring three.
- **Claim 2 is not sprint-helper's to fix.** Deferred-vs-eager tool loading is decided by the
  **Claude Code client**, not the MCP server. The server registers all tools the same way; it
  has no switch to force eager loading. So "un-defer session_log" is OUT OF SCOPE — building it
  would build nothing. What the server CAN do is make `orient` name `session_start` so the agent
  reaches for it.
- **The real structural hole the session missed:** the whole safety net hangs off
  `session_start`. The 45-min nudge (`checkStaleLogNudge`) only scans `WHERE ended_at IS NULL`
  — open sessions. The close-time catch-up check only runs `if (openSession)`. This session went
  `orient → work → session_end` and **never called `session_start`**, so there was no open
  session for any net to grab.
- **A loophole in the existing close-time check:** Rule 1 in `session_end` (mcp/server.ts
  ~2151) passes when there's a substantive log **OR a non-empty `summary`**. So an agent that
  dumps everything into one closing summary — exactly this failure — sails through. The check
  meant to catch "nothing recorded" accepts "everything batched at the end."

## Decision (Option 1: respect "don't guess the work item"; act at the two moments we control)

We will NOT auto-open a session on `orient` (Moran's call — a session opened on the wrong story
is worse than none). sprint-helper is passive: between `orient` and `session_end` it gets no
turns unless the agent calls a tool. So all three moves land at `orient` (start) and
`session_end` (close).

### Move 1 — `orient` nudges when no session is open

Add `sessionReminder: string | null` to the orient packet. Set it when `liveNow.length === 0`
(no open session): a one-line plain-English reminder, e.g. *"You don't have a work session open.
When you start working a task, call session_start on it so your progress gets recorded."* Null
when a session is already open (don't nag). SERVER_INSTRUCTIONS opening-ritual gets ONE line:
"If `orient.sessionReminder` is set, surface it — tell Moran (and yourself) to open a session
before working." Naming `session_start` in the reminder is also what nudges the agent to load
the (possibly deferred) tool.

### Move 2 — `session_end` close-time check: a bare summary no longer substitutes

In the Rule 1 block: when a session has been open past `SESSION_LOG_REQUIRED_AFTER_MINUTES`,
require at least one real `session_log` entry (`progress` | `blocker` | `decision`) to close.
Remove `!haveSummary` from the satisfying condition — a closing summary is still saved, but it
no longer excuses the absence of any checkpoint on a long session. The error message tells the
agent to log at least one progress entry naming what happened, then call session_end again.

Keep it proportionate: short sessions (under the threshold) are unaffected — a quick task that
genuinely had one step shouldn't be forced to log twice.

### Move 3 — `session_end` warns when there was no open session at all

Today, `session_end` with an unknown/closed `sessionId` finds `openSession` undefined, skips
all checks, then `endSession` returns null → `errorResult("Session not found")`. That's fine
when it's a stale id, but it says nothing about the "never opened one" case. Add: if no open
session matches AND the agent is clearly closing out work (it passed a `summary` or `done`),
return a plain warning that the session went untracked and nothing was recorded — so Moran sees
it happened, exactly like he caught it this time. This is a message, not a write (Option 1: no
retroactive session creation — that was Option 2, deliberately not chosen).

## Out of scope (named so they're decisions, not omissions)

- **Un-deferring tools** — client-side, not the server's lever (see above).
- **Auto-opening a session on orient** — Moran chose not to guess the work item.
- **Retroactively creating a session at close (Option 2)** — softer net, but it invents a
  record and collapses the timeline; only add if Move 1 proves insufficient in use.
- **A fourth "log as you go" paragraph in SERVER_INSTRUCTIONS** — the rule is already there
  three times; more prose is the trap, not the fix.

## Files

- `server/orient.ts` — `sessionReminder` field + compute it (`liveNow.length === 0`).
- `server/orient.test.ts` (new or existing) — reminder set when no session, null when one open.
- `mcp/server.ts` — SERVER_INSTRUCTIONS one-line pointer to `sessionReminder`; `session_end`
  Rule 1 tightened (drop the summary escape); `session_end` no-open-session warning.
- No client/dashboard change — this is all MCP-side (the agent's behavior, not Moran's UI).

## Testing

- Unit: `sessionReminder` logic in orient (pure-ish — derives from liveNow count).
- The `session_end` Rule-1 change is inline MCP-handler glue (not unit-tested in this repo by
  convention) → covered by the description + a careful manual reasoning in the plan, and Moran's
  live smoke. If feasible, extract the "may this session close?" decision into a tiny pure
  function and unit-test THAT (preferred — turns glue into tested logic).
- Live smoke (Moran, after MCP reload): start a chat, don't open a session, work, try to
  `session_end` → see the untracked warning; open a session, work 45+ min with no logs, try to
  close with only a summary → refused until one progress entry; orient with no open session →
  greeting carries the reminder.

## Note on reload

All MCP-side. Takes effect only after `/exit` + `claude --resume` in a chat (instructions +
tools load at session start).
