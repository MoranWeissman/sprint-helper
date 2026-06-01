/**
 * Azure DevOps client — shells out to `az` CLI.
 *
 * Auth: relies on the user's existing `az login`. No PAT required.
 * All methods throw on failure with the underlying `az` stderr surfaced.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { loadAdoConfig } from './config';

const exec = promisify(execFile);

export interface Iteration {
  id: string;
  name: string;
  path: string;
  startDate: string; // ISO
  finishDate: string; // ISO
}

export interface WorkItem {
  id: number;
  rev: number;
  type: string;
  title: string;
  state: string;
  description?: string;       // HTML (raw); UI strips to plain-text preview
  areaPath: string;
  parentId?: number;
  parentTitle?: string;
  parentType?: string;
  parentState?: string;
  parentUrl?: string;
  parentDescription?: string;
  parentAreaPath?: string;
  parentOriginalEstimate?: number;
  parentRemainingWork?: number;
  parentStoryPoints?: number;
  parentEffort?: number;
  /** The story's parent — i.e. the Feature / Epic above it. */
  grandparentId?: number;
  grandparentTitle?: string;
  grandparentType?: string;
  assignedTo?: string;
  iterationPath: string;
  originalEstimate?: number;
  remainingWork?: number;
  completedWork?: number;
  /** Story-level: 1 point = 1 day in Moran's team. */
  storyPoints?: number;
  /** Story-level: total hours estimate. */
  effort?: number;
  changedDate: string;
  url: string;
}

const WORK_ITEM_FIELDS = [
  'System.Id',
  'System.Rev',
  'System.WorkItemType',
  'System.Title',
  'System.State',
  'System.Description',
  'System.AreaPath',
  'System.Parent',
  'System.AssignedTo',
  'System.IterationPath',
  'System.ChangedDate',
  'Microsoft.VSTS.Scheduling.OriginalEstimate',
  'Microsoft.VSTS.Scheduling.RemainingWork',
  'Microsoft.VSTS.Scheduling.CompletedWork',
  'Microsoft.VSTS.Scheduling.StoryPoints',
  'Microsoft.VSTS.Scheduling.Effort',
];

/**
 * Iterations rarely change within a session (sprint dates are fixed once a
 * sprint is created), but the `az` calls to fetch them cost ~0.9s. Cache both
 * the current-iteration lookup and the full list in memory with a short TTL so
 * a dashboard reload / sprint switch doesn't re-pay that on every request.
 * Work items themselves are never cached — only the iteration metadata.
 */
const ITERATION_TTL_MS = 5 * 60 * 1000;
let currentCache: { value: Iteration | null; at: number } | null = null;
let allCache: { value: Iteration[]; at: number } | null = null;

function fresh(at: number): boolean {
  return Date.now() - at < ITERATION_TTL_MS;
}

/** Clear the iteration caches — call after creating/changing iterations. */
export function invalidateIterationCache(): void {
  currentCache = null;
  allCache = null;
}

export async function getCurrentIteration(): Promise<Iteration | null> {
  if (currentCache && fresh(currentCache.at)) return currentCache.value;
  const cfg = await loadAdoConfig();
  const { stdout } = await azJson(['boards', 'iteration', 'team', 'list', '--team', cfg.team, '--timeframe', 'current']);
  const arr = JSON.parse(stdout) as Array<{
    id: string;
    name: string;
    path: string;
    attributes: { startDate: string; finishDate: string };
  }>;
  const value: Iteration | null = arr.length === 0
    ? null
    : {
        id: arr[0].id,
        name: arr[0].name,
        path: arr[0].path,
        startDate: arr[0].attributes.startDate,
        finishDate: arr[0].attributes.finishDate,
      };
  currentCache = { value, at: Date.now() };
  return value;
}

/** All iterations the team has — for sprint picker (browse previous/upcoming). */
export async function listAllIterations(): Promise<Iteration[]> {
  if (allCache && fresh(allCache.at)) return allCache.value;
  const cfg = await loadAdoConfig();
  const { stdout } = await azJson(['boards', 'iteration', 'team', 'list', '--team', cfg.team]);
  const arr = JSON.parse(stdout) as Array<{
    id: string;
    name: string;
    path: string;
    attributes: { startDate?: string; finishDate?: string };
  }>;
  const value = arr
    .filter(it => it.attributes.startDate && it.attributes.finishDate)
    .map(it => ({
      id: it.id,
      name: it.name,
      path: it.path,
      startDate: it.attributes.startDate!,
      finishDate: it.attributes.finishDate!,
    }))
    .sort((a, b) => a.startDate.localeCompare(b.startDate));
  allCache = { value, at: Date.now() };
  return value;
}

