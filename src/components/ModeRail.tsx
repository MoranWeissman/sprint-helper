import { useEffect, useState } from 'react';
import type { ModeId } from '../lib/api';
import { ModeGlyph } from './ModeGlyphs';

const MODES: Array<{ id: ModeId; label: string }> = [
  { id: 'day',     label: 'Day' },
  { id: 'preplan', label: 'Pre-plan' },
  { id: 'plan',    label: 'Plan' },
  { id: 'demo',    label: 'Demo' },
  { id: 'retro',   label: 'Retro' },
];

interface ModeRailProps {
  active: ModeId;
  suggested: ModeId | null;
  onPick: (next: ModeId) => void;
  onOpenSchedule: () => void;
}

export function ModeRail({ active, suggested, onPick, onOpenSchedule }: ModeRailProps) {
  // One-shot shimmer on first appearance of a suggested mode.
  // Re-arms whenever the suggested mode changes (so the user gets a fresh nudge).
  const [shimmer, setShimmer] = useState(true);
  useEffect(() => {
    if (!suggested) return;
    setShimmer(true);
    const t = setTimeout(() => setShimmer(false), 700);
    return () => clearTimeout(t);
  }, [suggested]);

  return (
    <nav className="mode-rail" aria-label="workspace mode">
      <div className="mode-rail-cap">MODE</div>
      {MODES.map(m => {
        const isActive = m.id === active;
        const isSuggested = !isActive && m.id === suggested;
        const cls = [
          'mode-rail-tile',
          isActive ? 'is-active' : '',
          isSuggested ? 'is-suggested' : '',
          isSuggested && shimmer ? 'shimmer-on' : '',
        ].filter(Boolean).join(' ');
        return (
          <button
            key={m.id}
            className={cls}
            onClick={() => onPick(m.id)}
            aria-pressed={isActive}
            title={isSuggested ? `Switch to ${m.label}?` : m.label}
          >
            <ModeGlyph mode={m.id} />
            <span className="lbl">{m.label}</span>
            {isSuggested && <span className="sug-dot" aria-label="switch to this mode" />}
          </button>
        );
      })}
      <div className="mode-rail-sep" />
      <button
        className="mode-rail-gear"
        onClick={onOpenSchedule}
        title="Edit schedule"
        aria-label="Edit schedule"
      >
        <ModeGlyph mode="gear" />
        <span className="lbl">Schedule</span>
      </button>
    </nav>
  );
}
