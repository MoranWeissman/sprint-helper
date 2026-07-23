# Demo generator — design

Date: 2026-07-24
Status: approved, ready for implementation plan

## What we're building

The last piece of the discovery arc. Once a feature's discovery is complete, a
chat session builds a **concept demo** — a single self-contained HTML file that
throws a convincing picture of the idea on screen (honest banner, human hook,
numbered pillars, one animated flow, behind-the-scenes, a dashed "out of scope"
aside). The dashboard's Demo tab then shows that file in a sealed frame.

This is NOT a working demo and NOT a slide deck. It's a narrated concept, made
fast, to show a stakeholder or think out loud before any real work. The format
is the one in [[feedback-dnd-concept-demo-format]].

## The split (who does what)

The dashboard is a plain Vite server with **no AI inside it** — it reads and
shows files, it can't write a demo. The AI lives in chat sessions. Writing a good
concept demo is a creative act, so it happens in a session. This mirrors how
discovery already works: a session writes the file, the dashboard reads it.

1. **A session builds the demo.** Either the user says "build the demo" in a
   Discovery & Design chat, OR the session offers it the moment discovery is
   complete. The AI reads the finished discovery (including `demo.notes`),
   proposes 2–3 demo ideas in plain words, the user picks one, and the AI writes
   the HTML into the feature's folder, then flips `demo.status` to `built`.
2. **The file lives in the feature folder** at `demo/concept-demo.html`, beside
   the existing `discovery/` folder. One demo per feature; rebuilding overwrites.
3. **The dashboard Demo tab shows it.** When the built HTML exists, the tab
   renders it in a sealed iframe plus Open-in-new-tab and Download buttons. No
   HTML yet → the tab keeps today's candidate-notes + mark-status view.

## Scope decisions

- **The "offer when complete" nudge is skill instructions only** — not hardened
  into `orient`/MCP code yet. We learn from the first real generated demo before
  adding enforcement plumbing. Cheaper, reversible, fits "see one first."
- **The dashboard has no generation button and no AI.** It only reads and shows.
  Triggering generation from the dashboard would need it to launch an AI session
  behind the scenes — off the current pattern, real extra plumbing, deferred.
- **The writing guidance stays lean for now.** The part we can only tune by
  looking at a real generated file. Build the mechanism solid; refine the
  how-to-write-it instructions after seeing one on screen.

## Part A — dashboard (the only code)

Three small changes. No AI, no generation.

### A1. Doc route gains one field

`GET /api/discovery/:id` (the disk-only doc route in `vite.config.ts`) returns an
extra boolean:

```
{ folderPath, doc, hasDemoHtml }
```

`hasDemoHtml` = `existsSync(join(folderPath, 'demo', 'concept-demo.html'))`. Cheap,
synchronous, no new request, no ADO. The `DiscoveryDocPayload` type in
`src/lib/api.ts` gains `hasDemoHtml: boolean`.

### A2. New serve route

`GET /api/discovery/:id/demo-html` — serves the one fixed file
`demo/concept-demo.html` as `text/html; charset=utf-8`. Modelled on the existing
`/image/:name` route but with NO name parameter: the filename is fixed, so there
is no path-traversal surface. 404 if the file is absent. Add `demo-html` to the
action alternation in the route regex.

### A3. Demo tab renders it

In `DnDView.tsx`, `DemoFacet` gains a `hasDemoHtml` prop (threaded from
`doc.hasDemoHtml` through `FacetReadingArea`). When true:

- A **sealed `<iframe>`** with `src="/api/discovery/:id/demo-html"`,
  `sandbox="allow-scripts"` (scripts for the animated flow; no `allow-same-origin`
  so its CSS/JS cannot touch the dashboard), `title` set, a sensible min-height.
  This is the boundary from [[feedback-dnd-concept-demo-format]]: the flashy demo
  style stays walled off from the calm dashboard.
- **Open in new tab** — a link to the same URL, `target="_blank"`.
- **Download** — an `<a download="concept-demo.html">` to the same URL.

The candidate notes + status controls stay above the frame. When `hasDemoHtml`
is false, the tab is exactly today's view — no empty frame.

### What Part A does NOT touch

The `demo` POST route, `markDiscoveryDemo`, the `DiscoveryDoc` shape. The session
writes the HTML and flips status through the tools that already exist.

## Part B — session instructions (no code)

A new `demo` skill (sibling to the `discovery` skill), living in the same three
places the discovery skill does:

- global on-ramp: `~/.claude/skills/sprint-helper-plus/skills/demo/SKILL.md`
- seed: `~/projects/github-moran/features/.claude/skills/demo/SKILL.md`
- (workspaces inherit the seed via `syncSeedSkills`; existing live workspaces get
  a manual copy, since sync only copies MISSING skills)

The skill tells a session:

1. **When to offer.** The moment `discoveryFinishedCheck` passes (flow + at least
   one complete group), say one plain line: "**<feature>** discovery looks
   complete — want me to build a concept demo?" Names before numbers; echo
   `displayName`.
2. **Propose 2–3 ideas** in plain words, drawn from the flow + `demo.notes`. Let
   the user pick. Do not build without a pick.
3. **Write** `demo/concept-demo.html` in the feature folder, using the
   concept-demo format. The skill carries the full format spec inline (folded in
   from [[feedback-dnd-concept-demo-format]]) so it's self-contained:
   - honest banner up top ("Illustrative concept — not a working system")
   - human hook first (first-person feeling, win as crossed-out pain)
   - numbered pillars, one idea each; the star pillar has an interactive animated
     flow (run/step/reset, a fake console, stages lighting up)
   - a calmer "behind the scenes" layer
   - a dashed amber "out of scope / parked for debate" aside
   - self-contained single file, no CDN, opens offline
   - `@media (prefers-reduced-motion: reduce)` guard — flashy by choice, still
     accessibility-safe
4. **Flip status** to `built` via the existing demo action, so the dashboard and
   `orient` reflect it.

The skill also states the boundary: this flashy style is the OPPOSITE of the calm
dashboard rules and that's fine — it's a separate file the dashboard shows in a
sealed frame, never embeds.

## Testing

- **A1/A2 server:** the doc route's `hasDemoHtml` and the `demo-html` serve route
  are inline Vite-middleware glue (not unit-tested per the project's convention);
  the user smokes them. If a small pure helper falls out (e.g. a
  `demoHtmlPath(folderPath)` in `discovery-store.ts`), unit-test that.
- **A3 frontend:** no new pure logic worth a test; visual, user-smoked.
- **Skill:** prose, no test.

Net: likely one tiny pure helper + its test; the rest is user-smoked, matching how
the discovery routes were verified.

## Build order

1. `demoHtmlPath` helper in `discovery-store.ts` (+ test).
2. Doc route `hasDemoHtml` + `demo-html` serve route in `vite.config.ts`; regex.
3. `DiscoveryDocPayload.hasDemoHtml` in `src/lib/api.ts`.
4. `DemoFacet` sealed-iframe + buttons in `DnDView.tsx`; CSS for the frame.
5. `demo` skill in all three places.
6. Typecheck (both tsconfigs), test, build. User smokes with a real feature.

## Out of scope (later)

- Enforced "offer when complete" nudge in `orient`/MCP code.
- Dashboard-triggered generation.
- Design-phase content and the DR gate.