/** Find a specific iteration by name. */
export async function getIterationByName(name: string): Promise<Iteration | null> {
  const all = await listAllIterations();
  return all.find(it => it.name === name) ?? null;
}

/* ============================================================ */
/*  Single work item — full read-only details                    */
/* ============================================================ */

export interface WorkItemDetail {
  id: number;
  rev: number;
  type: string;
  title: string;
  state: string;
  assignedTo?: string;
  iterationPath: string;
  areaPath: string;
  description?: string;       // HTML
  acceptanceCriteria?: string; // HTML
  reproSteps?: string;        // HTML, for bugs
  tags?: string;
  priority?: number;
  createdDate: string;
  createdBy?: string;
  changedDate: string;
  changedBy?: string;
  originalEstimate?: number;
  remainingWork?: number;
  completedWork?: number;
  parent?: { id: number; title: string; type: string; state: string; url: string };
  children: Array<{ id: number; title: string; type: string; state: string; url: string }>;
  related: Array<{ id: number; title: string; type: string; state: string; url: string; rel: string }>;
  url: string;
  webUrl: string;
}

export interface WorkItemComment {
  id: number;
  text: string; // HTML
  createdBy?: string;
  createdDate: string;
}

export async function getWorkItem(id: number): Promise<WorkItemDetail> {
  const cfg = await loadAdoConfig();
  const ADO_RESOURCE = '499b84ac-1321-427f-aa17-267ca6975798';
  const uri = `${cfg.organization}/${encodeURIComponent(cfg.project)}/_apis/wit/workitems/${id}?$expand=all&api-version=7.1`;
  const { stdout } = await azJson([
    'rest', '--method', 'GET',
    '--uri', uri,
    '--resource', ADO_RESOURCE,
  ]);
  const w = JSON.parse(stdout) as {
    id: number;
    rev: number;
    url: string;
    fields: Record<string, unknown>;
    relations?: Array<{ rel: string; url: string; attributes?: { name?: string } }>;
    _links?: { html?: { href?: string } };
  };
  const f = w.fields;

  const childIds: number[] = [];
  const parentIds: number[] = [];
  const relatedIds: Array<{ id: number; rel: string }> = [];

  if (w.relations) {
    for (const rel of w.relations) {
      const m = rel.url.match(/\/workItems\/(\d+)$/i);
      if (!m) continue;
      const wid = Number(m[1]);
      if (rel.rel === 'System.LinkTypes.Hierarchy-Forward') childIds.push(wid);
      else if (rel.rel === 'System.LinkTypes.Hierarchy-Reverse') parentIds.push(wid);
      else if (rel.rel.startsWith('System.LinkTypes')) relatedIds.push({ id: wid, rel: rel.rel });
    }
  }

  // Resolve titles for parent, children, and related links — best-effort batch.
  const allRefs = [...parentIds, ...childIds, ...relatedIds.map(r => r.id)];
  const refDetails = allRefs.length > 0 ? await getWorkItemBatch(allRefs) : [];
  const refMap = new Map(refDetails.map(r => [r.id, r]));

  const parent =
    parentIds[0] != null && refMap.has(parentIds[0])
      ? mapRef(refMap.get(parentIds[0])!)
      : undefined;

  const children = childIds
    .filter(cid => refMap.has(cid))
    .map(cid => mapRef(refMap.get(cid)!));

  const related = relatedIds
    .filter(r => refMap.has(r.id))
    .map(r => ({ ...mapRef(refMap.get(r.id)!), rel: r.rel }));

  return {
    id: w.id,
    rev: w.rev,
    type: String(f['System.WorkItemType'] ?? ''),
    title: String(f['System.Title'] ?? ''),
    state: String(f['System.State'] ?? ''),
    assignedTo: extractAssignedTo(f['System.AssignedTo']),
    iterationPath: String(f['System.IterationPath'] ?? ''),
    areaPath: String(f['System.AreaPath'] ?? ''),
    description: strOrUndef(f['System.Description']),
    acceptanceCriteria: strOrUndef(f['Microsoft.VSTS.Common.AcceptanceCriteria']),
    reproSteps: strOrUndef(f['Microsoft.VSTS.TCM.ReproSteps']),
    tags: strOrUndef(f['System.Tags']),
    priority: numOrUndef(f['Microsoft.VSTS.Common.Priority']),
    createdDate: String(f['System.CreatedDate'] ?? ''),
    createdBy: extractAssignedTo(f['System.CreatedBy']),
    changedDate: String(f['System.ChangedDate'] ?? ''),
    changedBy: extractAssignedTo(f['System.ChangedBy']),
    originalEstimate: numOrUndef(f['Microsoft.VSTS.Scheduling.OriginalEstimate']),
    remainingWork: numOrUndef(f['Microsoft.VSTS.Scheduling.RemainingWork']),
    completedWork: numOrUndef(f['Microsoft.VSTS.Scheduling.CompletedWork']),
    parent,
    children,
    related,
    url: w.url,
    webUrl: w._links?.html?.href ?? `${cfg.organization}/${encodeURIComponent(cfg.project)}/_workitems/edit/${w.id}`,
  };
}

