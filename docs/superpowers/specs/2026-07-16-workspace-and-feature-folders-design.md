# Workspace + auto-scaffolded feature folders — design

**Date:** 2026-07-16
**Status:** approved for planning

## The problem

Moran gets Azure DevOps **Features** handed to him that have no code repo — the work is thinking, not coding: understand the feature, explore the problem (discovery), design a solution, break it into stories, estimate them, sometimes build a small discovery demo. Today he has nowhere consistent to do this. Claude Code always runs from a folder, and that folder needs BMAD loaded, a planning `CLAUDE.md`, and the "always use BMAD" enforcement hook. Setting that up by hand for every feature is friction, and it scatters his non-code work across ad-hoc folders he can't easily browse.

He wants: one **visible** folder he opens Claude Code in — his workspace for all non-code work — where he can see his stuff (folders + markdown). And he wants sprint-helper to **create a per-feature subfolder automatically** when he names a feature to work on, so he never scaffolds by hand.

## What we're building

A **workspace** concept in sprint-helper:

- A settable, visible folder that Moran launches Claude Code in for non-code work.
- BMAD, the planning `CLAUDE.md`, and the enforcement hook live **once at the workspace root** (where he launches) — no per-feature copies, no drift.
- Each feature gets a **subfolder** holding only its design docs and markdown — clean and browseable.
- sprint-helper creates that subfolder automatically when Moran names a feature, and files his design work there while he stays in the one root chat.

This is NOT a browseable archive of all past non-code work (folders + MDs as a searchable history). That larger vision can grow on top later; this build stays tight.

## Why this shape (the key decisions, with rationale)

- **Launch at the root, BMAD once at the root.** BMAD's skill files reference `{project-root}/_bmad/...`, resolved at runtime to the folder Claude Code launches in. Launching at the root means `{project-root}` = the root, `_bmad` is right there — zero path ambiguity. This is exactly how Sharko runs today (proven). It also avoids the ~12MB-per-feature copies and the drift of stale BMAD copies, and keeps feature subfolders clean (just Moran's docs). Decided with Moran; it's a better model than the earlier per-subfolder-BMAD idea.
- **Reuse the existing `planning-home` plumbing.** sprint-helper already has `planning_home_set` / `planning_home_status` (server/planning-home.ts): a settable folder path, folder creation, a marker file, and an `orient.planningHome` block. The workspace is the same idea generalized, so we extend this module rather than build a parallel one.
- **Trade-off accepted:** launching all feature chats at the same root means sprint-helper can't tell two *parallel* feature chats apart by folder (both cwd = root). It still binds each work **session** to the work item Moran started, so it always knows which feature he's on. For one-thing-at-a-time planning work this loss is near-zero. Revisit only if heavy parallel feature-planning becomes real.

## Architecture

Everything is **local** — no Azure DevOps writes from any of this except reading a feature's title. Three units, all in the server layer, exposed via MCP tools.

### Unit 1 — `server/workspace.ts` (new module)

Owns workspace state and folder scaffolding. Depends on: `getSetting`/`setSetting` (server/timers), `node:fs`, `node:path`, `node:os`. Pure-ish: filesystem side effects are isolated to named functions so the path/name logic can be unit-tested without touching disk.

Settings keys (in the existing `settings` table):
- `workspace_paths` — JSON array of absolute paths Moran has registered as workspaces. (Array, because "ask in any empty folder" supports more than one workspace.)
- `workspace_declined_paths` — JSON array of absolute paths Moran said "no, not a workspace" to. The anti-nag memory: never offer these again.

Exports (names/signatures the MCP tools and orient consume):

