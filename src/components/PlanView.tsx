// src/components/PlanView.tsx
import { useEffect, useState } from 'react';
import {
  fetchPlanningGaps,
  type ApiPlanningGap,
  type ApiPlanningGapsResponse,
} from '../lib/api';

type ScanState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ok'; data: ApiPlanningGapsResponse }
  | { status: 'error'; error: string };

interface PlanViewProps {
  /** Called when the gap list contains items SH itself created (for the retro hook later). */
  onScanComplete?: (gapCount: number) => void;
}

/**
 * Plan mode body (R12 Thread 4).
 *
 * - Idle: a calm intro paragraph + "Scan for gaps" button.
 * - Loading: scan-in-progress shell.
 * - OK + empty: "no items need effort — everything has its planning fields."
 * - OK + gaps: list grouped by feature/story with per-item anchor proposal
 *   inline, plus a sticky "Copy prompt" button at the top.
 * - Error: brief message + retry.
 *
 * No inline accept/edit — the dashboard is the discovery surface, the chat
 * is the execution surface. See the spec for the rejected alternatives.
 */
export function PlanView({ onScanComplete }: PlanViewProps) {
  const [state, setState] = useState<ScanState>({ status: 'idle' });
  const [copied, setCopied] = useState(false);

  const runScan = async () => {
    setState({ status: 'loading' });
    try {
      const data = await fetchPlanningGaps();
      setState({ status: 'ok', data });
      onScanComplete?.(data.totalGaps);
    } catch (err) {
      setState({ status: 'error', error: err instanceof Error ? err.message : 'unknown error' });
    }
  };

  useEffect(() => {
    if (state.status !== 'ok') return;
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 2200);
    return () => clearTimeout(t);
  }, [copied, state.status]);

  const onCopy = async () => {
    if (state.status !== 'ok') return;
    try {
      await navigator.clipboard.writeText(state.data.prompt);
      setCopied(true);
    } catch {
      // Fall back to selection if clipboard is denied.
      const pre = document.getElementById('r12-plan-prompt-pre');
      if (pre) {
        const range = document.createRange();
        range.selectNodeContents(pre);
        const sel = window.getSelection();
        sel?.removeAllRanges();
        sel?.addRange(range);
      }
    }
  };

  return (
    <div className="r12-plan">
      <div className="r12-plan-intro">
        <h2 className="r12-plan-h">Plan</h2>
        <p>
          Find sprint items that don't have an estimate yet. The dashboard discovers them; the
          conversation in Claude Code fills them in.
        </p>
        <button className="r12-plan-scan" onClick={runScan} disabled={state.status === 'loading'}>
          {state.status === 'loading' ? 'Scanning…' : 'Scan for gaps'}
        </button>
      </div>

      {state.status === 'error' && (
        <div className="r12-plan-error" role="alert">
          Couldn't load the gap list — {state.error}. <button onClick={runScan}>Try again</button>
        </div>
      )}

      {state.status === 'ok' && state.data.totalGaps === 0 && (
        <div className="r12-plan-empty">
          Every Task and Story in the current sprint has its planning fields filled in. Nothing to do here.
        </div>
      )}

      {state.status === 'ok' && state.data.totalGaps > 0 && (
        <>
          <div className="r12-plan-actions">
            <span className="r12-plan-count">
              {state.data.totalGaps} {state.data.totalGaps === 1 ? 'item' : 'items'} need effort
            </span>
            <button className="r12-plan-copy" onClick={onCopy}>
              {copied ? 'Copied ✓' : 'Copy prompt for Claude Code'}
            </button>
          </div>

          <GapList gaps={state.data.gaps} />

          <details className="r12-plan-prompt-wrap">
            <summary>See the prompt the button will copy</summary>
            <pre id="r12-plan-prompt-pre" className="r12-plan-prompt">{state.data.prompt}</pre>
          </details>
        </>
      )}
    </div>
  );
}

/**
 * Group gaps by their parent (feature for stories, story for tasks). Tasks
 * with no parent go under "Unsorted". Stories without a feature go under
 * "Stories (no feature)".
 */
function GapList({ gaps }: { gaps: ApiPlanningGap[] }) {
  const groups = new Map<string, { label: string; gaps: ApiPlanningGap[] }>();
  for (const g of gaps) {
    const key = g.kind === 'story'
      ? (g.feature?.displayName ?? 'Stories (no feature)')
      : (g.parent?.displayName ?? 'Tasks (no parent story)');
    const bucket = groups.get(key) ?? { label: key, gaps: [] };
    bucket.gaps.push(g);
    groups.set(key, bucket);
  }
  return (
    <div className="r12-plan-groups">
      {[...groups.values()].map(group => (
        <section className="r12-plan-group" key={group.label}>
          <h3 className="r12-plan-group-h" dangerouslySetInnerHTML={{ __html: linkifyDisplayName(group.label) }} />
          <ul className="r12-plan-gaps">
            {group.gaps.map(g => (
              <li className="r12-plan-gap" key={`${g.kind}-${g.workItemId}`}>
                <div className="r12-plan-gap-head">
                  <span className={`r12-plan-kind r12-plan-kind-${g.kind}`}>{g.kind}</span>
                  <span className="r12-plan-gap-name" dangerouslySetInnerHTML={{ __html: linkifyDisplayName(g.displayName) }} />
                </div>
                <div className="r12-plan-gap-missing">
                  Missing: {g.missing.join(', ')}
                </div>
                <div className={`r12-plan-anchor ${g.anchor.isColdStart ? 'is-cold' : ''}`}>
                  {g.anchor.summary}
                </div>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

/**
 * Render `**title** (#id)` as bold + a small monospace id. `displayName` is
 * pre-formatted on the server, so we just need to translate markdown bold
 * to HTML. No XSS risk — the input is strictly the API's displayName field.
 */
function linkifyDisplayName(s: string): string {
  // Bold pass.
  let out = s.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  // Trailing `(#id)` becomes a discreet monospace chip.
  out = out.replace(/\(#(\d+)\)/g, '<span class="r12-id">#$1</span>');
  return out;
}
