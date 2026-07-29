# Discovery tune-up — design spec (2026-07-29)

## Why

Moran's company feels discovery + design take too long. This spec is the
discovery half of the answer (design phase is a separate, later spec). The
goal: discovery stays honest but gets **focused** — main gaps, risks,
mitigations, and dependencies only — plus two new muscles: pushing back on
fat features, and hearing end-clients before design when the feature is
client-facing.

## What changes (5 things)

### 1. Fast = focused, not sloppy (skill text only)

The "every line exactly right" bar does NOT move. Speed comes from covering
less:

- The skill's framing changes from "fast but not fast-and-dirty" to
  "fast because focused": a few context groups covering the MAIN areas only.
- If an area of the feature has no real gap, risk, or dependency, it gets
  **no group at all**. Silence means "nothing important there."
- New line-level test the chat applies before writing any item:
  *"Would this line change a decision in design?"* If no — leave it out.

No code change. Seed skill edit only.

### 2. Two new tags: `dep` and `mitigation`

- **dep** — this work waits on someone or something outside the team
  (platform team, another system, a license, an approval).
- **mitigation** — the answer to a risk, written as its own item right
  under that risk. A risk with no mitigation is fine — it means the answer
  isn't known yet, which is honest. A mitigation without a nearby risk is a
  smell the skill warns against.

Code touchpoints:

- `server/discovery.ts`: `DiscoveryTag` union and `VALID_TAGS` gain
  `'dep'` and `'mitigation'`. Nothing else in parsing changes (unknown tags
  were already dropped, so old files stay valid).
- `server/discovery.ts` `renderDiscoveryMarkdown`: no change needed — it
  already prints whatever tags an item has.
- `src/lib/api.ts`: the mirrored tag union on the discovery payload types
  gains the two values.
- `src/components/DnDView.tsx`: `dominantTag` priority becomes
  `risk > dep > diff > mitigation > option > fact` (a dependency is more
  urgent to see than a diff; a mitigation is calmer than a diff). The tag
  type on `ContextItem` widens to match.
- `src/styles/dashboard.css`: two new chip styles. Functional color, same
  language as the rest of the app: **dep = the amber family** (waiting on
  someone — same feeling as "waiting" elsewhere), **mitigation = the green
  family** (an answer/success). Follow the exact pattern of the existing
  diff/risk/fact/option chips.

The **finish gate does not change**: still flow + one group with a diff, a
risk, and a fact or option. `dep`/`mitigation` are extra vocabulary, not new
requirements.

### 3. Pushback: "what we don't accept as-is"

A new top-level field in `discovery.json`:

```json
"pushback": ["one-liner: what we don't accept and why"]
```

- **Skill**: at the START of discovery, before anything else, the chat reads
  the feature description and runs two checks:
  1. **Too fat?** Does this feature bundle several unrelated things that
     should be separate features?
  2. **Runbook?** Does it contain design instructions dressed as
     requirements — telling us HOW to build instead of WHAT is needed?
  Findings become one-liners in `pushback`. Empty list = "we accept the
  feature as written." The list does NOT block closing discovery — it arms
  the product conversation, it doesn't gate the work.
- `server/discovery.ts`: `DiscoveryDoc` gains `pushback: string[]`;
  `emptyDiscoveryDoc` returns `[]`; `parseDiscoveryDoc` reads it with the
  existing `strArray` helper (missing field → `[]`, so old files stay
  valid). `renderDiscoveryMarkdown` gains a section
  `## What we don't accept as-is` (skipped entirely when the list is empty).
- `src/lib/api.ts`: payload type gains `pushback: string[]`.
- `src/components/DnDView.tsx`: the Review sub-tab gains a **Pushback card**
  ("What we don't accept as-is"), same collapsible card pattern as the other
  Discovery cards. Rendered ONLY when the list is non-empty — the page
  stays calm when there's nothing to push back on. Client code must
  tolerate an old payload with the field missing (`payload.pushback ?? []`
  — same defensive rule that already burned us once with `meetings`).
- `discoveryFinishedCheck`: unchanged.

### 4. Client step by judgment (skill text only)

New section in the discovery skill:

- Early in discovery the chat decides: is this feature **client-facing**
  (an end-client — e.g. a developer — uses it hands-on) or **backend**
  (behind-the-scenes plumbing)?
- Unsure → ask USER one plain question: "who uses this directly?"
- The answer is recorded as a normal `fact` item in a context group (e.g.
  "used directly by developers via the CLI" `[fact]`) — no new schema.
- **Client-facing** → once the concept demo is built, the chat nudges:
  "want to show this to the end-clients before design starts?" Their
  feedback comes back through the existing meetings flow
  (`discovery/meetings/` summary card → offer to fold findings).
- **Backend** → the chat may suggest a quick opinion from a developer or
  team lead; optional, never a step.

No code change. Seed skill edit only.

### 5. Walkthrough skill follows (skill text only)

The walkthrough builds slides from `discovery.json`, so it learns the new
material:

- A **pushback slide** ("What we don't accept as-is") — only when the list
  is non-empty; placed right after the "What we're solving" slide, because
  it frames the product conversation.
- The tag-chip guidance gains `dep` (amber) and `mitigation` (green), same
  functional-color meanings as the dashboard.

## Where the edits land

| Piece | File(s) |
|---|---|
| Tags + pushback (server) | `server/discovery.ts`, `server/discovery.test.ts` |
| Payload types | `src/lib/api.ts` |
| Chips + pushback card (UI) | `src/components/DnDView.tsx`, `src/styles/dashboard.css` |
| Skill: focus, tags, pushback, client step | SEED `~/projects/github-moran/features/.claude/skills/discovery/SKILL.md` |
| Skill: pushback slide + chips | SEED `~/projects/github-moran/features/.claude/skills/walkthrough/SKILL.md` |

Skill edits go to the **seed only** — `skills_sync` fans them out. The seed
skill's "EXACT file shape" JSON example must be updated to show `pushback`
and the two new tags, or work chats will keep writing the old shape.

## Tests

- `server/discovery.test.ts`:
  - parse keeps items tagged `dep` / `mitigation`; still drops unknown tags.
  - parse reads `pushback`; missing field → `[]`; non-string entries dropped.
  - `renderDiscoveryMarkdown` prints the pushback section when non-empty and
    omits it when empty.
  - `discoveryFinishedCheck` on a doc that ONLY has dep/mitigation items
    still fails (gate vocabulary unchanged).
- UI stays covered the way it is today (no component unit tests for D&D);
  USER smokes the chips + pushback card in the browser.

## What does NOT change

- The finish gate, the 2–3 day cap, the day nudges.
- The demo skill and the concept-demo format.
- The meetings flow (reused as-is for client feedback).
- `discovery.md` stays regenerated from JSON — never hand-edited.

## Out of scope (the next spec)

The design phase: stories from discovery, working plan, estimates, MD +
HTML + architecture diagrams. Separate brainstorm, separate spec.
