# Open-source roadmap

**Date:** 2026-07-06 · **Status:** PLAN ONLY — nothing here is being built yet.
Successor to `docs/post-review-roadmap.md`. Based on the 2026-07-06 four-angle review
(architecture, privacy/legal hygiene, stranger onboarding, market scan) plus Moran's
own requirements (auto-start server, generic settings).

## The decision this plan serves

Release sprint-helper as open source — as an **opinionated niche tool** shared honestly
("this is how I work; take it if it fits you"), not a broad product. Single-user,
local-first, no auth, Azure DevOps + Claude Code — all **by design**, stated plainly.

Two standing facts that shape everything below:

1. **This repository can never be made public.** All 324 commits carry Moran's real
   name and employer email as author, and real internal work items appear in code,
   tests, and instructions. The public release is a **fresh repository**: today's tree,
   content-cleaned, one new commit, new author identity. This repo stays private
   forever as the development home.
2. **The `portability` branch is abandoned as a release vehicle.** It sits ~92 commits
   behind main — an older product with cleanup bolted on. Its *ideas* (user-config
   layer, README, de-naming) get re-applied to current main in the phases below.
   Delete the branch/worktree once Phase 2 has absorbed what it needs.

Every phase ships on **main** and makes Moran's own daily copy better — dogfooding all
the way; the public repo is an export at the very end.

---

## Phase 0 — Decisions (no code)

Moran's calls, needed before Phase 5 but decidable any time:

- [ ] **License:** MIT (all dependencies compatible — verified 2026-07-06).
- [ ] **Public identity:** which GitHub account/name publishes it. The current account
      is his real full name; decide deliberately whether the public repo carries it.
- [ ] **Employer check:** five-minute look at whether his employment contract says
      anything about publishing a personal tool.