export async function getWorkItemComments(id: number): Promise<WorkItemComment[]> {
  const cfg = await loadAdoConfig();
  const ADO_RESOURCE = '499b84ac-1321-427f-aa17-267ca6975798';
  const uri = `${cfg.organization}/${encodeURIComponent(cfg.project)}/_apis/wit/workItems/${id}/comments?api-version=7.1-preview.4&$top=200`;
  const { stdout } = await azJson([
    'rest', '--method', 'GET',
    '--uri', uri,
    '--resource', ADO_RESOURCE,
  ]);
  const parsed = JSON.parse(stdout) as {
    comments?: Array<{
      id: number;
      text: string;
      createdBy?: { displayName?: string };
      createdDate: string;
    }>;
  };
  return (parsed.comments ?? []).map(c => ({
    id: c.id,
    text: c.text,
    createdBy: c.createdBy?.displayName,
    createdDate: c.createdDate,
  }));
}

function mapRef(w: WorkItem) {
  return {
    id: w.id,
    title: w.title,
    type: w.type,
    state: w.state,
    url: humanWorkItemUrl(w.url, w.id),
  };
}

function strOrUndef(v: unknown): string | undefined {
  const s = typeof v === 'string' ? v : undefined;
  return s && s.trim() ? s : undefined;
}

function extractAssignedTo(v: unknown): string | undefined {
  if (typeof v === 'string') return v;
  if (typeof v === 'object' && v !== null) {
    const obj = v as { displayName?: string; uniqueName?: string };
    return obj.displayName ?? obj.uniqueName;
  }
  return undefined;
}

export async function getMyWorkItems(iterationPath: string): Promise<WorkItem[]> {
  // 1) WIQL: fetch work items assigned to @Me in this iteration. Selecting the
  //    fields means `az boards query` returns them already populated, so we
  //    skip a separate workitemsbatch round-trip for the main items (one less
  //    ~0.7s `az` call on every dashboard load).
  const fieldList = WORK_ITEM_FIELDS.map(f => `[${f}]`).join(', ');
  const wiql = [
    `SELECT ${fieldList} FROM WorkItems`,
    `WHERE [System.AssignedTo] = @Me`,
    `  AND [System.IterationPath] = '${escapeWiql(iterationPath)}'`,
    'ORDER BY [System.ChangedDate] DESC',
  ].join(' ');

  const { stdout } = await azJson(['boards', 'query', '--wiql', wiql]);
  const raw = JSON.parse(stdout) as Array<{
    id: number;
    rev: number;
    url: string;
    fields: Record<string, unknown>;
  }>;
  if (raw.length === 0) return [];
  const items = raw.map(w => mapWorkItem(w));

  // 2) Resolve parent details in one extra batch (for parent story chip in the UI)
  const parentIds = [...new Set(items.map(i => i.parentId).filter((x): x is number => !!x))];
  const parents = parentIds.length > 0 ? await getWorkItemBatch(parentIds) : [];
  const parentMap = new Map(parents.map(p => [p.id, p]));

  // 3) Second hop: resolve the *grandparent* of each task (i.e. the Feature / Epic
  //    above the user story) so the daily view can group stories by feature.
  const grandparentIds = [...new Set(parents.map(p => p.parentId).filter((x): x is number => !!x))];
  const grandparents = grandparentIds.length > 0 ? await getWorkItemBatch(grandparentIds) : [];
  const grandparentMap = new Map(grandparents.map(g => [g.id, g]));

  for (const i of items) {
    if (i.parentId) {
      const p = parentMap.get(i.parentId);
      if (p) {
        i.parentTitle = p.title;
        i.parentType = p.type;
        i.parentState = p.state;
        i.parentUrl = humanWorkItemUrl(p.url, p.id);
        i.parentDescription = p.description;
        i.parentAreaPath = p.areaPath;
        i.parentOriginalEstimate = p.originalEstimate;
        i.parentRemainingWork = p.remainingWork;
        i.parentStoryPoints = p.storyPoints;
        i.parentEffort = p.effort;
        if (p.parentId) {
          const g = grandparentMap.get(p.parentId);
          if (g) {
            i.grandparentId = g.id;
            i.grandparentTitle = g.title;
            i.grandparentType = g.type;
          }
        }
      }
    }
  }
  return items;
}

