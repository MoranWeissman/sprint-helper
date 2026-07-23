/**
 * The single doorway to Azure DevOps.
 *
 * Almost every call sprint-helper makes to Azure DevOps is a REST request —
 * historically routed through the `az rest` CLI, which handled authentication
 * via the user's `az login`. This module puts ONE interface in front of that
 * so the same calls can run two ways, chosen by config:
 *
 *   - 'cli'  → shell out to `az` (zero setup if `az` is installed + logged in).
 *   - 'api'  → call the Azure DevOps REST API directly with a stored token
 *              (works on machines without the Azure CLI).
 *
 * Callers build a full URI (org/project already in it) and a JSON body; the
 * client owns auth + transport. This is the seam the two-doorway support sits
 * behind — see docs/azure-access.md.
 *
 * Two operations need per-doorway handling because the CLI bundles work the raw
 * API splits:
 *   - `queryWorkItems` — `az boards query --wiql` returns items already
 *     populated; the raw API does wiql (ids only) then a workitemsbatch hydrate.
 * Everything else is a plain REST call through `rest()`.
 */
import { execFile } from 'node:child_process';
import { getSetting } from './timers';

// The Azure DevOps app id. `az rest` can't auto-derive the AAD resource for
// dev.azure.com URLs, so it's passed explicitly to get a proper bearer token.
export const ADO_RESOURCE = '499b84ac-1321-427f-aa17-267ca6975798';

export type AdoAccessMode = 'cli' | 'api';

export interface AdoRestRequest {
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  /** Absolute https URI, org/project already included. */
  uri: string;
  /** JSON-serializable body for POST/PATCH. Omit for GET. */
  body?: unknown;
  /**
   * Work-item create/update use application/json-patch+json; everything else
   * uses application/json. Defaults to 'json'. Ignored when there's no body.
   */
  contentKind?: 'json' | 'json-patch';
}

/** The shape every work-item read returns, regardless of doorway. */
export interface RawWorkItem {
  id: number;
  rev: number;
  url: string;
  fields: Record<string, unknown>;
}

export interface AdoQuery {
  /** Full WIQL statement. The SELECT columns matter for the CLI doorway. */
  wiql: string;
  /** Fields to hydrate (used by the API doorway's workitemsbatch step). */
  fields: string[];
  /** Org base URL, e.g. https://dev.azure.com/org — used by the API doorway. */
  organization: string;
  /** Project name — used by the API doorway. */
  project: string;
}

export interface AdoClient {
  /** Run a REST request and return the parsed JSON response (or undefined for empty). */
  rest<T = unknown>(req: AdoRestRequest): Promise<T>;
  /** Run a WIQL query and return the matching work items, hydrated, in WIQL order. */
  queryWorkItems(q: AdoQuery): Promise<RawWorkItem[]>;
}

const MAX_BUFFER = 16 * 1024 * 1024;

function contentTypeFor(kind: AdoRestRequest['contentKind']): string {
  return kind === 'json-patch' ? 'application/json-patch+json' : 'application/json';
}

/** Build a helpful Error out of an az failure, tagging the command for surfacing. */
function enrichAzError(stderr: string, label: string): Error {
  const text = String(stderr ?? '');
  const msg = text.includes('not logged in') || text.includes('az login')
    ? 'sprint-helper needs you to run `az login` first.'
    : `az command failed: ${text || 'unknown error'}`;
  const err = new Error(msg) as Error & { command?: string };
  err.command = label;
  return err;
}

function runAz(args: string[], input: string | null): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const child = execFile('az', args, { maxBuffer: MAX_BUFFER }, (err, out, stderr) => {
      if (err) reject(enrichAzError(String(stderr), `az ${args.join(' ')}`));
      else resolve(String(out));
    });
    if (input != null) {
      child.stdin?.write(input);
      child.stdin?.end();
    }
  });
}

