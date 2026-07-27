// server/discovery-store.ts
/**
 * Filesystem wrapper for the discovery source file. The pure shape/logic lives
 * in server/discovery.ts; this reads/writes it in a feature's workspace folder
 * and exposes the read-from-any-session status summary. Reads never throw.
 */
import { join } from 'node:path';
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import {
  parseDiscoveryDoc, renderDiscoveryMarkdown, discoveryFinishedCheck,
  type DiscoveryDoc,
} from './discovery';

/** Discovery files live in a `discovery/` subfolder of the feature folder, so
 *  discovery / design / demo files stay cleanly separated. */
export const DISCOVERY_DIR = 'discovery';
export const DISCOVERY_FILE = 'discovery.json';
export const DISCOVERY_MD = 'discovery.md';

/** HTML artifacts a session builds for a feature, shown in the dashboard's
 *  Discovery sub-tabs. Both live in the feature's `demo/` subfolder. */
export type HtmlArtifactKind = 'walkthrough' | 'demo';
const HTML_ARTIFACT_FILE: Record<HtmlArtifactKind, string> = {
  walkthrough: 'walkthrough.html',
  demo: 'concept-demo.html',
};

/** Absolute path to a feature's HTML artifact of the given kind. */
export function htmlArtifactPath(featureFolderPath: string, kind: HtmlArtifactKind): string {
  return join(featureFolderPath, 'demo', HTML_ARTIFACT_FILE[kind]);
}

/** True when that artifact file exists on disk. */
export function hasHtmlArtifact(featureFolderPath: string, kind: HtmlArtifactKind): boolean {
  return existsSync(htmlArtifactPath(featureFolderPath, kind));
}

/** Discovery-meeting summaries live under `discovery/meetings/`, one dated
 *  markdown file per meeting (`YYYY-MM-DD.md`, extra same-day meetings get a
 *  slug suffix). Chat-written, human-readable, never overwritten — the record
 *  of what each discovery meeting said. */
export const MEETINGS_DIR = 'meetings';

export interface DiscoveryMeeting {
  file: string;
  /** The filename's YYYY-MM-DD prefix; '' when the name has none. */
  date: string;
  /** First `# ` heading's text; the filename (no extension) when absent. */
  title: string;
  /** Raw markdown after the title line; `#`-headings normalized to the house
   *  `**bold**` header lines so the dashboard's existing block renderer shows
   *  them as collapsible sections. */
  body: string;
}

/** List a feature's meeting summaries, newest first (filename descending —
 *  the date prefix makes that chronological). Missing folder → []. Never throws. */
export function listMeetings(featureFolderPath: string): DiscoveryMeeting[] {
  const dir = join(featureFolderPath, DISCOVERY_DIR, MEETINGS_DIR);
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter(e => e.isFile() && e.name.endsWith('.md'))
      .map(e => e.name)
      .sort()
      .reverse()
      .map(file => {
        const raw = readFileSync(join(dir, file), 'utf8');
        const lines = raw.split('\n');
        const headIdx = lines.findIndex(l => /^#\s+\S/.test(l.trim()));
        const title =
          headIdx >= 0 ? lines[headIdx].trim().replace(/^#\s+/, '') : file.replace(/\.md$/, '');
        const bodyLines = headIdx >= 0 ? lines.slice(headIdx + 1) : lines;
        const body = bodyLines
          .map(l => {
            const h = l.trim().match(/^#{1,3}\s+(.+)$/);
            return h ? `**${h[1]}**` : l;
          })
          .join('\n')
          .trim();
        const date = /^(\d{4}-\d{2}-\d{2})/.exec(file)?.[1] ?? '';
        return { file, date, title, body };
      });
  } catch {
    return []; // missing folder or unreadable entry — an empty list, never an error
  }
}

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
  hasWalkthrough: boolean;
  hasDemoHtml: boolean;
}

export function discoveryStatus(featureFolderPath: string): DiscoveryStatus {
  const doc = readDiscoveryDoc(featureFolderPath);
  const check = discoveryFinishedCheck(doc);
  return {
    hasDiscovery: doc !== null,
    finished: check.ok,
    missing: check.missing,
    demoStatus: doc?.demo.status ?? 'none',
    hasWalkthrough: hasHtmlArtifact(featureFolderPath, 'walkthrough'),
    hasDemoHtml: hasHtmlArtifact(featureFolderPath, 'demo'),
  };
}
