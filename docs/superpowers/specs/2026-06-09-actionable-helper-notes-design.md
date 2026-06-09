# Actionable Helper Notes — Design

**Date:** 2026-06-09
**Status:** Approved for planning

## The problem

"Notes from your helper" today has three weaknesses Moran hit while using it:

1. **One button, one meaning.** Every note has a single checkmark whose only job is dismiss-forever. So *clearing* a note and *dealing with* a note are the same action. A note like
   > **CODEOWNERS model** (#426267) has been going with no activity yet and Remaining still shows 6h — update Remaining or move the task off your plate.

   leaves Moran stuck: tick it and he forgets it; leave it and it just nags. There's no way to act on it or to keep it safe for later.

2. **Notes live only on the Daily page.** When he's heads-down in Focus mode, the notes that matter to the work in front of him are invisible.

3. **A misleading age.** The card shows "11d ago" in its header. That stamp is actually the age of the *living summary* paragraph, not the notes — but it sits above the notes, so it reads as if the notes are 11 days old. The summary's age is also genuinely stale because the summary isn't being rewritten when it should be.

## What we're building

Each note becomes something Moran can *act on*, *keep*, or *clear* — and the notes that relate to his current work follow him into Focus mode.

### 1. Three actions per note

A note row gets a small action set:

- **Act on it** (primary). Opens a one-line box under the note ("anything to add?"). Clicking **Copy prompt** puts a ready-made prompt on the clipboard — the note's text plus Moran's optional line — which he pastes into a Claude Code chat. The chat then looks up the task and handles it (adjust Remaining, move it, close it — whatever he decides there). This is how a note gets *handled* rather than merely cleared. The dashboard cannot type into a chat, so copy-to-clipboard is the mechanism — the same pattern already used by the "Copy prompt" button on the Plan page.
- **Keep** (toggle). Pins the note to the top so newer notes can't bury it, and gives it an accent stripe so it stands out. This is the single concept that covers both "save it" and "highlight it." A kept note shows as **Kept** and can be un-kept.
- **Done.** Exactly what the checkmark does today (soft-dismiss, never shown again), but now clearly labeled so Moran knows that's all it does.

The CODEOWNERS case stops being a trap: **Keep** it if he can't deal with it now, **Act on it** to hand it to a chat immediately, and **Done** only once it's truly handled.

### 2. The "Act on it" prompt

Fixed wording, with the user's optional line folded in. Built client-side (pure string assembly, no server call). The note body keeps its `**title** (#id)` formatting so the chat can find the item.

```
Help me deal with this note from my sprint helper:

"<note body>"

<optional user line, omitted entirely if empty>

Let's talk it through and take care of it.
```

A single shared builder (`buildNotePrompt(note, extra)`) produces this string, used by both the Daily and Focus renderings.

### 3. Per-note age, and the summary age moved

- Each note shows **its own age** next to it (`relAgo(createdAt)` — the field is already in the payload). For the CODEOWNERS nudge, "11d ago" then honestly means *this loop has been open 11 days* — useful information.
- The living-summary age moves out of the card header and sits **directly under the summary paragraph**, labeled "updated 11d ago" so it's unmistakably about the summary, not the notes.

### 4. Notes in Focus mode — only the ones about the current work

Focus mode renders a compact notes block, but to respect the one-focal-point rule it shows **only**:

- notes whose work item is the focal task, **or** its parent story, **plus**
- any **Kept** note (those are deliberately surfaced everywhere).

Everything else stays on Daily. To make this filtering possible, each note quietly remembers which work item it's about (see data model). Capacity notes and free-form notes have no work item and so never appear in Focus unless Kept.

Filtering happens client-side from the notes already in the dashboard payload. Caveat: the payload carries a capped list of open notes (currently 5). If Moran ever has more open notes than the cap and the relevant one falls outside it, it won't appear in Focus. Acceptable for now; raise the cap if it bites. No separate endpoint.

### 5. Explicitly out of scope (flagged follow-up)

The living summary genuinely isn't being rewritten on session end, which is why its age goes stale. That's a behavior fix in *when the assistant refreshes the summary* (SERVER_INSTRUCTIONS + the `session_end` path), not part of this card. Tracked separately so this stays focused.

## Data model

Two idempotent `ALTER TABLE` additions to `helper_notes`, following the existing `standup_summary` migration pattern in `server/db.ts`:

- `pinned_at TEXT` — null = not kept; an ISO timestamp = kept (also records when).
- `work_item_id INTEGER` — null = not tied to a work item; otherwise the Azure DevOps id the note is about.

Schema becomes:

```sql
helper_notes(
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  body         TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  dismissed_at TEXT,
  pinned_at    TEXT,         -- new
  work_item_id INTEGER       -- new
)
```

## Components and changes

- **`server/db.ts`** — two idempotent ADD COLUMN migrations.
- **`server/helper-notes.ts`**
  - `HelperNote` gains `pinnedAt: string | null` and `workItemId: number | null`.
  - `addNote(body, workItemId?)` — optional id.
  - `listNotes` — selects the new columns; orders **kept-first** (`pinned_at IS NOT NULL` DESC) then newest-first.
  - `pinNote(id)` / `unpinNote(id)` — set/clear `pinned_at`.
  - `ensureStaleRemainingNudge` — passes its `workItemId` through to `addNote` (it already has it).
- **`server/*` API layer (`vite.config.ts` middleware)** — two new endpoints mirroring the existing dismiss route, both invalidating the dashboard cache:
  - `POST /api/helper-note/:id/pin`
  - `POST /api/helper-note/:id/unpin`
- **`src/lib/api.ts`**
  - `ApiHelperNote` gains `pinnedAt` and `workItemId` (`createdAt` already present).
  - `pinHelperNote(id)` / `unpinHelperNote(id)` wrappers.
- **`src/components/Dashboard.tsx`**
  - A shared note-row component (body + age + Act/Keep/Done) and a shared `buildNotePrompt` helper, used by both Daily and Focus (DRY).
  - `RailNotes` reworked: per-note action row, inline Act composer, per-note age, summary age relocated under the summary line.
  - `R21Focus` renders the compact notes block filtered to the focal task / parent story / kept notes.
- **`mcp/server.ts`** — `helper_note_add` gains an optional `workItemId` so future assistant-written notes can tie to an item. (Existing notes simply have null; nothing breaks.)
- **`src/styles/dashboard.css`** — the action row, the kept accent stripe, the inline composer, and the Focus notes block. Dark/warm palette, one accent, no pulsing, per the UI rules.

## Testing

- **Unit (Vitest):** `pinNote`/`unpinNote`, `listNotes` kept-first ordering, `addNote` storing `workItemId`, the migration adding columns to a fresh and an existing db, and the pure `buildNotePrompt` (with and without the extra line).
- **USER browser smoke** (`http://localhost:7777/`): the three actions, the inline composer + clipboard copy, the relocated/age labels, and notes appearing in Focus for the focal work.
- **USER reload smoke** (`/exit` + `claude --resume`): the `helper_note_add` `workItemId` param. Don't claim verification on the MCP change.

## Principles

KISS/DRY/YAGNI: one "Keep" concept instead of separate save+highlight; client-side filtering instead of a new endpoint; a shared note row + prompt builder across Daily and Focus; the summary-refresh behavior deliberately left out of scope.
