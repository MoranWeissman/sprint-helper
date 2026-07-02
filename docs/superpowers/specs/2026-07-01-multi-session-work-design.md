# Multi-session work — design

**Date:** 2026-07-01
**Status:** approved in chat (brainstorm complete)

## Problem

Sprint-helper was designed around ONE running task at a time. Moran now routinely runs
2-3 Claude Code chats in parallel, each on a different task. Two things break:

1. **A chat grabs the wrong task.** Sessions carry no trace of which chat started them
   (`sessions.client` is always the literal `'claude-code'` — `server/db.ts:68-75`), and
   `orient`'s docs even invite a chat to resume "a session opened by a different chat"
   (`mcp/server.ts:366-374`). A chat can adopt — or switch to — another chat's task.
2. **The Focus view flip-flops.** The focal pick is client-side "newest session wins"
   (`liveItems` sort + `focalTask` fallback, `src/components/Dashboard.tsx:140-172`),
   and the pick (`focalId`) is plain `useState`, not persisted. Every new session or
   page refresh can silently swap what Focus shows. The second live task is already
   computed (`secondaryLive`, `Dashboard.tsx:173-176`) but never shown as a list.

And one thing is missing entirely: when a *background* chat stops to ask Moran a
question, nothing tells him. The chat waits silently while he works elsewhere.

## What we're building

Three pieces on one shared idea — **a session remembers whose it is, and the dashboard
stops pretending there's only one**:

1. **Chat↔session binding (plumbing).** Record which repo folder a chat was started in
   on the session row. Chats pick up only their own repo's session, ask by title when
   ambiguous, and get a code-level warning when touching another repo's session.
2. **Multi-live Focus.** Focus shows every live task: the main one big (Moran's pick,
   sticky across refreshes), the others as small updating "Also running" cards. Tap a
   small card to make it the main one.
3. **"Needs you" rail card.** A chat that stops mid-task to ask Moran a question first
   tells sprint-helper. The dashboard shows the task, the question, and how long it has
   waited; the alert clears itself when that chat gets back to work. The same card
   quietly lists tasks other chats finished in the last few hours.

All local — nothing here writes to Azure DevOps ([[feedback-ado-owns-truth]]).

## Decisions locked in brainstorm

1. **Dashboard-only alerts.** No browser/macOS popups, no pulsing. Calm surfaces that
   are visible when Moran looks ([[user-ui-preferences]]).
2. **One main focal task + small live cards** — not an even split. Keeps the
   one-focal-point rule while showing the truth that other work is live.
3. **Parked (out of scope now, revisit only if piece 2 proves insufficient):** the
   select-up-to-X split-grid view; browser popups.
4. **Honest limit accepted:** the "waiting for you" signal depends on the assistant
   calling a tool before it stops. It is prose-enforced (SERVER_INSTRUCTIONS + tool
   description); there is no way to detect a stopped chat from outside. Works most of
   the time, not every time — Moran knows.

## Architecture

### Data model — three nullable columns on `sessions` (additive migration)

```sql
ALTER TABLE sessions ADD COLUMN cwd TEXT;            -- repo folder basename, e.g. 'sprint-helper'
ALTER TABLE sessions ADD COLUMN waiting_note TEXT;   -- the question the chat is waiting on
ALTER TABLE sessions ADD COLUMN waiting_since TEXT;  -- ISO timestamp; null = not waiting
```

Follow the existing additive-migration pattern in `server/db.ts` (nullable columns,
old rows read fine as null). `SessionRow`/`Session` mirrors in `server/sessions.ts`
gain `cwd`, `waitingNote`, `waitingSince`.

- `startSession` stamps `cwd` with `path.basename(process.cwd())`. Each Claude Code
  chat launches its own MCP server process in the chat's working directory, so
  `process.cwd()` identifies the chat's repo. Defensive: if the basename is empty or
  `/`, store null (matching is skipped for null).
  ⚠️ **Smoke-verify this assumption first** (it underpins piece 1): after MCP reload,
  start a session from a repo chat and confirm the row's `cwd` is that repo's folder
  name, not some fixed path. If it ever proves wrong, the fallback design is an
  explicit optional `repo` argument on `session_start` — but don't build that now.
- The idempotent path in `startSession` (open session for the same work item is
  returned unchanged) also backfills `cwd` if the existing row has null (old sessions
  learn their home on first touch).

### Piece 1 — chat↔session binding

**Pure helper (unit-tested), `server/sessions.ts` or a small new `server/session-owner.ts`:**

```ts
sessionOwnershipHint(sessionCwd: string | null, chatCwd: string | null):
  'mine' | 'other-repo' | 'unknown'
```