- [ ] **Identity of the tool:** CONFIRMED direction — opinionated by design. The
      plain-language voice and the effort discipline are the product, documented as
      such, not made configurable. (Reversal = big cost; don't reopen casually.)
- [ ] **Public name:** is it still "sprint-helper"? (Check name collisions once, late.)

## Phase 1 — Standalone server + auto-start (Moran's requirement #1)

**Goal:** the dashboard becomes a real server that any chat can start, exactly once,
no matter how many chats are open. Kills the dev-server-only delivery and the
vite-restart staleness bug class in one move.

- **Extract the API out of `vite.config.ts`** into a standalone HTTP server module
  (`server/http.ts`, plain Node http — no new framework). It serves the API **and**
  the built dashboard files (`dist/`). `vite dev` keeps working for development by
  proxying to it. This creates the production mode that doesn't exist today.
- **Health endpoint** (`GET /api/health`) returning `{ ok, version, startedAt }` —
  `version` from package.json + git-less build stamp. This is the "is it running and
  is it current" probe.
- **Ensure-running logic in the MCP server:** on MCP process start (i.e., every new
  chat), probe the health endpoint.
  - Not running → spawn the dashboard server **detached** (survives the chat closing),
    wait for healthy, then open the browser.
  - Already running, same version → do nothing. No second server, no second tab.
  - Already running, **older version** → tell the user in plain words and offer a
    restart (never restart silently — it may be serving another chat's view). This is
    the 2026-07-05 version-skew lesson turned into a feature.
  - **Race safety** (two chats starting at the same instant): the port bind is the
    lock — the loser of the bind just probes again and finds the winner. No lock
    files, no PID files.
- **Browser opening rule:** open only when this MCP actually started the server —
  never on every chat. Config flag to disable auto-open entirely. Plus a small MCP
  tool (`dashboard_open` or similar) so "show me the board" works from any chat.
- Fold in the review's cache fixes at the same seam: max-stale TTL on the dashboard
  cache, surface background-refresh failures to the UI (no more silently frozen
  data when the Azure sign-in expires), and stop pretending MCP-side cache
  invalidation reaches the dashboard process (single server now makes this honest —
  the dashboard cache lives in ONE process at last).

**Supersedes** the launchd part of the 2026-06-10 install-and-run plan. Simpler, not
macOS-only, no login service. Trade-off accepted: dashboard is up only after the
first chat of the day (or a manual `npm run serve`).

## Phase 2 — Generic configuration (Moran's requirements #2 and #3)

**Goal:** nothing about Moran's tenant, schedule, or process is hardcoded. A stranger
configures theirs; Moran's values become just *his* config.

- **One config module on main** (re-derive from portability's `server/user-config.ts`,
  written fresh against current code). Single precedence rule everywhere:
  **environment variable → settings table (SQLite) → default.** Every knob documented
  in one `docs/configuration.md`.
- **The knobs** (at minimum):
  - Azure DevOps: org, project, team, access mode (az CLI / PAT+REST), user identity.
  - Schedule: working days (set of weekdays), workday hours, workday window,
    tentative-meeting weight, calendar URL.
  - Sprint rhythm: which weekdays each ceremony lands on (Daily days — the queued
    "Daily days in config" item folds in HERE), sprint cadence assumptions.
  - Process mapping: see next bullet.
- **State-machine probe (the "Blocked wall" fix):** a setup step queries the tenant's
  actual states per work item type (the re-probe recipe already documented in memory)
  and stores the bucket mapping (waiting/going/blocked/done → real state names) in
  settings. Runtime reads the stored mapping instead of hardcoded chains.
  - No Blocked state on the tenant → configurable fallback: tag-only blocking, with
    a clear one-line message explaining the difference. Never a raw ADO error.
  - This also consolidates the several server-side copies of state sets into one
    place. (The frontend's duplicate copies get cleaned opportunistically, per the
    existing Dashboard-split rule — not a rewrite pass.)
- **SERVER_INSTRUCTIONS becomes a template:** schedule prose ("9h/day, Sun-Thu"),
  ceremony days, and tenant facts are interpolated from config instead of literal
  text. The voice and discipline rules stay fixed (Phase 0 identity decision).
- **Known bug fixed here:** `server/config.ts` env fallback is dead code (a promise
  is checked before it's awaited, so `SH_ADO_ORG`/`SH_ADO_PROJECT` can never win in
  CLI mode). Fix + regression test.
- **Error honesty at the same time:** route ALL az/auth failures through the one
  good diagnosis helper — "sign-in expired, run az login" must appear everywhere it's
  the true cause (today one path reports it as "No active sprint found"). Also a
  specific message when az isn't installed at all.

## Phase 3 — Settings UI + guided setup

**Goal:** a stranger (and Moran) can see and change configuration without touching
files. "Settings inside the AI's MCP configuration, files, or UI" — all three doors,
one precedence rule.

- **Settings page in the dashboard:** reads/writes the settings table (both processes
  already share the SQLite file, so the MCP picks changes up naturally). Where an
  environment variable overrides a setting, the UI shows the value **locked with a
  "set by environment" note** — never a silent no-op edit.
- **Guided first run:** `npm run setup` (small interactive script — org/project/team,
  PAT or az choice, schedule questions, state probe from Phase 2, then registers the
  MCP with the one-line `claude mcp add` command printed ready to copy). The dashboard
  additionally shows a friendly "not configured yet" screen pointing at setup instead
  of erroring, for people who open the UI first.
- Secrets stay out of the settings table where a real secret store exists (macOS
  Keychain today); PAT-in-SQLite only as documented fallback with a warning.

## Phase 4 — De-personalize the content on main

**Goal:** the tree itself becomes publishable. Done LAST among the code phases so new
work doesn't keep re-introducing references.

- Remove Moran's name and machine paths from all shipped code, docs, and the MCP
  instruction text (redo portability's phase 1 against current main — ~240 references
  across ~34 files at last count, plus `index.html`, `mockData.ts`, `mcp/README.md`).
- **Genericize the work examples:** the real ArgoCD/OIDC/cluster-addons work-item
  titles and ids in instructions, tests, and comments become invented examples.
- Decide what `docs/superpowers/**` (the ~175-file design archive) does: ships,
  trims, or stays private-repo-only. Lean call: keep it OUT of the public export —
  it's development history, not user documentation.
- Housekeeping sweep from the review: dead `mockData.ts`, dead exports, the
  duplicated instruction paragraph, the type lie in Dashboard.tsx, unbounded
  bookkeeping keys in the settings table.
- **README (public-facing) + honest claims**, per the market scan:
  - Claims: memory/bookkeeping layer on top of YOUR board; ADO stays the source of
    truth; verified against exactly this setup (list it concretely); single-user,
    local, no-auth **by design**; Claude Code + Azure DevOps only, today.
  - Explicitly does NOT claim: "AI Scrum Master", team/multi-user readiness, any
    support promise beyond "works on my machine, contributions welcome", or roadmap
    promises (Jira etc. = "unimplemented", not "coming soon").

## Phase 5 — The release act

- Fresh repo: export the cleaned tree, single initial commit, chosen author identity,
  `LICENSE` (MIT) + `"license": "MIT"` in package.json.
- Minimal `.github/`: an issue template that asks for the reporter's process template
  and states up front what's unsupported (the maintenance-load defense).
- Publish. Announce or don't — Moran's call; the niche self-selects either way.

---

## Order and rationale

**1 → 2 → 3 → 4 → 5.** Phase 1 first because Phases 2-3 (settings UI, health/version)
and Moran's own daily quality-of-life sit on the standalone server. Phase 4 last-among-
code so cleanup doesn't rot while features land. Each phase gets the normal treatment
when it starts: brainstorm → spec → plan → subagent build, one phase at a time.

The regular feature queue (what-fits-today + calendar cron, demo helper, retro page)
continues in parallel on main; this roadmap doesn't freeze product work. "Daily days
in config" from the old queue is absorbed into Phase 2.

## Explicitly out (do not scope-creep in)

- Jira / Linear / GitHub-Issues backends.
- Multi-user, teams, auth, hosting.
- Configurable personality/voice (identity decision).
- i18n.
- launchd / system services (superseded by Phase 1 auto-start).