- `interface WorkspaceState { paths: string[]; declined: string[] }`
- `getWorkspaces(): WorkspaceState` — reads and parses both settings keys (empty arrays if unset/garbage).
- `isKnownWorkspace(cwd: string): boolean` — true if `cwd` equals or sits under any registered workspace path (resolved, prefix match — same style as `isPlanningHomeCwd`).
- `isDeclinedPath(cwd: string): boolean` — true if `cwd` (resolved) is in `workspace_declined_paths`.
- `declineWorkspace(cwd: string): void` — adds the resolved `cwd` to `workspace_declined_paths` (dedup).
- `registerWorkspace(path, opts): { path: string; scaffolded: string[] }` — resolves+expands `~`, adds to `workspace_paths` (dedup), removes from declined if present, then **ensures the scaffold** (see Unit 3) and returns which pieces it created (`['bmad','claude-md','hook']` — empty if all already present). Creates the folder if missing.
- `featureFolderName(id: number, title: string): string` — pure. Produces `<id>-<slug>` where the slug is the title lowercased, non-alphanumerics → `-`, collapsed, trimmed, capped (~40 chars). e.g. `(426639, "Declarative Continuous Deployment (CD) and Automated Testing Pipeline")` → `426639-declarative-continuous-deployment-cd-and`.
- `createFeatureFolder(workspacePath, id, title): { path: string; created: boolean }` — resolves `<workspacePath>/<featureFolderName>`, `mkdir -p`, returns the absolute path and whether it was newly created (false if it already existed — idempotent).

### Unit 2 — the scaffold seed

The one-time fill (BMAD + planning `CLAUDE.md` + hook) needs a known-good source. **The seed is `~/projects/github-moran/features`** (built this session: `_bmad/`, `.claude/skills/bmad-*`, `.claude/hooks/user-prompt-submit.sh`, `.claude/settings.json`, and the parent `CLAUDE.md`). Stored as a setting `workspace_seed_path` with that default so it's overridable without code change.

`ensureWorkspaceScaffold(workspacePath): string[]` (in workspace.ts):
- If `<workspacePath>/_bmad` missing → copy `_bmad` and `.claude/skills` from the seed. (`cp -R` via `node:fs` `cpSync`.)
- If `<workspacePath>/CLAUDE.md` missing → copy the planning `CLAUDE.md` from the seed.
- If `<workspacePath>/.claude/hooks/user-prompt-submit.sh` missing → copy the hook + write `.claude/settings.json`.
- Returns the list of pieces it created (for honest reporting). Never overwrites an existing piece.

If the seed itself is missing, `registerWorkspace` still registers the path and creates the folder, but returns a clear flag (`seedMissing: true`) so the assistant tells Moran the workspace is set but BMAD couldn't be copied (and how to fix: point `workspace_seed_path` at a folder that has BMAD).

### Unit 3 — orient integration (empty-folder offer)

Extend the existing `orient.planningHome` path in `server/orient.ts`. Add a `workspaceOffer` block to the orient packet:

- `interface OrientWorkspaceOffer { shouldOffer: boolean; cwd: string | null; reason: 'empty-unknown' | null }`
- Computed in `buildOrientPacket`: `shouldOffer` is true when ALL of:
  1. the chat cwd is known (`chatCwdBasename` / a full cwd — see note below),
  2. the folder is **empty or nearly empty** (see definition),
  3. `!isKnownWorkspace(cwd)`,
  4. `!isDeclinedPath(cwd)`.
- **"Nearly empty"** = contains no entries other than an allowlist of harmless dotfiles (`.git`, `.DS_Store`, `.sprint-helper-home`). A folder with real content is never offered.
- SERVER_INSTRUCTIONS gets a short block: when `orient.workspaceOffer.shouldOffer`, ask Moran once — "This is an empty folder and it's not one of your workspaces. Want to make it your sprint-helper workspace?" On yes → `workspace_set`. On no → `workspace_decline`.

**cwd note:** orient currently derives only the *basename* (`chatCwdBasename()`). The empty-folder check needs the **full** cwd (to read the directory and to resolve against registered paths). `buildOrientPacket` runs inside the chat's own MCP process, so `process.cwd()` is the chat's folder — we read the full path there directly. This is a small additive change, not new plumbing.

### MCP tools (thin glue in mcp/server.ts)

