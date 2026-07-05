# End-of-day wrap — design

**Date:** 2026-07-05
**Status:** Approved by Moran (content + card-builds-itself choice; "after quiet" trigger chosen 2026-07-04)

## What this is

An evening closing ritual, the twin of the morning recap. Two halves, split by role:

- **The Daily page SHOWS:** a wrap card appears at the top of the Daily view when the workday has gone quiet. It answers three things: what today gave, what's still open, and tomorrow's first move.
- **The chat CLOSES:** when Moran tells a chat he's wrapping up, the assistant closes the day properly — done-or-pause each open session, true hours, one last note. This is an instruction block, not a new tool.

The card builds itself from data already saved during the day (session notes, timers, hours). No chat action is required for it to appear — the whole point of the "after quiet" trigger is catching evenings where Moran just walks away.

## The wrap card (Daily view)

Placement: top of the Daily main column, above the morning-recap card. One card, three parts:

### 1. What today gave
One row per story touched today: story name, the plain-words summary of the latest note, time spent. **This reuses `standup.today` verbatim** — the dashboard payload already carries per-story rollups for today (`StandupBlock.today`), built by `server/standup.ts` with AI-written blurbs. The card renders those rows in a compact form; no new server work for this part.

### 2. Still open
Each running session: task/story name and how long it has been going (client computes duration from `startedAt` and its own clock). Source: `listActiveSessions()`. When nothing is running, one calm line instead: **"Everything closed. Clean end."** — that line is the reward for a clean day.

Paused sessions do NOT appear here. Paused is a deliberate, recorded stop — only running timers are "still open".

### 3. Tomorrow's first move
One line: the task Moran touched **last** today that is **not done**, with its hours left. Example copy: `Pick up **Fix PR-comment errors** (#446752) — about 3h left.`

Derivation (server-side, pure): from today's sessions and session events, compute the newest activity timestamp per work item; drop items whose live state is done (reuse the dashboard's `DONE_STATES` check, same as the Needs-you card); pick the newest survivor. Hours left = the item's RemainingWork from the sprint payload; when unknown (item not in current sprint), show the line without hours. When no candidate exists (everything done), `firstMove` is null and the card shows: **"Nothing carried over — pick fresh tomorrow."**

### Dismiss + lifetime
- Small close button. Dismissing stores today's ISO date in `localStorage` key `sh.wrap.dismissed`; card stays hidden while the stored date equals today.
- The card only ever shows data from today's window. After midnight the window is empty, so it disappears on its own.

## When the card appears — the quiet rule

The card renders only when ALL of these hold:

1. **Worked today:** `standup.today` is non-empty (there was session activity today).
2. **Working day:** today is in the working-day set (`DEFAULT_WORKING_DAYS`, Sun–Thu). Server sends this as `wrap.isWorkingDay`.
3. **Afternoon:** local time ≥ **14:00**.
4. **Quiet:** ≥ **60 minutes** since the last session activity today (newest of: session started, session ended, any session event written). Server sends this as `wrap.lastActivityAt` (ISO, null when nothing today).
5. Not dismissed today (localStorage rule above).

**The clock lives on the client.** The server ships facts (`isWorkingDay`, `lastActivityAt`); a pure client function `wrapVisible({now, isWorkingDay, lastActivityAt, workedToday})` applies rules 1–4. Reason: the dashboard payload is cached (5-min server auto-refresh, 15-s client poll) — a server-computed "show now" boolean would freeze inside the cache; the client's `now` is always fresh, so the card appears within one render tick of the threshold instead of up to 5 minutes late.

Known accepted limit: if Moran resumes work, the card can linger up to ~5 minutes until the cache refresh delivers the newer `lastActivityAt`. Accepted — the card is passive, and any MCP write also invalidates that process's cache.

Both thresholds are named constants in one place: `QUIET_AFTER_HOUR = 14`, `QUIET_GAP_MINUTES = 60` (client side, next to `wrapVisible`).

## Data shape

New dashboard payload field (after `needsYou`):

