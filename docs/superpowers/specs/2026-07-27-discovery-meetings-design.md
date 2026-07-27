# Discovery meetings — dated summaries, shown in their own sub-tab

Date: 2026-07-27
Status: approved (chat), pending user review

## The problem

Discovery runs through real meetings, and today those conversations leave no
trace in the workspace: the chat updates discovery items, but the meeting
itself — who said what, what was agreed, what stayed open — has no home. Moran
asked for a place where each discovery meeting's summary is kept and shown.

Decisions made in chat (2026-07-27):
- A **history of meetings**, dated, never overwritten — not one living summary.
- Flow: Moran tells the chat about the meeting → the chat writes the dated
  summary → then OFFERS extracted findings ("2 new risks, 1 answered question —
  fold them in?") and changes the discovery only on a yes. The meeting file
  stays as-written either way; it is the record.

## Disk layout (source of truth)

- Each meeting is one markdown file:
  `<feature folder>/discovery/meetings/YYYY-MM-DD.md`.
  A second meeting the same day adds a slug: `YYYY-MM-DD-<slug>.md`.
- File shape: first line is a `# <short title>` heading (e.g.
  `# Platform team — deploy flow`), then the summary in plain markdown.
- Files are chat-written but human-readable on their own — the folder works
  without the dashboard, like the rest of Discovery.

## Server

- The existing discovery doc route (the one that already reports
  `hasWalkthrough`/`hasDemoHtml`) also returns the meetings — **no new request**;
  the Meetings tab is instant like the rest of Discovery and never waits on ADO.
- Payload addition to `DiscoveryDocPayload`:
  `meetings: Array<{ file: string; date: string; title: string; html: string }>`
  sorted newest first (by filename, descending — the date prefix makes that
  chronological).
- `title` = the first `#` heading's text; fallback = the filename without
  extension. `date` = the filename's `YYYY-MM-DD` prefix; a file without a
  valid date prefix is still listed (sorted by name, date shown empty) — never
  silently dropped.
- `html` = the markdown body rendered and sanitized server-side through the
  same path the discovery doc already uses. No new rendering pipeline.
- Missing `meetings/` folder → empty array, not an error.
- Pure helpers (listing, sorting, title/date extraction) live in
  `server/discovery-store.ts` alongside the existing artifact helpers.

## Dashboard

- Discovery's sub-tab strip becomes **Review · Meetings · Walkthrough · Demo**
  (Meetings second — it is content, the other two are artifacts).
- The Meetings sub-tab: meetings newest first, each a collapsible card in the
  exact style Review's discovery cards already use — closed by default, the
  header showing the date and title, the body showing the rendered summary.
- Empty state: one plain line — "No meeting summaries yet. Tell your work chat
  about a discovery meeting and it will land here."
- URL state: `?sub=meetings` persists like the existing sub-tabs; switching
  features still resets the sub-tab to Review (existing behavior extends).
- Calm dashboard style throughout — this is NOT an HTML artifact and never
  renders in the sealed frame.

## The chat flow (managed `discovery` skill)

The `discovery` skill — a managed skill, so the edit happens AT THE SEED and
fans out via `skills_sync` — gains a "Discovery meetings" section:

- Trigger: Moran says he had a discovery meeting (any phrasing) and describes
  what was discussed.
- The chat writes `discovery/meetings/<date>.md` with the `# title` + summary.
  Summary voice: plain English, short sentences, names before numbers; record
  what was said and agreed, not meta-talk about tools.
- Then it reads the summary against the current discovery and offers the
  extracted findings in one plain line ("I see 2 new risks and 1 answered
  question — fold them into the discovery?"). Only on a yes does
  `discovery.json` change. No yes, no change; the meeting file stays either way.
- After the seed edit ships, one `skills_sync` run updates every copy.

## Out of scope (deliberate)

- No meeting HTML artifact (the "meeting-recap" flashy page stays a separate,
  future idea — this is the calm record, not a room presentation).
- No editing/deleting meetings from the dashboard — files on disk are the
  interface, matching the rest of Discovery.
- No ADO involvement anywhere in this feature.

## Testing

- Unit tests (Vitest, temp dirs) for the pure helpers: listing + newest-first
  sort, same-day slug files, title extraction with fallback, date-prefix
  parsing incl. the no-date fallback, missing folder → empty.
- Route and UI are user-smoked (project convention): Moran opens the Meetings
  sub-tab on a feature with and without meeting files.
- Existing sub-tab tests (URL state, reset-on-feature-switch) extend to the
  fourth tab.

## Success criteria

Tell a work chat about a discovery meeting → a dated file appears under the
feature's `discovery/meetings/` → the dashboard's Meetings sub-tab shows it as
a collapsible card, newest first, in Review's card style — and the discovery
itself changed only if Moran said yes to the offered findings.
