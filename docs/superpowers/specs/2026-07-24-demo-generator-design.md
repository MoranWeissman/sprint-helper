# Discovery HTML artifacts + demo — design

Date: 2026-07-24 (reshaped 2026-07-26)
Status: approved, ready for implementation plan

## What we're building

Two standalone, self-contained HTML artifacts a chat session can build for a
feature once its discovery is done, and a place in the dashboard to show them.
Both live inside the **Discovery** tab as sub-tabs, so everything for a feature's
discovery sits in one place.

The two artifacts are DIFFERENT in shape and purpose:

1. **Walkthrough** — an interactive **slideshow** that presents the discovery
   findings (problem → flow → diffs/risks/facts → open questions), slide by slide.
   For walking a room through the discovery, or uploading to another repo. NOT for
   the dashboard-only reader — it's a shareable, offline file.
2. **Demo** — one long **scrollable page** that pictures the product working. The
   flashy concept-demo format from [[feedback-dnd-concept-demo-format]] (honest
   banner, human hook, numbered pillars, one animated flow, behind-the-scenes,
   dashed "out of scope" aside). Optional; only when a good demo flow exists.

Neither replaces the existing **Review** view (the data-driven Discovery tab).
Review stays exactly as it is today.

## The Discovery tab becomes three sub-tabs

Top-level tabs today: **Overview · Discovery · Design · Demo**.

Change: the top-level **Demo tab goes away**. Discovery gains three sub-tabs:

- **Review** — today's data view (problem, flow, collapsible groups with
  diff/risk/fact/option tags, lanes, open questions), built from `discovery.json`.
  UNCHANGED — this spec only wraps it as the first sub-tab.
- **Walkthrough** — the slideshow HTML. Shows the file if built; a plain "not
  built yet" note otherwise.
- **Demo** — the scrollable concept-demo HTML, plus the demo status/date/candidate
  controls that used to live on the old top-level Demo tab. Shows the file if
  built; controls + "not built yet" note otherwise.

Design stays its own top-level tab for later.

## The split (who does what)

The dashboard is a plain Vite server with **no AI inside it** — it reads and shows
files, it can't write them. The AI lives in chat sessions. Writing these HTMLs is
a creative act, so it happens in a session. This mirrors discovery today: a
session writes the file, the dashboard reads it.

1. **A session builds an artifact.** The user asks ("build the walkthrough" /
   "build the demo"), or the session offers the moment discovery is complete. For
   the demo, it proposes 2–3 ideas in plain words and the user picks. It writes a
   self-contained HTML into the feature folder.
2. **The files live in the feature folder** beside `discovery/`:
   - `demo/walkthrough.html`
   - `demo/concept-demo.html`
   One of each per feature; rebuilding overwrites.
3. **The dashboard shows whatever HTML is there.** One show-it mechanism serves
   any of these files in a sealed frame; the sub-tab just points at the right one.

## Scope decisions

- **One show-it mechanism, two writing recipes.** The dashboard doesn't care if an
  HTML scrolls or clicks through slides — it serves a self-contained file in a
  sealed iframe. The only real difference between walkthrough and demo is the
  session's *writing instructions*. This is what stops two artifacts from doubling
  the build.
- **The "offer when complete" nudge is skill instructions only** — not hardened
  into `orient`/MCP code yet. Learn from the first real artifacts before adding
  enforcement plumbing. Cheaper, reversible.
- **The dashboard has no generate button and no AI.** It only reads and shows.
- **Writing guidance stays lean for now.** Build the mechanism solid; refine the
  how-to-write-it instructions after seeing real output.

## Part A — dashboard (the only code)

### A1. Doc route reports which artifacts exist

`GET /api/discovery/:id` (the disk-only doc route in `vite.config.ts`) returns two
extra booleans:

```
{ folderPath, doc, hasWalkthrough, hasDemoHtml }
```

- `hasWalkthrough` = `existsSync(join(folderPath, 'demo', 'walkthrough.html'))`
- `hasDemoHtml`    = `existsSync(join(folderPath, 'demo', 'concept-demo.html'))`

