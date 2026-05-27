import { useState } from 'react';
import type { StateBucket } from '../lib/api';

interface StatePickerProps {
  /** Current bucket — derived from the work item's ADO state on the parent. */
  value: StateBucket;
  /** Called with the new bucket the user picked. Parent should PATCH to ADO. */
  onChange: (next: StateBucket) => Promise<void> | void;
  /** Disable interaction (e.g. while a previous PATCH is in flight). */
  disabled?: boolean;
}

const PILLS: StateBucket[] = ['waiting', 'going', 'done'];

export function StatePicker({ value, onChange, disabled }: StatePickerProps) {
  const [target, setTarget] = useState<StateBucket | null>(null);

  const handle = async (next: StateBucket) => {
    if (disabled || next === value) return;
    setTarget(next);
    try {
      await onChange(next);
    } finally {
      // CSS animation runs once on .is-target; clearing the flag after a tick
      // is enough — the parent's data refresh will move .is-active anyway.
      setTimeout(() => setTarget(null), 600);
    }
  };

  return (
    <div className="statepick" role="radiogroup" aria-label="state">
      {PILLS.map(p => (
        <button
          key={p}
          role="radio"
          aria-checked={value === p}
          className={`statepick-seg ${value === p ? 'is-active' : ''} ${target === p ? 'is-target' : ''}`}
          onClick={() => handle(p)}
          disabled={disabled}
        >
          {p}
        </button>
      ))}
    </div>
  );
}
