/**
 * Workspace state + feature-folder scaffolding.
 *
 * A "workspace" is a visible folder Moran launches Claude Code in for non-code
 * work (discovery, design, small demos). BMAD + the planning CLAUDE.md + the
 * enforcement hook live once at its root; each feature gets a subfolder for its
 * design docs. Generalizes the older planning-home concept (see planning-home.ts).
 *
 * All state lives in the settings table as JSON arrays, parsed defensively.
 * Everything here is LOCAL — no Azure DevOps access.
 */
import { resolve } from 'node:path';
import { getSetting, setSetting } from './timers';

export const WORKSPACE_PATHS_KEY = 'workspace_paths';
export const WORKSPACE_DECLINED_KEY = 'workspace_declined_paths';
export const MANAGED_FEATURES_KEY = 'managed_feature_ids';

export interface WorkspaceState {
  paths: string[];
  declined: string[];
}

/** Parse a settings value expected to be a JSON array; garbage/unset → []. */
function readJsonArray<T>(key: string, guard: (v: unknown) => v is T): T[] {
  const raw = getSetting(key);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(guard) : [];
  } catch {
    return [];
  }
}

const isString = (v: unknown): v is string => typeof v === 'string';
const isNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

function writeJsonArray(key: string, arr: unknown[]): void {
  setSetting(key, JSON.stringify(arr));
}

export function getWorkspaces(): WorkspaceState {
  return {
    paths: readJsonArray(WORKSPACE_PATHS_KEY, isString),
    declined: readJsonArray(WORKSPACE_DECLINED_KEY, isString),
  };
}

function underAny(cwd: string, bases: string[]): boolean {
  const abs = resolve(cwd);
  return bases.some(b => {
    const base = resolve(b);
    return abs === base || abs.startsWith(base + '/');
  });
}

export function isKnownWorkspace(cwd: string): boolean {
  return underAny(cwd, getWorkspaces().paths);
}

export function isDeclinedPath(cwd: string): boolean {
  const abs = resolve(cwd);
  return getWorkspaces().declined.some(d => resolve(d) === abs);
}

export function declineWorkspace(cwd: string): void {
  const abs = resolve(cwd);
  const declined = getWorkspaces().declined.map(d => resolve(d));
  if (!declined.includes(abs)) {
    declined.push(abs);
    writeJsonArray(WORKSPACE_DECLINED_KEY, declined);
  }
}

export function getManagedFeatureIds(): number[] {
  return readJsonArray(MANAGED_FEATURES_KEY, isNumber);
}

export function addManagedFeatureId(id: number): void {
  const ids = getManagedFeatureIds();
  if (!ids.includes(id)) {
    ids.push(id);
    writeJsonArray(MANAGED_FEATURES_KEY, ids);
  }
}

export function removeManagedFeatureId(id: number): void {
  const ids = getManagedFeatureIds().filter(x => x !== id);
  writeJsonArray(MANAGED_FEATURES_KEY, ids);
}
