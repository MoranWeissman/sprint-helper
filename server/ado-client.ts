/**
 * The single doorway to Azure DevOps.
 *
 * Almost every call sprint-helper makes to Azure DevOps is a REST request —
 * historically routed through the `az rest` CLI, which handled authentication
 * via the user's `az login`. This module puts ONE interface in front of that
 * so the same calls can run two ways, chosen by config:
 *
 *   - 'cli'  → shell out to `az rest` (zero setup if `az` is installed + logged in).
 *   - 'api'  → call the Azure DevOps REST API directly with a stored token
 *              (works on machines without the Azure CLI). [added in a later step]
 *
 * Callers build a full URI (org/project already in it) and a JSON body; the
 * client owns auth + transport. This is the seam the two-doorway support sits
 * behind — see docs/azure-access.md.
 */
import { execFile } from 'node:child_process';

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

export interface AdoClient {
  /** Run a REST request and return the parsed JSON response (or undefined for empty). */
  rest<T = unknown>(req: AdoRestRequest): Promise<T>;
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

/**
 * CLI doorway — shells out to `az rest`, reproducing the long-standing
 * behaviour exactly (resource id, json-patch headers, body piped via stdin).
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

    const stdout = await new Promise<string>((resolve, reject) => {
      const child = execFile('az', args, { maxBuffer: MAX_BUFFER }, (err, out, stderr) => {
        if (err) reject(enrichAzError(String(stderr), `az ${args.join(' ')}`));
        else resolve(String(out));
      });
      if (input != null) {
        child.stdin?.write(input);
        child.stdin?.end();
      }
    });

    const trimmed = stdout.trim();
    return (trimmed ? JSON.parse(trimmed) : undefined) as T;
  }
}

let client: AdoClient | null = null;

/**
 * The active Azure DevOps client. Defaults to the CLI doorway. A later step
 * reads the configured access mode and returns the API doorway when selected.
 */
export function getAdoClient(): AdoClient {
  if (!client) client = new CliAdoClient();
  return client;
}

/** Test/setup seam: force a specific client (e.g. when the mode changes). */
export function setAdoClient(next: AdoClient | null): void {
  client = next;
}