1. **`workspace_set`** — input `{ path: string }`. Calls `registerWorkspace`. Returns `{ path, scaffolded, seedMissing }`. Description tells the model to use it when Moran says "this is my workspace" or accepts the empty-folder offer.
2. **`workspace_decline`** — input `{ cwd: string }` (or none → uses process.cwd()). Calls `declineWorkspace`. For the "no" answer to the offer.
3. **`workspace_status`** — input none. Returns `getWorkspaces()` + whether the current cwd is a known/declined workspace. For "where are my workspaces?" and for the model to check state.
4. **`workspace_feature_folder`** — input `{ workItemId: number }`. Reads the feature's title via the existing `getWorkItem` path; resolves the *active* workspace (the cwd if it's a known workspace, else the single registered one, else error asking Moran to set/oepn a workspace); calls `createFeatureFolder`; returns `{ path, created, featureTitle }`. Description: fire when Moran says "let's work on feature #NNNNNN" (or names a feature to start non-code work on).

### SERVER_INSTRUCTIONS additions

- **WORKSPACE block:** what a workspace is; when to offer (empty-unknown folder, from `orient.workspaceOffer`); the "remember the no" behavior; that feature work happens by calling `workspace_feature_folder` and then writing docs into the returned path; that Moran stays in the root chat.
- Cross-reference the existing PLANNING HOME block (workspace generalizes it).

## Data flow

**Bootstrap (once):** Moran makes an empty folder, opens Claude Code in it → orient fires → `workspaceOffer.shouldOffer=true` → assistant asks → Moran says yes → `workspace_set` → `registerWorkspace` adds the path + `ensureWorkspaceScaffold` copies BMAD/CLAUDE.md/hook from the seed → assistant confirms which pieces were created.

**Daily use:** Moran opens Claude Code in the workspace root → orient recognizes a known workspace (no offer) → Moran: "let's work on feature #426639" → assistant calls `workspace_feature_folder(426639)` → tool reads the title, creates `426639-declarative-.../`, returns the path → assistant does discovery/design (BMAD-first, enforced) and writes docs into that subfolder → stories/estimates go to the board via existing sprint-helper tools, parented under the feature.

**Decline path:** empty unknown folder, Moran says no → `workspace_decline(cwd)` → that path is remembered, never offered again.

## Error handling

- **Seed missing:** `workspace_set` still registers + creates the folder, returns `seedMissing: true`; assistant reports it plainly and names the fix (set `workspace_seed_path`).
- **No workspace resolvable in `workspace_feature_folder`:** if cwd isn't a known workspace and there's zero or more-than-one registered, return an error telling the model to ask Moran which workspace (or to set one). Don't guess.
- **Feature title fetch fails:** fall back to a folder named `<id>` alone (still usable); report that the title couldn't be read.
- **Garbage settings JSON:** parse defensively → treat as empty arrays; never throw from a getter.
- **Idempotency:** re-registering a workspace or re-creating an existing feature folder is a no-op that reports "already there" — never overwrites, never errors.

## Testing

Unit tests (`server/workspace.test.ts`), pure logic + fs against temp dirs:
- `featureFolderName` — slug rules: punctuation, parens, length cap, the #426639 real title.
- `getWorkspaces` — parses arrays; garbage/empty/unset → empty arrays.
- `isKnownWorkspace` / `isDeclinedPath` — exact match, sub-path match, non-match.
- `registerWorkspace` — adds path, dedups, removes from declined; returns scaffolded list; `seedMissing` when seed absent (point seed at a temp empty dir).
- `ensureWorkspaceScaffold` — copies missing pieces, skips present ones, returns accurate created-list; never overwrites.
- `createFeatureFolder` — creates, returns absolute path, `created` true then false on repeat.
- orient `workspaceOffer` — a pure helper `workspaceOfferFor({ cwd, entries, known, declined })` so the empty/allowlist/known/declined matrix is unit-tested without disk.

MCP handlers stay thin glue (not unit-tested here — Moran smokes them after an MCP reload).

## Out of scope (YAGNI)

- Browseable archive / history view of all non-code work.
- Per-story folders (feature is the unit; stories live on the board under it).
- Syncing/updating BMAD across existing workspaces (seed updates only affect *new* fills).
- Auto-creating the folder on `session_start` (chosen trigger is naming a feature, not starting a session).
- Any Azure DevOps writes beyond reading a feature title.