function humanWorkItemUrl(restUrl: string, id: number): string {
  const m = restUrl.match(/^(https:\/\/dev\.azure\.com\/[^/]+)\/_apis\/wit\/workItems\/\d+/);
  if (!m) return restUrl;
  return `${m[1]}/_workitems/edit/${id}`;
}

async function getWorkItemBatch(ids: number[]): Promise<WorkItem[]> {
  const cfg = await loadAdoConfig();
  const body = JSON.stringify({ ids, fields: WORK_ITEM_FIELDS });
  // az rest can't auto-derive the AAD resource for dev.azure.com URLs — pass the
  // Azure DevOps app ID explicitly so it acquires a proper bearer token.
  const ADO_RESOURCE = '499b84ac-1321-427f-aa17-267ca6975798';
  const uri = `${cfg.organization}/${encodeURIComponent(cfg.project)}/_apis/wit/workitemsbatch?api-version=7.1`;
  const { stdout } = await execStdin(
    'az',
    [
      'rest', '--method', 'POST',
      '--uri', uri,
      '--resource', ADO_RESOURCE,
      '--headers', 'Content-Type=application/json',
      '--body', '@-',
    ],
    body,
  );
  const parsed = JSON.parse(stdout) as {
    value: Array<{
      id: number;
      rev: number;
      url: string;
      fields: Record<string, unknown>;
    }>;
  };
  return parsed.value.map(w => mapWorkItem(w));
}

function mapWorkItem(w: { id: number; rev: number; url: string; fields: Record<string, unknown> }): WorkItem {
  const f = w.fields;
  const assignedToRaw = f['System.AssignedTo'];
  const assignedTo =
    typeof assignedToRaw === 'object' && assignedToRaw !== null && 'uniqueName' in assignedToRaw
      ? String((assignedToRaw as { uniqueName: string }).uniqueName)
      : typeof assignedToRaw === 'string'
        ? assignedToRaw
        : undefined;

  return {
    id: w.id,
    rev: w.rev,
    type: String(f['System.WorkItemType'] ?? ''),
    title: String(f['System.Title'] ?? ''),
    state: String(f['System.State'] ?? ''),
    description: typeof f['System.Description'] === 'string' ? (f['System.Description'] as string) : undefined,
    areaPath: String(f['System.AreaPath'] ?? ''),
    parentId: typeof f['System.Parent'] === 'number' ? (f['System.Parent'] as number) : undefined,
    assignedTo,
    iterationPath: String(f['System.IterationPath'] ?? ''),
    originalEstimate: numOrUndef(f['Microsoft.VSTS.Scheduling.OriginalEstimate']),
    remainingWork: numOrUndef(f['Microsoft.VSTS.Scheduling.RemainingWork']),
    completedWork: numOrUndef(f['Microsoft.VSTS.Scheduling.CompletedWork']),
    storyPoints: numOrUndef(f['Microsoft.VSTS.Scheduling.StoryPoints']),
    effort: numOrUndef(f['Microsoft.VSTS.Scheduling.Effort']),
    changedDate: String(f['System.ChangedDate'] ?? ''),
    url: w.url,
  };
}

function numOrUndef(v: unknown): number | undefined {
  return typeof v === 'number' ? v : undefined;
}

function escapeWiql(s: string): string {
  return s.replace(/'/g, "''");
}

async function azJson(args: string[]): Promise<{ stdout: string }> {
  try {
    return await exec('az', [...args, '-o', 'json'], { maxBuffer: 16 * 1024 * 1024 });
  } catch (e) {
    throw enrichAzError(e, args);
  }
}

function execStdin(cmd: string, args: string[], input: string): Promise<{ stdout: string }> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      cmd,
      args,
      { maxBuffer: 16 * 1024 * 1024 },
      (err: Error | null, stdout: string | Buffer, stderr: string | Buffer) => {
        if (err) {
          reject(enrichAzError({ stderr: String(stderr ?? '') }, args));
        } else {
          resolve({ stdout: String(stdout) });
        }
      },
    );
    child.stdin?.write(input);
    child.stdin?.end();
  });
}

function enrichAzError(e: unknown, args: string[]): Error {
  const stderr = (e && typeof e === 'object' && 'stderr' in e) ? String((e as { stderr: unknown }).stderr) : '';
  const msg = stderr.includes('not logged in')
    ? `sprint-helper needs you to run \`az login\` first.`
    : `az command failed: ${stderr || (e instanceof Error ? e.message : 'unknown error')}`;
  const err = new Error(msg);
  (err as unknown as { command: string }).command = `az ${args.join(' ')}`;
  return err;
}
