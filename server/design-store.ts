// server/design-store.ts
/**
 * Filesystem wrapper for the design source file. The pure shape/logic lives
 * in server/design.ts; this reads/writes it in a feature's workspace folder.
 * Same discipline as server/discovery-store.ts: try/catch everywhere, a
 * missing `design/` folder is a normal state, reads never throw.
 */
import { join } from 'node:path';
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { parseDesignDoc, renderDesignMarkdown, type DesignDoc } from './design';
import { listMeetingsFromDir, MEETINGS_DIR, type DiscoveryMeeting } from './discovery-store';

/** Design files live in a `design/` subfolder of the feature folder, mirroring
 *  discovery's `discovery/` split — discovery / design / demo stay separate. */
export const DESIGN_DIR = 'design';
export const DESIGN_FILE = 'design.json';
export const DESIGN_MD = 'design.md';
export const DIAGRAMS_DIR = 'diagrams';

/** Only names like `deploy-flow.svg` are ever read back off disk — this
 *  guards against `../..` traversal once diagrams are served over HTTP, and
 *  keeps names with spaces or other odd characters out of the list too. */
export const SAFE_SVG_NAME = /^[\w][\w.-]*\.svg$/;

export function readDesignDoc(featureFolderPath: string): DesignDoc | null {
  const p = join(featureFolderPath, DESIGN_DIR, DESIGN_FILE);
  if (!existsSync(p)) return null;
  try {
    return parseDesignDoc(readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

/** Write the source JSON and regenerate the markdown render beside it, so the
 *  two never drift — the md is always rebuilt from the json on every write.
 *  Both land in the feature's `design/` subfolder (created if absent). */
export function writeDesignDoc(
  featureFolderPath: string,
  doc: DesignDoc,
  opts: { featureDisplayName: string },
): void {
  const dir = join(featureFolderPath, DESIGN_DIR);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, DESIGN_FILE), JSON.stringify(doc, null, 2) + '\n');
  writeFileSync(join(dir, DESIGN_MD), renderDesignMarkdown(doc, opts));
}

/** List a feature's design-meeting summaries — same shape and rules as
 *  discovery's `listMeetings`, just reading `design/meetings/` instead. */
export function listDesignMeetings(featureFolderPath: string): DiscoveryMeeting[] {
  return listMeetingsFromDir(join(featureFolderPath, DESIGN_DIR, MEETINGS_DIR));
}

/** Names of `design/diagrams/*.svg`, sorted. Missing folder → []. Never throws. */
export function listDiagrams(featureFolderPath: string): string[] {
  const dir = join(featureFolderPath, DESIGN_DIR, DIAGRAMS_DIR);
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter(e => e.isFile() && SAFE_SVG_NAME.test(e.name))
      .map(e => e.name)
      .sort();
  } catch {
    return [];
  }
}

/** Absolute path to a diagram file, or null when `name` isn't a bare,
 *  safe `.svg` filename (path-safety — this gets served over HTTP later). */
export function diagramPath(featureFolderPath: string, name: string): string | null {
  if (!SAFE_SVG_NAME.test(name)) return null;
  return join(featureFolderPath, DESIGN_DIR, DIAGRAMS_DIR, name);
}
