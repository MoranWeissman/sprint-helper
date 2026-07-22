// server/discovery-store.ts
/**
 * Filesystem wrapper for the discovery source file. The pure shape/logic lives
 * in server/discovery.ts; this reads/writes it in a feature's workspace folder
 * and exposes the read-from-any-session status summary. Reads never throw.
 */
import { join } from 'node:path';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import {
  parseDiscoveryDoc, renderDiscoveryMarkdown, discoveryFinishedCheck,
  type DiscoveryDoc,
} from './discovery';

/** Discovery files live in a `discovery/` subfolder of the feature folder, so
 *  discovery / design / demo files stay cleanly separated. */
export const DISCOVERY_DIR = 'discovery';
export const DISCOVERY_FILE = 'discovery.json';
export const DISCOVERY_MD = 'discovery.md';

/** The discovery file's path, preferring the `discovery/` subfolder but falling
 *  back to the feature-folder root for anything written before the split. */
function discoveryJsonPath(featureFolderPath: string): string {
  const inDir = join(featureFolderPath, DISCOVERY_DIR, DISCOVERY_FILE);
  if (existsSync(inDir)) return inDir;
  const atRoot = join(featureFolderPath, DISCOVERY_FILE);
  if (existsSync(atRoot)) return atRoot; // legacy location
  return inDir; // default target when nothing exists yet
}

export function readDiscoveryDoc(featureFolderPath: string): DiscoveryDoc | null {
  const p = discoveryJsonPath(featureFolderPath);
  if (!existsSync(p)) return null;
  try {
    return parseDiscoveryDoc(readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

/** Write the source JSON and regenerate the markdown render beside it, so the
 *  two never drift — the md is always rebuilt from the json on every write.
 *  Both land in the feature's `discovery/` subfolder (created if absent). */
export function writeDiscoveryDoc(
  featureFolderPath: string,
  doc: DiscoveryDoc,
  featureDisplayName: string,
): void {
  const dir = join(featureFolderPath, DISCOVERY_DIR);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, DISCOVERY_FILE), JSON.stringify(doc, null, 2) + '\n');
  writeFileSync(
    join(dir, DISCOVERY_MD),
    renderDiscoveryMarkdown(doc, { featureDisplayName }),
  );
}

export interface DiscoveryStatus {
  hasDiscovery: boolean;
  finished: boolean;
  missing: string[];
  demoStatus: string;
}

export function discoveryStatus(featureFolderPath: string): DiscoveryStatus {
  const doc = readDiscoveryDoc(featureFolderPath);
  const check = discoveryFinishedCheck(doc);
  return {
    hasDiscovery: doc !== null,
    finished: check.ok,
    missing: check.missing,
    demoStatus: doc?.demo.status ?? 'none',
  };
}
