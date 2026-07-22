// server/discovery-store.ts
/**
 * Filesystem wrapper for the discovery source file. The pure shape/logic lives
 * in server/discovery.ts; this reads/writes it in a feature's workspace folder
 * and exposes the read-from-any-session status summary. Reads never throw.
 */
import { join } from 'node:path';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import {
  parseDiscoveryDoc, renderDiscoveryMarkdown, discoveryFinishedCheck,
  type DiscoveryDoc,
} from './discovery';

export const DISCOVERY_FILE = 'discovery.json';
export const DISCOVERY_MD = 'discovery.md';

export function readDiscoveryDoc(featureFolderPath: string): DiscoveryDoc | null {
  const p = join(featureFolderPath, DISCOVERY_FILE);
  if (!existsSync(p)) return null;
  try {
    return parseDiscoveryDoc(readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

/** Write the source JSON and regenerate the markdown render beside it, so the
 *  two never drift — the md is always rebuilt from the json on every write. */
export function writeDiscoveryDoc(
  featureFolderPath: string,
  doc: DiscoveryDoc,
  featureDisplayName: string,
): void {
  writeFileSync(join(featureFolderPath, DISCOVERY_FILE), JSON.stringify(doc, null, 2) + '\n');
  writeFileSync(
    join(featureFolderPath, DISCOVERY_MD),
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
