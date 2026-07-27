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