```ts
// server/wrap.ts
export interface WrapOpenSession {
  workItemId: number;
  displayName: string;      // **title** (#id), falls back to #id
  startedAt: string;        // ISO
}
export interface WrapFirstMove {
  workItemId: number;
  displayName: string;
  remainingHours: number | null;   // null = unknown, render without hours
}
export interface WrapBlock {
  isWorkingDay: boolean;
  lastActivityAt: string | null;   // newest session start/end/event today; null = nothing today
  stillOpen: WrapOpenSession[];
  firstMove: WrapFirstMove | null;
}
```

Mirrored as `ApiWrap*` in `src/lib/api.ts`; on the client the payload field is **optional** (`wrap?: ApiWrap`) and the card renders nothing when missing — the 2026-07-05 version-skew lesson: new payload consumers must tolerate the field being absent.

## Module boundaries

- **`server/wrap.ts` (new):** owns the today-window SQL (same style as `standup.ts`: sessions touching today + today's events) and the pure builder `buildWrap({activeSessions, activityTimestamps, titleFor, isDone, remainingFor, isWorkingDay})`. SQL thin, logic pure and unit-tested.
- **`server/dashboard.ts`:** gathers inputs (reuses the existing `taskMeta` map for titles/states/remaining, `listActiveSessions()`) and sets `payload.wrap`. Empty-payload branch gets an empty `WrapBlock` (`isWorkingDay` computed, `lastActivityAt: null`, empty lists, `firstMove: null`).
- **`src/components/WrapCard.tsx` (new file):** the card component + `wrapVisible` pure function + the two constants. New component goes in its own file per the Dashboard-split rule (split as we touch, never a rewrite pass). Dashboard.tsx renders `<WrapCard wrap={payload.wrap} standupToday={payload.standup.today} now={now} />` in the Daily branch.
- **`src/styles/dashboard.css`:** `wrap-*` namespace. Dark/warm tokens, single accent, no pulsing, nothing ≤ 12px paired with the faintest ink.

## The chat side — "WRAPPING UP" instruction block

New SERVER_INSTRUCTIONS block in `mcp/server.ts` (near WAITING ON MORAN). Trigger: Moran says he's finishing for the day — "wrapping up", "done for today", "calling it a day", or similar. The assistant then, in order:

1. Look at open sessions (orient / sprint_snapshot if needed).
2. For each open session, ask ONE plain question: finished or pausing? Then close it the normal way — `session_end` with done + completed hours, or pause. Existing effort-discipline rules apply unchanged (Remaining must be true before close).
3. Before ending the last session, write a final `session_log` progress entry whose `standupSummary` says where to pick up tomorrow, in plain words. That blurb is what the wrap card's story rows show.
4. Confirm the day is closed in one short sentence. No new tools, no writes beyond the normal close path.

## Error handling

- `wrap` block build failure must never sink the dashboard: wrap inputs come from local SQLite only (no ADO calls), so the realistic failure is a bug, not an outage; the builder is pure and total (no throws on empty inputs — covered by tests).
- Client: missing/undefined `wrap` → render nothing (guard first line of the component).
- `firstMove` with unknown hours renders without the hours fragment, never "null h".

## Testing

- `server/wrap.test.ts` (in-memory DB harness, same pattern as `needs-you.test.ts` / `sessions.test.ts`):
  - `lastActivityAt`: newest across session start / end / event; null on empty day; ignores yesterday's rows.
  - `firstMove`: newest-touched wins; done items skipped; null when all done; `remainingHours` null when the item is unknown to `remainingFor`.
  - `stillOpen`: maps active sessions with displayName fallback `#id`; empty when none.
- `src/components/WrapCard.test.ts` (or colocated): `wrapVisible` — before 14:00 → false; gap < 60 min → false; non-working day → false; nothing today → false; all pass → true; boundary values (exactly 14:00, exactly 60 min) → true.
- MCP instruction block: prose, not unit-tested (matches repo convention — USER smokes).

## Out of it (YAGNI)

- No "honest hours check" section — Moran dropped it; the chat close path already forces true hours.
- No push/sound/notification of any kind — the card just appears.
- No per-user quiet-hour configuration yet — constants first; move to the config place if he ever asks.
- No AI-generated wrap text — all words come from data already written during the day.