`'mine'` when both non-null and equal; `'other-repo'` when both non-null and
different; `'unknown'` when either is null.

**Orient (`server/orient.ts` + `mcp/server.ts`):** each `liveNow` entry gains:
- `cwd: string | null`
- `repoHint: string` — a pre-shipped plain-English string (Moran's echo-API-strings
  rule), e.g. ``started from `sprint-helper` — matches this chat`` /
  ``started from `devex-infrastructure` — a different chat's work`` /
  `repo unknown (older session)`.

**SERVER_INSTRUCTIONS rules (short block near the OPENING GREETING / STALE LIVE
SESSION sections):**
- A live session whose repo matches this chat's cwd is *probably yours* — say so in
  the greeting.
- If more than one live session matches this repo, ASK Moran by task title. Never
  assume.
- Never pick up or close a live session from a different repo without asking.
- Never switch this chat to a different session mid-conversation without Moran asking.

**Code speed bump (not a wall — [[feedback-enforce-in-code]]):** `session_log` and
`session_end` compare the target session's `cwd` to this process's cwd basename. On
`'other-repo'`, the tool still works but the response is prefixed with a plain warning:
"⚠️ This session was started from `<repo>` — a different chat's work. Make sure you're
in the right chat before logging here." (`'unknown'` stays silent.)

### Piece 2 — multi-live Focus (client-side only)

All in `src/components/Dashboard.tsx` + `src/styles/dashboard.css`; the payload
already carries per-item `activeSession` (`server/dashboard.ts:781`) and refreshes
every 15s (`src/lib/api.ts:270`).

- **Sticky pick:** persist `focalId` to localStorage (key `sh.focus.pick`, same
  pattern as `sh.side.collapsed`). On load/refresh: use the saved id if it's still in
  `liveItems`; else fall back to newest-live as today; clear the key when its session
  ends. Result: Focus never swaps on its own while the picked task is live.
- **"Also running" strip:** in `R21Focus`, next to the existing "Currently running"
  card (`r21-focal-current`, `Dashboard.tsx:907-923`), render one small card per
  OTHER live task (replaces the barely-used single `secondaryLive`): task title, story
  title, time since the session started, and a "waiting for you" mark when flagged
  (piece 3). Click → `setFocalId(id)` + persist. CSS namespace `r21-also-*`. Calm:
  small cards use real ink tokens, no pulsing, honor no-small-and-gray
  ([[feedback-no-small-and-gray]]).
- **One live task → page looks exactly like today** (strip renders nothing).

### Piece 3 — "Needs you" card + waiting flag

**New MCP tool `session_waiting`** (registered in `mcp/server.ts`, thin glue):

```
session_waiting({ sessionId: string, question: string }) -> { ok, taskDisplayName }
```

Sets `waiting_note` + `waiting_since` on the open session. Errors plainly if the
session isn't open. Tool description tells the assistant WHEN: "call this right
before you stop mid-task to ask Moran a question — so his dashboard shows he's
needed. Keep `question` to one short plain sentence."

**Clearing (automatic, no UI dismiss):** any `session_log` on that session and
`session_end` null both waiting fields — the chat resumed working, so the alert is
stale. Pure helper `clearWaiting` folded into the existing update paths.

**SERVER_INSTRUCTIONS:** one short block — before ending a turn that stops mid-task
on a question to Moran, call `session_waiting`; after he answers and work resumes,
the next `session_log` clears it by itself.

**Dashboard payload (`server/dashboard.ts`):** top-level `needsYou` block:

```ts
needsYou: {
  waiting: Array<{ workItemId, displayName, question, waitingSince }>,   // open sessions with waiting_since
  recentlyFinished: Array<{ workItemId, displayName, summary, endedAt }> // sessions ended in the last 4h
}
```

`RECENTLY_FINISHED_HOURS = 4`, pure selector unit-tested with injected `now`.
⚠️ A session also ends when Moran PAUSES a task — an ended session alone does not
mean "finished". `recentlyFinished` therefore keeps only sessions whose work item is
in a done-bucket state right now (the dashboard build already knows each item's
state); paused work never shows as finished. The per-item `activeSession` projection
also gains `waiting: boolean` so Focus cards can show the mark.

**UI:** a `NeedsYou` rail card ABOVE the notes card, following the existing
`r22-rail-card` pattern (`Dashboard.tsx:1567-1596`): each waiting row = task title +
the question + "waiting 12m"; each finished row = task title + one-line summary,
quieter. Card hidden entirely when both lists are empty. Waiting rows also tint the
matching live card in Focus ("waiting for you" chip). No dismiss buttons — waiting
clears when the chat resumes; finished rows age out at 4h.

