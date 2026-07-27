# Skills Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One `skills_sync` MCP tool that fans the three managed skills (demo, discovery, walkthrough) from the seed folder out to every registered workspace and the global skills folder, plus an hourly drift nudge so hand-edited copies can't silently diverge.

**Architecture:** A new pure-fs module `server/skills-sync.ts` (fingerprint, overwrite-sync, plain-English report, throttled drift check) unit-tested on temp dirs, then wired into `mcp/server.ts`: one new tool, a drift-nudge append in `jsonResult`/`errorResult` (same pipe as the stale-log nudge), and a SERVER_INSTRUCTIONS block making the seed the only edit location.

**Tech Stack:** TypeScript (Node), `node:fs`/`node:crypto`, Vitest, `@modelcontextprotocol/sdk` (existing `registerTool` pattern).

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-27-skills-sync-design.md`.
- Managed skills are exactly `['demo', 'discovery', 'walkthrough']`. BMAD skills and the global-only session subs are out of scope.
- Seed path comes from `getSeedPath()` in `server/workspace.ts` (never hardcode `~/projects/github-moran/features`).
- Global destination: `~/.claude/skills/sprint-helper-plus/skills`.
- All user-facing report/nudge text is pre-formatted plain English on the server (echo-API-strings rule). Banned words (slack, scope-as-noun, WIP, etc.) never appear in shipped strings.
- Never delete a destination skill because the seed lost it — report and skip.
- Drift check: at most once per hour per server process, must never throw.
- Tests follow existing patterns: mock `./timers` with a Map (like `server/workspace.test.ts`), temp dirs via `mkdtempSync`, fake timers via `vi.useFakeTimers` (like `server/log-nudge.test.ts`).
- MCP tool handlers are NOT unit-tested (project convention) — user smokes them.

---

### Task 1: `server/skills-sync.ts` — fingerprint, sync, report (pure fs)

**Files:**
- Create: `server/skills-sync.ts`
- Test: `server/skills-sync.test.ts`

**Interfaces:**
- Consumes: nothing from this repo yet (pure fs + `node:crypto`).
- Produces (Task 2 and Task 3 rely on these exact names):
  - `MANAGED_SKILLS: readonly string[]`
  - `globalSkillsDir(): string`
  - `dirFingerprint(dir: string): string | null` — null when dir absent
  - `interface SkillSyncOutcome { skill: string; missingSeed: boolean; updated: string[]; current: string[] }`
  - `syncManagedSkills(seedSkillsDir: string, destDirs: string[]): SkillSyncOutcome[]`
  - `formatSyncReport(outcomes: SkillSyncOutcome[], deadWorkspaces: string[]): string`

- [ ] **Step 1: Write the failing test**

Create `server/skills-sync.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// skills-sync's drift check (Task 2) reads settings via ./timers and workspace
// state via ./workspace's use of ./timers — mock the settings store once here.
const { store } = vi.hoisted(() => ({ store: new Map<string, string>() }));
vi.mock('./timers', () => ({
  getSetting: (k: string) => store.get(k),
  setSetting: (k: string, v: string) => { store.set(k, v); },
}));

import {
  MANAGED_SKILLS,
  dirFingerprint,
  syncManagedSkills,
  formatSyncReport,
} from './skills-sync';

