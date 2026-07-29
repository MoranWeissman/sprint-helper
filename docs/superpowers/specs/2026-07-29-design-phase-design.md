# Design phase — design spec (2026-07-29)

## Why

Discovery now ends with agreed findings and a demo. Nothing exists after it:
the D&D Design tab is a "coming soon" placeholder. Moran's company wants the
whole discovery→design pipeline faster; the design phase is where the feature
becomes STORIES on the board with estimates, a build order, and a
presentable document. Moran already opened a design story for the CD feature
— the phase is being lived before it's built.

Decisions locked with Moran (2026-07-29):

- Stories are DRAFTED in the design doc and pushed to Azure DevOps in one
  step at the end — the board never sees half-baked drafts.
- The design review meeting GATES the push: agreed with Moran → review done
  → push. In that order.
- Agree-per-part rhythm inherited from discovery (explain plainly → two
  cents → mark agreed), enforced by the design story's close gate.
- NO clock: no day nudges for design. The feature card shows elapsed days
  as a plain label — visible, never nagging.

## The disk home (mirrors discovery)

```
<feature folder>/design/
  design.json          ← source of truth, written by work chats
  design.md            ← regenerated from JSON by sprint-helper, never hand-edited
  meetings/            ← dated meeting summaries (the design review lands here)
    sources/           ← raw material, ignored by the dashboard
  diagrams/            ← SVG picture files, shown inline on the page
  walkthrough.html     ← the presentation (house slideshow style), optional
```

## The EXACT file shape — `design.json`

```json
{
  "approach": {
    "lines": ["plain line: how we'll build it"],
    "diagram": "architecture.svg"
  },
  "flows": [
    { "name": "Deploy flow", "steps": ["step 1", "step 2"], "diagram": "deploy-flow.svg" }
  ],
  "stories": [
    {
      "title": "Story title as it will appear on the board",
      "covers": "one or two plain lines: what this story delivers",
      "estimateHours": 8,
      "why": "plain line justifying the number, quoting discovery (a risk or a waits-on must be named here if the story touches one)"
    }
  ],
  "plan": [
    { "step": "what gets built at this step", "stories": ["Story title"], "note": "optional: why this order / what it waits on" }
  ],
  "decisions": [
    { "question": "the open choice", "choice": "empty until decided", "decidedInMeeting": "" }
  ],
  "review": { "status": "none", "date": "" },
  "pushed": { "at": "", "storyIds": [] },
  "agreed": ["approach", "flows", "plan", "decisions", "story:<story title>"]
}
```

Field rules:

- `approach.lines`, `flows[].steps` are arrays of short plain strings.
- `diagram` values are file names inside `design/diagrams/` (empty string =
  no picture). SVG only.
- `stories[].estimateHours` is a number (hours). `why` is REQUIRED and must
  reference the discovery when the story touches a `risk` or `dep` item.
- `plan[].stories` references stories by exact `title`.
- `decisions` seeds from the discovery's `option` items and the tech-lead
  lane; `choice` stays empty until a real decision; `decidedInMeeting` names
  the meeting file when a meeting settled it.
- `review.status` is `none` / `scheduled` / `done`. `done` is set only after
  a design-review meeting summary exists in `design/meetings/`.
- `pushed` is written by the push tool only — chats never hand-write it.
- `agreed` keys: `approach`, `flows`, `plan`, `decisions`, and one
  `story:<story title>` PER STORY. Stories are agreed one by one — they are
  the most consequential part, so each gets its own yes. A retitled story
  drops its old mark (same rule as discovery's renamed group).

Parsing lives in a new pure module `server/design.ts` with the same
discipline as `server/discovery.ts`: never throws, missing/garbage →
safe empties, unknown fields dropped. The fs wrapper (read/write/regenerate
`design.md`, list diagrams) extends `server/discovery-store.ts` patterns in
a new `server/design-store.ts`. Meetings REUSE the existing `listMeetings()`
— it already takes a folder path; point it at `design/meetings/`.

## The three gates (in order)

1. **Agreed:** every non-empty part carries its `agreed` key. Same coverage
   check style as discovery: `designAgreementCheck(doc)` returns
   `{ ok, unagreed: string[] }` with bare plain-English labels
   (`the approach`, `the flows`, `the story "X"`, `the working plan`,
   `the open decisions`).
2. **Reviewed:** `review.status === 'done'` AND at least one meeting file
   exists in `design/meetings/`. The block message says plainly: hold the
   design review with the team, record it, then push.
3. **Pushed:** `pushed.storyIds` non-empty.

The design story's close gate (same hook point as the discovery gate in
`mcp/server.ts`) requires all three, and its block message names the FIRST
unmet gate only — one instruction at a time, not a wall. Design stories are
detected by title: `isDesignStoryTitle` = `/^\s*design\b/i`, mirroring
`isDiscoveryStoryTitle`.

