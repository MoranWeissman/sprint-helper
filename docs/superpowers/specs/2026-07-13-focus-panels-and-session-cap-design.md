# Focus panels + parallel-session cap — design

**Date:** 2026-07-13
**Status:** Approved in brainstorm (Moran, 2026-07-13). Live-pain fix — takes priority over the OSS roadmap order.

## The problem

Moran opens Focus and finds several tasks running in parallel that he didn't consciously choose to watch. He clicks between them, loses track of which one he's actually working, and it triggers ADHD overwhelm. Two root causes:

1. **No cap.** `session_start` never counts open sessions — parallel sessions are unbounded today. Sessions pile up silently (a chat left open, a subagent batch, a forgotten pause) and none of them age out of view.
2. **Focus shows one task but the others are always there** (the "Also running" strip), with no way to deliberately watch a chosen few side by side, and no at-a-glance signal for which ones have gone quiet.

## What we're building

Two separate things — kept separate on purpose:

- **A cap on how many tasks RUN at once** (enforced in the MCP server).
- **A chooser for how many you WATCH in Focus** (1–4 panels, you pick which tasks).

### Decisions locked in the brainstorm

- Focus **opens on one task** (calm landing, unchanged from today). A control lets Moran split into 2, 3, or 4 panels on purpose.
- **Moran picks each panel himself** — he chooses the count AND which running tasks fill the panels. Nothing auto-swaps under him. Tasks not in a panel keep running, shown in the small "Also running" strip that already exists.
- **Each panel shows one of three plain states:**
  - **working** — active session, recent activity.
  - **waiting** — the chat paused to ask Moran something (`activeSession.waiting`, already in the payload).
  - **stale** 🌙 — no activity for a while (idle past the threshold). This is the "don't let a session go quiet without me noticing" signal Moran asked for — the moon finds him instead of him hunting.
- **Cap = a setting, default 4** (env → settings → default, same layer as workday hours). Ready for the OSS config work.
- **At the 5th session: hard refusal, name the four.** `session_start` refuses and replies in plain words: "You already have 4 running — X, Y, Z, W. Pause or finish one first." No auto-pause, no soft warning. Enforce, don't nag.

## Architecture

Three pieces, each testable on its own.

### 1. Session cap (server + MCP)