/** Reorder hydrated items to match the id order WIQL returned (preserves ORDER BY). */
function orderByIds(ids: number[], items: RawWorkItem[]): RawWorkItem[] {
  const byId = new Map(items.map(w => [w.id, w]));
  return ids.map(id => byId.get(id)).filter((w): w is RawWorkItem => w != null);
}

/**
 * CLI doorway — shells out to `az`, reproducing the long-standing behaviour
 * exactly (resource id, json-patch headers, body piped via stdin; `az boards
 * query` for WIQL so items come back populated in a single call).
 */
export class CliAdoClient implements AdoClient {
  async rest<T = unknown>(req: AdoRestRequest): Promise<T> {
    const args = ['rest', '--method', req.method, '--uri', req.uri, '--resource', ADO_RESOURCE];
    let input: string | null = null;
    if (req.body !== undefined) {
      args.push('--headers', `Content-Type=${contentTypeFor(req.contentKind)}`);
      args.push('--body', '@-');
      input = JSON.stringify(req.body);
    }
    args.push('-o', 'json');

    const stdout = await runAz(args, input);
    const trimmed = stdout.trim();
    return (trimmed ? JSON.parse(trimmed) : undefined) as T;
  }

  async queryWorkItems(q: AdoQuery): Promise<RawWorkItem[]> {
    // `az boards query` resolves @Me, runs the WIQL, AND returns the selected
    // fields populated — one call, no separate hydrate. (org/project come from
    // the user's `az` defaults in CLI mode.)
    const stdout = await runAz(['boards', 'query', '--wiql', q.wiql, '-o', 'json'], null);
    const trimmed = stdout.trim();
    return trimmed ? (JSON.parse(trimmed) as RawWorkItem[]) : [];
  }
}

/**
 * API doorway — calls the Azure DevOps REST API directly with a stored token
 * (a Personal Access Token with work-item read/write). Works on machines that
 * don't have the Azure CLI. Auth is HTTP Basic with an empty username and the
 * PAT as the password — the standard ADO scheme.
 */
export class RestAdoClient implements AdoClient {
  constructor(private readonly token: string) {}

  private authHeader(): string {
    return 'Basic ' + Buffer.from(':' + this.token).toString('base64');
  }

  async rest<T = unknown>(req: AdoRestRequest): Promise<T> {
    const headers: Record<string, string> = {
      Authorization: this.authHeader(),
      Accept: 'application/json',
    };
    let body: string | undefined;
    if (req.body !== undefined) {
      headers['Content-Type'] = contentTypeFor(req.contentKind);
      body = JSON.stringify(req.body);
    }

    const res = await fetch(req.uri, { method: req.method, headers, body });
    const text = await res.text();

    if (!res.ok) {
      throw new Error(
        `Azure DevOps API ${res.status} ${res.statusText} for ${req.method} ${shortUri(req.uri)}: ` +
          `${text.slice(0, 300) || '(empty body)'}`,
      );
    }

    // ADO's classic trap: an invalid/expired PAT returns 200 with the HTML
    // sign-in page instead of a 401. Catch that so it reads as a token problem,
    // not a JSON parse crash deep in a caller.
    if (text.trim().startsWith('<')) {
      throw new Error(
        'Azure DevOps rejected the stored token (it returned a sign-in page, not data). ' +
          'The token is likely wrong, expired, or missing work-item scope. Update it, or ' +
          'switch the access mode back to "cli".',
      );
    }

    return (text.trim() ? (JSON.parse(text) as T) : (undefined as T));
  }