## The push tool

New MCP tool `design_push_stories`:

- Preconditions (refused with a plain message otherwise): gates 1 and 2 met,
  and `pushed.storyIds` empty (no double push — a second call reports the
  stories already exist, listing their `displayName`s).
- Creates one User Story per draft under the feature, on the board:
  title from the draft, description from `covers` + the `why` line,
  Effort/Story Points set from `estimateHours` following the SAME rules the
  codebase already applies when creating stories (Original-Estimate-once
  discipline, Story Points derived from Effort — reuse the existing helpers,
  do not reimplement).
- Writes `pushed.at` (ISO time) + `pushed.storyIds` back into `design.json`
  and regenerates `design.md`.
- Returns the created stories' `displayName`s so the chat echoes them.

## The dashboard (D&D page, Design tab)

The Design tab replaces its placeholder with sub-tabs mirroring Discovery:

- **Review** — the parts as cards, same collapsible style, agreed ✓ /
  "not agreed yet" marks per part and per story. The approach card shows its
  diagram inline (same inline-image pattern as discovery board images);
  each flow card the same. Stories render as rows: title, covers,
  hours chip, the "why" line. The plan renders as an ordered list. The
  decisions card shows question → choice (or "not decided yet"). A quiet
  status line shows the gate progress: agreed n/m → review → push.
- **Meetings** — `design/meetings/` cards, newest first (reuse the Meetings
  component; it already takes a list).
- **Walkthrough** — `design/walkthrough.html` in the sealed frame with
  Open/Download, same as discovery's (the artifact route gains a
  `design-walkthrough` kind reading from `design/`).

URL state: `facet=design&sub=review|meetings|walkthrough` (the facet exists;
subs are new). NO clock and NO nudges anywhere for design (explicit
decision). A "day N" elapsed label was considered and CUT from this build:
computing it needs board+session data, which would break the Design tab's
disk-only instant load. Revisit only if Moran asks for it.

The API follows the discovery split: the disk-backed design payload gets its
OWN route, `/api/discovery/<id>/design` — disk-only, never waits on ADO,
fetched when the Design tab opens (keeps the existing doc payload unchanged
and small). A missing/empty design folder returns a well-formed empty
payload; the client renders the "no design yet" state from it, never
crashes.

## The skills (seed only, fan out via skills_sync)

1. **New managed skill `design`** (added to `MANAGED_SKILLS`): the process.
   - Starts from the discovery: reads `discovery.json`; `option` items and
     the tech-lead lane seed `decisions`; risks/deps must be visible in
     story `why` lines.
   - Build ONE PART at a time, explain plainly, wait for USER's yes, mark
     `agreed`. Stories one by one. Same "simplify wording, never content"
     rule as discovery.
   - Estimates: propose hours per story, justify from discovery; a story
     touching a `risk` or `dep` gets more room and says so.
   - Diagrams: write SVG files into `design/diagrams/` (self-contained, no
     external fonts/images; readable at ~800px wide; calm colors).
   - The design review: when USER says it happened, record the meeting
     summary (same rules as discovery meetings: summaries only, sources
     folder), set `review.status: "done"`, and update any `decisions` the
     meeting settled (`decidedInMeeting`).
   - The push: only when USER says push; call `design_push_stories`; echo
     the created stories' `displayName`s verbatim.
   - The EXACT file shape block, same as the discovery skill has.
2. **Walkthrough skill** gains a design mode: when asked for a DESIGN
   walkthrough, read `design.json`, write `design/walkthrough.html`, same
   house pattern/palette/compact-mode; slides: title → approach (+
   architecture picture embedded) → flows → the stories (with hours) → the
   working plan → open decisions. Diagrams embed as inline SVG.

Plain-language rule holds everywhere: no agile jargon in strings a person
reads, banned-words list applies, names before numbers, and the word
"pushback" never appears (discovery rule, carried forward).

## Tests

Same style as discovery's: pure-module tests for `server/design.ts`
(parse-tolerance, agreement coverage with per-story keys and the retitle
rule, gate ordering — block message names only the first unmet gate),
store tests with temp dirs for `server/design-store.ts`, and message-shape
tests for the close-block and push-refusal strings. MCP handler glue and
D&D components stay untested by unit tests (repo decisions); USER smokes
the tab and the push end-to-end on a real feature.

## What does NOT change

- Discovery: untouched (the design skill READS discovery.json, never writes it).
- The meetings machinery, demo skill, sealed-iframe artifact pattern.
- Board discipline: estimates set once at create, via existing helpers.

## Out of scope

- No day nudges for design (explicit decision — label only).
- No auto-scheduling of the review meeting.
- No editing stories on the board after push (post-push changes happen on
  the board like any story today).
- Multi-project remains out (same as the rest of the tool).