- **New config knob** `maxParallelSessions` in the config module: env `SH_MAX_PARALLEL_SESSIONS` → settings key `max_parallel_sessions` → default `4`. Pure resolver, unit-tested. Parse guard: a non-positive or non-numeric value falls back to the default (never 0 = "can't start anything").
- **Pure predicate** `parallelCapExceeded({ activeSessions, workItemId, max }): boolean` in a leaf module (e.g. `server/session-cap.ts`). Returns true only when starting a NEW session would exceed the cap. Reopening/continuing an item that ALREADY has an open session is never blocked (idempotent `startSession` returns the existing one — the cap only bites genuinely new items). Unit-tested: at cap with a new item → true; at cap re-touching an open item → false; under cap → false.
- **Wire into `session_start` handler** (`mcp/server.ts:2051`): before `startSession`, if `parallelCapExceeded`, return a plain-English refusal that NAMES the running tasks (reuse each session's `displayName` via the task titles — same `**title** (#id)` echo rule). No DB write. Message follows the plain-English + names-before-numbers rules.
  - The other two `startSession` call sites — `workitem_block`/`workitem_unblock` (`:1669`, `:1722`) — are NOT capped. A block can come from any window and must always succeed; blocking doesn't open a Focus panel. (Consistent with the multi-session final-review decision that those pass `cwd:null`.)
- **SERVER_INSTRUCTIONS**: one short block telling the assistant the cap exists and that hitting it means "help Moran pick one to pause/finish, don't work around it."

### 2. Stale signal in the dashboard payload (server)

Today the dashboard's `activeSession` projection (`server/dashboard.ts:839`) carries only `waiting`. The **working/waiting** split is derivable already; **stale** is not — the idle logic lives only in `orient.ts` (`idleMinutes`, `mayBeStale`, `STALE_IDLE_MINUTES` via `getLastEventTimestampMap`).

- Extract the idle calc so both orient and dashboard share it (move `STALE_IDLE_MINUTES` + a pure `sessionActivityState(lastActivityAt, now)` helper into a shared leaf, or reuse `getLastEventTimestampMap` in dashboard.ts). DRY — do not copy the threshold.
- Extend the projection to `{ id, startedAt, waiting, idleMinutes, state }` where `state: 'working' | 'waiting' | 'stale'`. Precedence: **waiting wins** (a paused-for-you chat is not "stale" even if idle), then stale (idle ≥ threshold), else working.
- Mirror into `ApiActiveSession` (`src/lib/api.ts:24`): add `idleMinutes?: number` and `state?: 'working' | 'waiting' | 'stale'` — both OPTIONAL (version-skew guard: an older payload just renders as today).

### 3. Focus panels (client)

- **State:** replace the single sticky `focalId` (`Dashboard.tsx:161`, localStorage `sh.focus.pick`) with a sticky **ordered list of picked ids** `sh.focus.picks` (1–4). Migration: a single old `sh.focus.pick` value seeds a one-item list; unreadable/empty → the current auto-pick (first live task). Reset rule stays: drop ids whose session ended; if all end, fall back to the single-auto-pick behavior.
- **Panel picker control** in the Focus header: choose count (1–4) and which running tasks occupy the panels. A running task not currently in a panel is added from the "Also running" strip (click to place). Never lets you pick more than the number actually running, nor more than 4.
- **Layout:** 1 panel = today's full-width Focus (unchanged). 2 = side by side. 3–4 = grid. Responsive via `clamp()`/breakpoints per the planning-view sizing rule; on a narrow window the grid stacks vertically rather than shrinking panels to unreadable. CSS namespace `r21-focusgrid-*`.
- **Each panel** is a compact version of today's focal card: title (click → drawer), story chip, LOGGED/REMAINING, the drill-in arrow (→ activity feed), and a **state mark** in the corner — working / waiting / 🌙 stale — driven by `activeSession.state`. The stale mark uses a moon glyph + a text label (never colour/icon alone — accessibility + the "functional colour" rule).
- **"Also running" strip** stays for tasks not in a panel: shows count, click a card to add it to the grid (promotes into a free panel, or asks which to replace when full). This replaces today's single-promote `onPromote`.
- One-panel view keeps the existing drill-in (`FocusTaskDrill`) untouched.

## Data flow

`session_start` (capped) → sessions DB → `buildDashboard` projects `activeSession.state` from idle+waiting → payload → client renders picked tasks into panels with state marks. The cap and the panels never talk to each other: the cap limits the DB, the panels read whatever's live.

## Testing

- `server/session-cap.test.ts`: `parallelCapExceeded` (at cap + new → true; at cap + existing → false; under cap → false); config resolver (env > setting > default; junk → default 4, never 0).
- Shared idle helper: `sessionActivityState` — waiting beats stale; idle ≥ threshold → stale; recent → working; boundary at the threshold.
- Dashboard projection: an idle open session projects `state:'stale'`; a waiting one projects `'waiting'` even when idle; a fresh one `'working'`.
- Client: panel-picks localStorage migration (old single value → one-item list); reset when a picked session ends; picker never exceeds running count or 4. `wrapVisible`-style pure bits unit-tested; grid layout is visual (USER smoke).
- MCP refusal message: prose, USER-smoked (handler glue, per repo convention).

## Out of scope (YAGNI)

- No auto-pause of stale sessions (Moran refused the auto-swap; the cap refusal names them and he chooses).
- No auto-fill / pinning of panels (he picks each — explicitly chosen over auto-fill).
- No change to how sessions are started by chats other than the cap check.
- No cross-process push to a chat (established impossible this session — the dashboard is the only place state can surface).
- Cap does not apply to block/unblock.

## Honest risks flagged

- A 4-panel grid can itself overwhelm on a busy day. Mitigation baked in: default is ONE panel; the grid is opt-in and Moran-picked, never automatic.
- The stale threshold is a judgement call; it reuses the existing orient value so the dashboard and the greeting agree rather than inventing a second number.