let root: string;
beforeEach(() => {
  store.clear();
  root = mkdtempSync(join(tmpdir(), 'skills-sync-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** Make a skill folder with given files: { 'SKILL.md': '...', 'sub/x.md': '...' } */
function makeSkill(base: string, name: string, files: Record<string, string>) {
  for (const [rel, content] of Object.entries(files)) {
    const p = join(base, name, rel);
    mkdirSync(join(p, '..'), { recursive: true });
    writeFileSync(p, content);
  }
}

describe('MANAGED_SKILLS', () => {
  it('is exactly the three workspace-craft skills', () => {
    expect([...MANAGED_SKILLS]).toEqual(['demo', 'discovery', 'walkthrough']);
  });
});

describe('dirFingerprint', () => {
  it('returns null for a missing dir', () => {
    expect(dirFingerprint(join(root, 'nope'))).toBeNull();
  });

  it('same content → same fingerprint; different content → different', () => {
    makeSkill(join(root, 'a'), 'demo', { 'SKILL.md': 'v1' });
    makeSkill(join(root, 'b'), 'demo', { 'SKILL.md': 'v1' });
    makeSkill(join(root, 'c'), 'demo', { 'SKILL.md': 'v2' });
    const a = dirFingerprint(join(root, 'a', 'demo'));
    const b = dirFingerprint(join(root, 'b', 'demo'));
    const c = dirFingerprint(join(root, 'c', 'demo'));
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  it('an extra file changes the fingerprint (so deletions sync too)', () => {
    makeSkill(join(root, 'a'), 'demo', { 'SKILL.md': 'v1' });
    makeSkill(join(root, 'b'), 'demo', { 'SKILL.md': 'v1', 'extra.md': 'x' });
    expect(dirFingerprint(join(root, 'a', 'demo'))).not.toBe(
      dirFingerprint(join(root, 'b', 'demo')),
    );
  });
});

describe('syncManagedSkills', () => {
  it('overwrites a stale copy and reports it updated', () => {
    const seed = join(root, 'seed');
    const dest = join(root, 'ws', '.claude', 'skills');
    for (const s of MANAGED_SKILLS) makeSkill(seed, s, { 'SKILL.md': 'new' });
    makeSkill(dest, 'demo', { 'SKILL.md': 'old', 'stray.md': 'gone' });

    const out = syncManagedSkills(seed, [dest]);

    const demo = out.find(o => o.skill === 'demo')!;
    expect(demo.updated).toEqual([dest]);
    expect(demo.current).toEqual([]);
    expect(readFileSync(join(dest, 'demo', 'SKILL.md'), 'utf8')).toBe('new');
    // removed-in-seed file disappears at the destination (delete + copy)
    expect(existsSync(join(dest, 'demo', 'stray.md'))).toBe(false);
  });

  it('leaves a current copy untouched and reports it current', () => {
    const seed = join(root, 'seed');
    const dest = join(root, 'ws', '.claude', 'skills');
    for (const s of MANAGED_SKILLS) {
      makeSkill(seed, s, { 'SKILL.md': 'same' });
      makeSkill(dest, s, { 'SKILL.md': 'same' });
    }
    const out = syncManagedSkills(seed, [dest]);
    for (const o of out) {
      expect(o.updated).toEqual([]);
      expect(o.current).toEqual([dest]);
    }
  });

  it('adds a skill folder missing at the destination', () => {
    const seed = join(root, 'seed');
    const dest = join(root, 'ws', '.claude', 'skills'); // dest dir doesn't even exist
    for (const s of MANAGED_SKILLS) makeSkill(seed, s, { 'SKILL.md': 'v1' });

    const out = syncManagedSkills(seed, [dest]);

    expect(out.find(o => o.skill === 'walkthrough')!.updated).toEqual([dest]);
    expect(readFileSync(join(dest, 'walkthrough', 'SKILL.md'), 'utf8')).toBe('v1');
  });

  it('a skill absent from the seed is skipped and flagged, destination untouched', () => {
    const seed = join(root, 'seed');
    const dest = join(root, 'ws', '.claude', 'skills');
    makeSkill(seed, 'demo', { 'SKILL.md': 'v1' }); // no discovery, no walkthrough in seed
    makeSkill(dest, 'discovery', { 'SKILL.md': 'keep me' });

    const out = syncManagedSkills(seed, [dest]);

    const disc = out.find(o => o.skill === 'discovery')!;
    expect(disc.missingSeed).toBe(true);
    expect(disc.updated).toEqual([]);
    expect(readFileSync(join(dest, 'discovery', 'SKILL.md'), 'utf8')).toBe('keep me');
  });

  it('fans out to several destinations independently', () => {
    const seed = join(root, 'seed');
    const d1 = join(root, 'ws1', '.claude', 'skills');
    const d2 = join(root, 'global');
    for (const s of MANAGED_SKILLS) makeSkill(seed, s, { 'SKILL.md': 'v2' });
    makeSkill(d1, 'demo', { 'SKILL.md': 'v2' }); // current in d1
    makeSkill(d2, 'demo', { 'SKILL.md': 'v1' }); // stale in d2

    const demo = syncManagedSkills(seed, [d1, d2]).find(o => o.skill === 'demo')!;

    expect(demo.current).toEqual([d1]);
    expect(demo.updated).toEqual([d2]);
  });
});

describe('formatSyncReport', () => {
  it('names what changed, what was already current, and what the seed is missing', () => {
    const text = formatSyncReport(
      [
        { skill: 'demo', missingSeed: false, updated: ['/a', '/b'], current: [] },
        { skill: 'discovery', missingSeed: false, updated: [], current: ['/a', '/b'] },
        { skill: 'walkthrough', missingSeed: true, updated: [], current: [] },
      ],
      ['/dead/ws'],
    );
    expect(text).toContain('demo: updated in 2 places');
    expect(text).toContain('discovery: already current everywhere');
    expect(text).toContain('walkthrough: missing from the seed — skipped');
    expect(text).toContain('/dead/ws');
  });

  it('singular wording for one place', () => {
    const text = formatSyncReport(
      [{ skill: 'demo', missingSeed: false, updated: ['/a'], current: [] }],
      [],
    );
    expect(text).toContain('demo: updated in 1 place');
    expect(text).not.toContain('1 places');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run server/skills-sync.test.ts`
Expected: FAIL — cannot resolve `./skills-sync` (module doesn't exist yet).

- [ ] **Step 3: Write minimal implementation**

Create `server/skills-sync.ts`:

```ts
/**
 * Managed-skill sync. The three workspace-craft skills (demo, discovery,
 * walkthrough) live as COPIES: seed → every registered workspace → the global
 * skills folder. The seed is the only place to EDIT them; the `skills_sync`
 * MCP tool fans the seed version out. A throttled drift check (Task 2) rides
 * the every-tool-response nudge pipe so hand-edited copies can't silently
 * diverge. Sessions read skill bodies from disk on use, so fixing the files
 * fixes every session at once — no restart.
 *
 * Sync semantics: destination folder is REPLACED (delete + recursive copy) so
 * files removed from the seed disappear too. A skill missing from the seed is
 * never deleted downstream — reported and skipped; that needs a human look.
 */
import { join, resolve, relative, sep } from 'node:path';
import { existsSync, mkdirSync, cpSync, rmSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';

export const MANAGED_SKILLS: readonly string[] = ['demo', 'discovery', 'walkthrough'];

/** Where the always-on copies live (the `sprint-helper-plus` skill's subs). */
export function globalSkillsDir(): string {
  return join(homedir(), '.claude', 'skills', 'sprint-helper-plus', 'skills');
}

/** Recursive list of a dir's file paths relative to it, sorted for stability. */
function listFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) out.push(relative(dir, p).split(sep).join('/'));
    }
  };
  walk(dir);
  return out.sort();
}

/** Stable content fingerprint of a folder (names + bytes). Missing dir → null. */
export function dirFingerprint(dir: string): string | null {
  if (!existsSync(dir)) return null;
  const h = createHash('sha1');
  for (const rel of listFiles(dir)) {
    h.update(rel);
    h.update('\0');
    h.update(readFileSync(join(dir, rel)));
    h.update('\0');
  }
  return h.digest('hex');
}

export interface SkillSyncOutcome {
  skill: string;
  missingSeed: boolean;
  updated: string[]; // destination skills-dirs whose copy was replaced
  current: string[]; // destination skills-dirs that already matched
}

/** Overwrite-sync each managed skill from `seedSkillsDir` into every dir in
 *  `destDirs` (each a `.../skills` folder). Pure fs over the given paths. */
export function syncManagedSkills(seedSkillsDir: string, destDirs: string[]): SkillSyncOutcome[] {
  return MANAGED_SKILLS.map(skill => {
    const src = join(seedSkillsDir, skill);
    const srcFp = dirFingerprint(src);
    if (srcFp === null) return { skill, missingSeed: true, updated: [], current: [] };
    const updated: string[] = [];
    const current: string[] = [];
    for (const destDir of destDirs) {
      const dest = join(destDir, skill);
      if (dirFingerprint(dest) === srcFp) {
        current.push(destDir);
        continue;
      }
      rmSync(dest, { recursive: true, force: true });
      mkdirSync(destDir, { recursive: true });
      cpSync(src, dest, { recursive: true });
      updated.push(destDir);
    }
    return { skill, missingSeed: false, updated, current };
  });
}

/** Plain-English report the tool ships verbatim (echo-API-strings rule). */
export function formatSyncReport(
  outcomes: SkillSyncOutcome[],
  deadWorkspaces: string[],
): string {
  const lines = outcomes.map(o => {
    if (o.missingSeed) return `${o.skill}: missing from the seed — skipped (nothing was deleted)`;
    if (o.updated.length === 0) return `${o.skill}: already current everywhere`;
    const n = o.updated.length;
    return `${o.skill}: updated in ${n} ${n === 1 ? 'place' : 'places'}`;
  });
  for (const w of deadWorkspaces) {
    lines.push(`Skipped a workspace folder that no longer exists on disk: ${w}`);
  }
  lines.push('Every open chat picks the new skill text up on its next use — no restart needed.');
  return lines.join('\n');
}
```

(`resolve` is imported for Task 2's drift check; if the linter flags it as unused after this step, keep it — Task 2 uses it.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run server/skills-sync.test.ts`
Expected: PASS (all tests in the file).

- [ ] **Step 5: Commit**

```bash
git add server/skills-sync.ts server/skills-sync.test.ts
git commit -m "feat(skills): managed-skill sync — fingerprint, overwrite-sync, plain report"
```

---

### Task 2: throttled drift nudge in `server/skills-sync.ts`

**Files:**
- Modify: `server/skills-sync.ts` (append to the file from Task 1)
- Test: `server/skills-sync.test.ts` (append)

**Interfaces:**
- Consumes: `getSetting`/`setSetting` from `./timers`; `getSeedPath`, `getWorkspaces`, `expandHome` from `./workspace`; Task 1's `MANAGED_SKILLS`, `dirFingerprint`, `globalSkillsDir`.
- Produces (Task 3 relies on these exact names):
  - `SKILLS_DRIFT_CHECKED_KEY = 'skills_drift_checked_at'`
  - `checkSkillsDriftNudge(): string | null`

- [ ] **Step 1: Write the failing test**

Append to `server/skills-sync.test.ts`. Note: the `./timers` mock from Task 1's test header already covers BOTH this module's throttle key AND `./workspace`'s settings reads (workspace.ts gets its state through `./timers` too), so seed + workspace paths are injected through the same `store`.

```ts
import { checkSkillsDriftNudge, SKILLS_DRIFT_CHECKED_KEY } from './skills-sync';
import { SEED_KEY, WORKSPACE_PATHS_KEY } from './workspace';

describe('checkSkillsDriftNudge', () => {
  // The global skills dir is under the real home folder — tests must never
  // touch it. Point HOME at a temp dir for the whole describe block.
  let home: string;
  let seedRoot: string;
  let ws: string;
  const OLD_HOME = process.env.HOME;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-27T09:00:00.000Z'));
    home = mkdtempSync(join(tmpdir(), 'skills-home-'));
    process.env.HOME = home;
    seedRoot = join(root, 'seed-root');
    ws = join(root, 'ws');
    store.set(SEED_KEY, seedRoot);
    store.set(WORKSPACE_PATHS_KEY, JSON.stringify([ws]));
    mkdirSync(ws, { recursive: true });
    for (const s of MANAGED_SKILLS) {
      makeSkill(join(seedRoot, '.claude', 'skills'), s, { 'SKILL.md': 'v1' });
      makeSkill(join(ws, '.claude', 'skills'), s, { 'SKILL.md': 'v1' });
      makeSkill(join(home, '.claude', 'skills', 'sprint-helper-plus', 'skills'), s, {
        'SKILL.md': 'v1',
      });
    }
  });

  afterEach(() => {
    process.env.HOME = OLD_HOME;
    vi.useRealTimers();
    rmSync(home, { recursive: true, force: true });
  });

  it('returns null when every copy matches the seed', () => {
    expect(checkSkillsDriftNudge()).toBeNull();
  });

  it('names the drifted skill when a workspace copy differs', () => {
    writeFileSync(join(ws, '.claude', 'skills', 'demo', 'SKILL.md'), 'hand-edited');
    const nudge = checkSkillsDriftNudge();
    expect(nudge).toContain('demo');
    expect(nudge).toContain('skills_sync');
  });

  it('throttles: second call within the hour returns null even with drift', () => {
    writeFileSync(join(ws, '.claude', 'skills', 'demo', 'SKILL.md'), 'hand-edited');
    expect(checkSkillsDriftNudge()).not.toBeNull();
    vi.advanceTimersByTime(59 * 60 * 1000);
    expect(checkSkillsDriftNudge()).toBeNull();
    vi.advanceTimersByTime(2 * 60 * 1000); // past the hour
    expect(checkSkillsDriftNudge()).not.toBeNull();
  });

  it('a missing destination copy counts as drift', () => {
    rmSync(join(ws, '.claude', 'skills', 'walkthrough'), { recursive: true, force: true });
    expect(checkSkillsDriftNudge()).toContain('walkthrough');
  });

  it('a skill missing from the seed is NOT drift (sync reports it instead)', () => {
    rmSync(join(seedRoot, '.claude', 'skills', 'discovery'), { recursive: true, force: true });
    expect(checkSkillsDriftNudge()).toBeNull();
  });

  it('never throws when the seed root is gone entirely', () => {
    rmSync(seedRoot, { recursive: true, force: true });
    expect(checkSkillsDriftNudge()).toBeNull();
  });

  it('a dead workspace path is ignored, not drift', () => {
    store.set(WORKSPACE_PATHS_KEY, JSON.stringify([ws, join(root, 'gone')]));
    expect(checkSkillsDriftNudge()).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run server/skills-sync.test.ts`
Expected: FAIL — `checkSkillsDriftNudge` and `SKILLS_DRIFT_CHECKED_KEY` are not exported.

- [ ] **Step 3: Write minimal implementation**

Append to `server/skills-sync.ts`:

```ts
import { getSetting, setSetting } from './timers';
import { getSeedPath, getWorkspaces, expandHome } from './workspace';

export const SKILLS_DRIFT_CHECKED_KEY = 'skills_drift_checked_at';
const DRIFT_CHECK_INTERVAL_MS = 60 * 60 * 1000; // at most one check per hour

/**
 * Throttled drift check for the every-tool-response nudge pipe (same idea as
 * checkStaleLogNudge). Compares the seed's managed skills against every live
 * destination; when any copy differs, returns one plain-English line telling
 * the assistant to run `skills_sync`. Never throws — a broken fs read must
 * not break a tool response.
 */
export function checkSkillsDriftNudge(): string | null {
  try {
    const now = Date.now();
    const last = getSetting(SKILLS_DRIFT_CHECKED_KEY);
    if (last && now - Date.parse(last) < DRIFT_CHECK_INTERVAL_MS) return null;
    setSetting(SKILLS_DRIFT_CHECKED_KEY, new Date(now).toISOString());

    const seedSkills = join(resolve(expandHome(getSeedPath())), '.claude', 'skills');
    const liveWorkspaces = getWorkspaces().paths
      .map(p => resolve(expandHome(p)))
      .filter(p => existsSync(p));
    const destDirs = [...liveWorkspaces.map(p => join(p, '.claude', 'skills')), globalSkillsDir()];

    const drifted: string[] = [];
    for (const skill of MANAGED_SKILLS) {
      const seedFp = dirFingerprint(join(seedSkills, skill));
      if (seedFp === null) continue; // seed missing → skills_sync reports it, not drift
      if (destDirs.some(d => dirFingerprint(join(d, skill)) !== seedFp)) drifted.push(skill);
    }
    if (drifted.length === 0) return null;

    const names = drifted.join(', ');
    return [
      '',
      `🧰 SKILL COPIES OUT OF SYNC — the ${names} skill${drifted.length === 1 ? "'s copies don't" : " copies don't"} all match the seed.`,
      'Run the `skills_sync` tool to fan the seed version out to every workspace and the global folder.',
      'This check runs at most once an hour.',
    ].join('\n');
  } catch {
    return null;
  }
}
```

Move both import lines to the top of the file with the other imports (`node:` imports first, then `./timers`, `./workspace` — matching the repo's existing style). Note `globalSkillsDir()` reads `homedir()` at CALL time (not module load), which is what lets the test point `HOME` at a temp dir — don't cache it in a module constant.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run server/skills-sync.test.ts`
Expected: PASS. If `homedir()` ignores the `HOME` override on your platform, the global-dir copies in the test setup will look "missing" and the all-current test fails — in that case swap the `process.env.HOME` trick for `vi.mock('node:os', ...)` with a controllable `homedir`; keep the rest unchanged.

- [ ] **Step 5: Run the whole suite to catch fallout**

Run: `npm test`
Expected: all green (294+ tests).

- [ ] **Step 6: Commit**

```bash
git add server/skills-sync.ts server/skills-sync.test.ts
git commit -m "feat(skills): hourly drift nudge — hand-edited skill copies get flagged"
```

---

### Task 3: wire into `mcp/server.ts` — tool, nudge pipe, instructions

**Files:**
- Modify: `mcp/server.ts` (four spots: imports ~line 25–80, SERVER_INSTRUCTIONS ~line 1281, `jsonResult`/`errorResult` ~line 1309–1329, tool registration after `workspace_status` ~line 2729)

**Interfaces:**
- Consumes (from Tasks 1–2, exact names): `syncManagedSkills`, `formatSyncReport`, `globalSkillsDir`, `checkSkillsDriftNudge` from `../server/skills-sync.js`; existing `getSeedPath`, `getWorkspaces`, `expandHome` from `../server/workspace.js` (already imported there — extend that import list if any of the three is missing); existing `existsSync` — add it to the `node:fs` import (currently only `readdirSync`); `join`, `resolve` from `node:path` (add the import — the file has none today).
- Produces: the `skills_sync` MCP tool; drift nudge on every tool response.

- [ ] **Step 1: Add the imports**

In the import block (after line 35's `log-nudge` import):

```ts
import {
  syncManagedSkills,
  formatSyncReport,
  globalSkillsDir,
  checkSkillsDriftNudge,
} from '../server/skills-sync.js';
```

Change line 25 to:

```ts
import { existsSync, readdirSync } from 'node:fs';
```

Add (near line 25):

```ts
import { join, resolve } from 'node:path';
```

Check the existing `../server/workspace.js` import (lines 65–78) contains `getSeedPath`, `getWorkspaces`, `expandHome`; add any that are missing.

- [ ] **Step 2: Append the drift nudge to both response helpers**

In `jsonResult` (line ~1316) and `errorResult` (line ~1323), right after the existing stale-nudge lines, add the same two lines to each:

```ts
    const drift = checkSkillsDriftNudge();
    if (drift) blocks.push({ type: 'text', text: drift });
```

Also update the comment above `jsonResult` (line ~1305) to mention both checks:

```ts
 * Every successful tool response also gets two checks appended: the stale
 * session-log nudge (server/log-nudge.ts) and the managed-skills drift nudge
 * (server/skills-sync.ts). Both return null almost always; when one fires the
 * assistant gets a one-line reminder inside its own context.
```

- [ ] **Step 3: Register the `skills_sync` tool**

Immediately after the `workspace_status` registration (after line ~2729), add:

```ts
server.registerTool(
  'skills_sync',
  {
    title: 'Sync the managed skills from the seed to every copy',
    description:
      "Fan the three managed workspace skills (demo, discovery, walkthrough) out from the seed folder to every registered workspace and the global skills folder, overwriting stale copies. The seed is the ONLY place these skills get edited — after any edit there, call this. One run fixes every chat at once (skills are read from disk when used; no restart). Fire when Moran asks to sync/update the skills, or when a tool response carries the out-of-sync nudge. Returns a plain-English report — echo it verbatim.",
    inputSchema: {},
  },
  async () => {
    try {
      const seedSkills = join(resolve(expandHome(getSeedPath())), '.claude', 'skills');
      const paths = getWorkspaces().paths.map(p => resolve(expandHome(p)));
      const dead = paths.filter(p => !existsSync(p));
      const live = paths.filter(p => existsSync(p));
      const destDirs = [...live.map(p => join(p, '.claude', 'skills')), globalSkillsDir()];
      const outcomes = syncManagedSkills(seedSkills, destDirs);
      return jsonResult({ report: formatSyncReport(outcomes, dead) });
    } catch (e) {
      return errorResult(e instanceof Error ? e.message : String(e));
    }
  },
);
```

- [ ] **Step 4: Add the SERVER_INSTRUCTIONS block**

In the SERVER_INSTRUCTIONS template string, right BEFORE the `EXPLICIT MENU (\`/sprint-helper\`):` paragraph (line ~1281), insert:

```
MANAGED SKILLS (\`skills_sync\`): the three workspace-craft skills — demo,
discovery, walkthrough — live as copies: the seed folder (the source of
truth), every registered workspace's \`.claude/skills\`, and the global
\`~/.claude/skills/sprint-helper-plus/skills\`. RULES:
  - EDIT AT THE SEED ONLY (\`getSeedPath\` root, \`.claude/skills/<name>\`),
    then call \`skills_sync\` to fan the change out. Never hand-copy between
    the folders; never edit a workspace or global copy directly.
  - Any chat may call it; one run fixes every session at once, because a
    session reads a skill's body from disk at the moment it uses it. No
    restart needed for skill edits. (These SERVER_INSTRUCTIONS themselves
    are the exception: a changed manual only reaches a chat when its MCP
    connection restarts.)
  - The server checks about once an hour that all copies still match the
    seed; if a tool response carries the out-of-sync line, run
    \`skills_sync\` and echo its report.

```

- [ ] **Step 5: Verify typecheck and full test suite**

Run: `npm run typecheck && npm test`
Expected: both clean.

- [ ] **Step 6: Commit**

```bash
git add mcp/server.ts
git commit -m "feat(mcp): skills_sync tool + drift nudge on every response + seed-edit rule in instructions"
```

- [ ] **Step 7: USER SMOKE (per project convention — MCP handlers get no unit tests)**

Ask the user to reload the MCP connection (so the new tool registers), then in any sprint-helper chat:

1. Say "sync the skills" → the report should say all three are already current everywhere (we hand-synced them on 2026-07-27).
2. Edit one character in the SEED's `demo/SKILL.md`, run the tool again → "demo: updated in N places", and the workspace + global copies now match.
3. Optional drift check: hand-edit a WORKSPACE copy, wait for/trigger the next tool call after the hourly window — the response should carry the out-of-sync line.

---

## Self-Review

**1. Spec coverage:**
- `skills_sync` tool, no inputs, any chat → Task 3 Step 3. ✓
- Seed canonical via `getSeedPath()` → Tasks 2–3 (never hardcoded). ✓
- Managed list explicit, BMAD + session subs excluded → Task 1 `MANAGED_SKILLS`; spec's out-of-scope untouched (existing `syncSeedSkills` add-only path unchanged). ✓
- Destinations: live workspaces + global; dead workspace skipped and reported → Task 3 handler + Task 1 `formatSyncReport(deadWorkspaces)`. ✓
- Overwrite = delete + copy, removed files disappear → Task 1 impl + test. ✓
- Compare-first, plain-English pre-formatted report → Task 1 `dirFingerprint` + `formatSyncReport` + tests. ✓
- Missing seed skill: skip + report, never delete downstream → Task 1 test 'absent from the seed'. ✓
- Drift nudge on the every-response pipe, ≤ once/hour, never throws → Task 2 + Task 3 Step 2. ✓
- SERVER_INSTRUCTIONS block incl. the reconnect limitation → Task 3 Step 4. ✓
- Testing split (pure fs unit-tested, handlers user-smoked) → Tasks 1–2 tests; Task 3 Step 7. ✓
- Success criteria → covered by Task 3 Step 7 smoke.

**2. Placeholder scan:** No TBD/TODO; all code steps show full code; commands exact. ✓

**3. Type consistency:**
- `syncManagedSkills(seedSkillsDir, destDirs)` identical in Task 1 def, Task 1 tests, Task 3 handler. ✓
- `SkillSyncOutcome` fields (`skill/missingSeed/updated/current`) match `formatSyncReport` usage and tests. ✓
- `checkSkillsDriftNudge(): string | null` matches Task 3's append lines. ✓
- `globalSkillsDir()` used in Task 2 impl + Task 3 handler; reads `homedir()` at call time (Task 2 note). ✓
- `dirFingerprint` returns `string | null`; null handled in both sync (missingSeed) and drift (skip). ✓