## Data flow

1. Chat A (repo `x`) starts a session → row stamped `cwd:'x'`. Chat B (repo `y`)
   likewise. Orient in each chat labels which live session is its own.
2. Both tasks show in Focus: Moran's pick big, the other as a small updating card.
   His pick survives refreshes; it changes only when he taps.
3. Chat B hits a question → calls `session_waiting` → within 15s the dashboard shows
   the "Needs you" card + the waiting chip on B's small card.
4. Moran answers in chat B → B's next `session_log` clears the flag → alert gone on
   the next refresh.
5. B finishes (`session_end` done) → task appears under "finished" in the card for
   4h, then ages out. Azure DevOps untouched by any of this (session_end's existing
   ADO behavior unchanged).

## Error handling

- `cwd` null (old sessions, odd launch dirs) → ownership `'unknown'`: no warning, no
  match claim; orient says "repo unknown".
- `session_waiting` on an ended/missing session → plain error, nothing stored.
- Saved Focus pick points at a task that's no longer live → fall back to newest-live,
  clear the stored key. No crash on empty `liveItems` (today's behavior kept).
- Two chats in the SAME repo → cwd can't distinguish them; instructions require
  ask-by-title. The speed-bump warning only fires cross-repo (never a false positive
  after `/exit` + resume, which spawns a new process in the same repo).
- Payload consumers older than the schema (stale tab) → new fields are additive;
  missing `needsYou` renders nothing.

## Testing

- Unit (`server/sessions.test.ts` or new files): `sessionOwnershipHint` all three
  outcomes; `startSession` stamps + backfills `cwd`; waiting set/cleared by
  log/end; `recentlyFinished` selector respects the 4h window (injected `now`);
  additive migration reads old rows as nulls.
- MCP handlers (`session_waiting`, orient `repoHint`, warnings) are glue → USER
  smokes, per repo convention.
- Client (Focus pick persistence, strip, rail card) → USER smokes.
- Live smoke (needs dashboard restart + MCP reload in each chat): two chats, two
  repos, two sessions → orient labels each correctly; Focus shows both, pick sticks
  across refresh; `session_waiting` from the background chat surfaces in the rail
  card within 15s and clears after the next log; cross-repo `session_log` shows the
  warning line. **First smoke of all: confirm `cwd` stamps as the repo folder name.**

## Out of scope (named so they're decisions, not omissions)

- **Split-grid view of X sessions** — parked until multi-live Focus proves
  insufficient.
- **Browser/macOS popup notifications** — dashboard only, by choice.
- **Detecting a stopped chat from outside** — impossible from the MCP side; the
  waiting flag is prose-enforced.
- **A chat registry / heartbeats / per-chat ids** — rejected as heavier than needed;
  cwd + ask-by-title covers today's reality (YAGNI).
- **Auto-ending ghost sessions** — unchanged; existing done-state guard in
  `liveItems` stays as is.
- **ADO writes** — none.

## Files

- `server/db.ts` — 3 additive nullable columns on `sessions`.
- `server/sessions.ts` — row mirrors; `cwd` stamp/backfill in `startSession`;
  waiting set/clear helpers; `sessionOwnershipHint`; recently-finished selector.
- `server/orient.ts` — `liveNow` entries gain `cwd` + `repoHint`.
- `server/dashboard.ts` — `needsYou` block; `activeSession.waiting` projection.
- `mcp/server.ts` — `session_waiting` tool; cwd speed-bump in `session_log` /
  `session_end`; SERVER_INSTRUCTIONS blocks (binding rules + waiting rule).
- `src/lib/api.ts` — type mirrors (`needsYou`, `activeSession.waiting`).
- `src/components/Dashboard.tsx` — sticky `focalId` (localStorage), "Also running"
  strip in `R21Focus`, `NeedsYou` rail card.
- `src/styles/dashboard.css` — `r21-also-*`, needs-you card, waiting chip.

## Note on reload

Server/page changes need a **dashboard dev-server restart**. The new tool, the
warnings, and the instruction blocks need an **MCP reload** (`/exit` +
`claude --resume`) in each open chat. Both, for the full flow.

## Related memory

[[feedback-ado-owns-truth]] (local only), [[feedback-enforce-in-code]] (speed bump
not wall), [[user-ui-preferences]] / [[feedback-no-small-and-gray]] (calm cards),
[[feedback-daily-view-patterns]] (Focus auto-morph stays), [[feedback-claude-code-workflow]]
(resumes/compacts — binding must survive process restarts via cwd, not memory),
[[project-build-state]].