  async queryWorkItems(q: AdoQuery): Promise<RawWorkItem[]> {
    // Raw API splits what `az boards query` bundles: WIQL returns ids only, then
    // workitemsbatch hydrates the fields.
    const proj = encodeURIComponent(q.project);
    const wiqlUri = `${q.organization}/${proj}/_apis/wit/wiql?api-version=7.1`;
    const idResult = await this.rest<{ workItems?: Array<{ id: number }> }>({
      method: 'POST',
      uri: wiqlUri,
      body: { query: q.wiql },
      contentKind: 'json',
    });
    const ids = (idResult.workItems ?? []).map(w => w.id);
    if (ids.length === 0) return [];

    const batchUri = `${q.organization}/${proj}/_apis/wit/workitemsbatch?api-version=7.1`;
    const batch = await this.rest<{ value: RawWorkItem[] }>({
      method: 'POST',
      uri: batchUri,
      body: { ids, fields: q.fields },
      contentKind: 'json',
    });
    return orderByIds(ids, batch.value ?? []);
  }
}

/** Trim a REST URI down to its path for error messages (drops the org host noise). */
function shortUri(uri: string): string {
  const m = uri.match(/_apis\/.*$/);
  return m ? m[0] : uri;
}

/* ============================================================ */
/*  Mode selection + client cache                                */
/* ============================================================ */

/**
 * Which doorway to use. Reads the `ado_access_mode` setting, falling back to the
 * SH_ADO_ACCESS_MODE env var, defaulting to 'cli'. Anything other than 'api'
 * means 'cli' — the safe default that needs no token.
 */
export function getAdoAccessMode(): AdoAccessMode {
  const raw = (getSetting('ado_access_mode') ?? process.env.SH_ADO_ACCESS_MODE ?? 'cli')
    .trim()
    .toLowerCase();
  return raw === 'api' ? 'api' : 'cli';
}

/** The stored Azure DevOps token for API mode (setting first, then env). */
function getStoredToken(): string | undefined {
  const fromSetting = getSetting('ado_pat');
  if (fromSetting && fromSetting.trim()) return fromSetting.trim();
  const fromEnv = process.env.SH_ADO_PAT;
  return fromEnv && fromEnv.trim() ? fromEnv.trim() : undefined;
}

let client: AdoClient | null = null;

/**
 * The active Azure DevOps client. Built once from the configured mode and
 * cached. Call `resetAdoClient()` after changing the mode or token so the next
 * call rebuilds it.
 */
export function getAdoClient(): AdoClient {
  if (client) return client;
  if (getAdoAccessMode() === 'api') {
    const token = getStoredToken();
    if (!token) {
      throw new Error(
        'Azure DevOps access mode is "api" but no token is stored. Save a Personal ' +
          'Access Token (work-item read/write) as the "ado_pat" setting, or switch the ' +
          'mode back to "cli".',
      );
    }
    client = new RestAdoClient(token);
  } else {
    client = new CliAdoClient();
  }
  return client;
}

/** Drop the cached client so the next getAdoClient() re-reads mode + token. */
export function resetAdoClient(): void {
  client = null;
}

/** Test/setup seam: force a specific client. */
export function setAdoClient(next: AdoClient | null): void {
  client = next;
}

/**
 * Download a binary Azure DevOps attachment (e.g. an image embedded in a work
 * item description) to `destPath`. Honours both doorways:
 *   - cli → `az rest --output-file` (az handles auth; --output-file keeps the
 *           bytes intact, which `-o tsv/json` would corrupt).
 *   - api → fetch with the stored token and write the buffer.
 * Throws on failure so the caller can fall back to a caption.
 */
export async function downloadAttachment(uri: string, destPath: string): Promise<void> {
  if (getAdoAccessMode() === 'api') {
    const token = getStoredToken();
    if (!token) throw new Error('api mode but no token stored');
    const res = await fetch(uri, { headers: { Authorization: 'Basic ' + Buffer.from(':' + token).toString('base64') } });
    if (!res.ok) throw new Error(`attachment fetch ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    const { writeFile } = await import('node:fs/promises');
    await writeFile(destPath, buf);
    return;
  }
  await runAz(['rest', '--method', 'get', '--uri', uri, '--resource', ADO_RESOURCE, '--output-file', destPath], null);
}