Cheap, synchronous, no new request, no ADO. `DiscoveryDocPayload` in
`src/lib/api.ts` gains both booleans.

### A2. One serve route for the artifacts

`GET /api/discovery/:id/html/:kind` — serves a fixed file by kind:

- `kind = walkthrough` → `demo/walkthrough.html`
- `kind = demo`        → `demo/concept-demo.html`

`kind` is validated against that two-value allow-list (no free-form filename → no
path-traversal surface). Served as `text/html; charset=utf-8`. 404 if the file is
absent. Add `html` to the action alternation in the route regex.

### A3. Discovery tab renders sub-tabs

In `DnDView.tsx`:

- Remove `demo` from the top-level `Facet` type and the `FeatureFacetBar` tabs;
  top tabs become **Overview · Discovery · Design**.
- The Discovery facet gains an inner sub-tab strip: **Review · Walkthrough ·
  Demo**. Sub-tab state is local (and mirrored to the URL like the top facet, so a
  refresh keeps the sub-tab — same `?facet=` pattern, add `?sub=`).
- **Review** sub-tab = the current `DiscoveryFacet` body, unchanged.
- **Walkthrough** sub-tab = if `hasWalkthrough`, a sealed `<iframe>` at
  `/api/discovery/:id/html/walkthrough` + Open-in-new-tab + Download; else a plain
  "No walkthrough built yet" note.
- **Demo** sub-tab = the old `DemoFacet` content (candidate notes + status/date
  controls) PLUS, if `hasDemoHtml`, the sealed `<iframe>` at
  `/api/discovery/:id/html/demo` + Open + Download.

Sealed iframe: `sandbox="allow-scripts"` (scripts for the demo's animated flow and
the slideshow; no `allow-same-origin`, so the artifact's CSS/JS can't touch the
dashboard), a `title`, a sensible min-height. This is the boundary from
[[feedback-dnd-concept-demo-format]]: the loud artifact style stays walled off
from the calm dashboard.

### What Part A does NOT touch

The `demo` POST route, `markDiscoveryDemo`, the `DiscoveryDoc` shape. Sessions
write the HTML and flip status through existing tools.

## Part B — session instructions (no code)

Two skills, each in the three places the discovery skill lives (global on-ramp,
`features/` seed, and a manual copy into existing live workspaces since
`syncSeedSkills` only copies MISSING skills):

- `demo/SKILL.md` — the concept-demo scrollable page. Full format spec folded in
  from [[feedback-dnd-concept-demo-format]] so it's self-contained.
- `walkthrough/SKILL.md` — the discovery slideshow. Presents the discovery data as
  slides: title → problem → the end-to-end flow → one slide per context group with
  its tagged items → lanes → open questions. Same "honest, plain English, one idea
  per slide" voice. Self-contained single file, `prefers-reduced-motion` guard.

Both skills tell the session: offer when discovery is complete
(`discoveryFinishedCheck` passes), name the feature with its `displayName`, write
the file into `demo/`, and (for the demo) flip `demo.status` to `built`.

Whether these are two skills or one skill with two modes is an implementation-plan
detail; the content above is the requirement.

## Testing

- Any small pure helper that falls out (e.g. an `htmlArtifactPath(folderPath,
  kind)` in `discovery-store.ts`) gets a unit test.
- The route glue and the sub-tab UI are inline/visual — user-smoked, matching how
  the discovery routes were verified.

## Build order

1. `htmlArtifactPath` helper in `discovery-store.ts` (+ test).
2. Doc route `hasWalkthrough`/`hasDemoHtml` + `html/:kind` serve route in
   `vite.config.ts`; regex.
3. `DiscoveryDocPayload` booleans in `src/lib/api.ts`.
4. `DnDView.tsx`: drop top-level Demo tab; add Discovery sub-tab strip (Review /
   Walkthrough / Demo); sealed-iframe + buttons; URL `?sub=`; CSS.
5. `demo` + `walkthrough` skills in all three places.
6. Typecheck (both tsconfigs), test, build. User smokes with a real feature.

## Out of scope (later)

- Enforced "offer when complete" nudge in `orient`/MCP code.
- Dashboard-triggered generation.
- Design-phase content and the DR gate.
