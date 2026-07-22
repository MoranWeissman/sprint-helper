/**
 * Per-feature discovery: the source-of-content file shape, its markdown render,
 * the "finished" check, and the day-count. Pure functions over data passed in;
 * every reader tolerates missing/garbage input and returns a safe empty state,
 * never throws — same discipline as server/workspace.ts. No fs or ADO access in
 * the pure core; the fs wrapper lives in Task 2.
 */

export type DiscoveryTag = 'diff' | 'risk' | 'fact' | 'option';
const VALID_TAGS: ReadonlySet<string> = new Set(['diff', 'risk', 'fact', 'option']);

export interface DiscoveryItem { text: string; tags: DiscoveryTag[] }
export interface DiscoveryGroup { name: string; items: DiscoveryItem[] }
export type DemoStatus = 'none' | 'scheduled' | 'built';
const VALID_DEMO: ReadonlySet<string> = new Set(['none', 'scheduled', 'built']);

export interface DiscoveryDoc {
  problem: string;
  flow: string[];
  groups: DiscoveryGroup[];
  lanes: { ours: string; techLead: string };
  demo: { status: DemoStatus; shape: string; date: string };
  openQuestions: string[];
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const strArray = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];

function parseItem(v: unknown): DiscoveryItem | null {
  if (v == null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  if (typeof o.text !== 'string') return null;
  const tags = Array.isArray(o.tags)
    ? (o.tags.filter((t): t is DiscoveryTag => typeof t === 'string' && VALID_TAGS.has(t)))
    : [];
  return { text: o.text, tags };
}

function parseGroup(v: unknown): DiscoveryGroup | null {
  if (v == null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  if (typeof o.name !== 'string') return null;
  const items = Array.isArray(o.items)
    ? o.items.map(parseItem).filter((i): i is DiscoveryItem => i !== null)
    : [];
  return { name: o.name, items };
}

export function emptyDiscoveryDoc(): DiscoveryDoc {
  return {
    problem: '', flow: [], groups: [],
    lanes: { ours: '', techLead: '' },
    demo: { status: 'none', shape: '', date: '' },
    openQuestions: [],
  };
}

/** Parse the source file; missing/garbage/wrong-shape → null. Never throws. */
export function parseDiscoveryDoc(raw: string | null | undefined): DiscoveryDoc | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const o = parsed as Record<string, unknown>;
  const lanes = (o.lanes && typeof o.lanes === 'object' && !Array.isArray(o.lanes))
    ? o.lanes as Record<string, unknown> : {};
  const demo = (o.demo && typeof o.demo === 'object' && !Array.isArray(o.demo))
    ? o.demo as Record<string, unknown> : {};
  const status = typeof demo.status === 'string' && VALID_DEMO.has(demo.status)
    ? demo.status as DemoStatus : 'none';
  return {
    problem: str(o.problem),
    flow: strArray(o.flow),
    groups: Array.isArray(o.groups)
      ? o.groups.map(parseGroup).filter((g): g is DiscoveryGroup => g !== null) : [],
    lanes: { ours: str(lanes.ours), techLead: str(lanes.techLead) },
    demo: { status, shape: str(demo.shape), date: str(demo.date) },
    openQuestions: strArray(o.openQuestions),
  };
}
