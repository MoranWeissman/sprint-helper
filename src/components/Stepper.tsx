import { useEffect, useRef, useState } from 'react';

interface StepperProps {
  value: number;
  /** Commits the new value. Async — parent should PATCH and not call this on transient drafts. */
  onChange: (next: number) => Promise<void> | void;
  step?: number;
  min?: number;
  max?: number;
  suffix?: string;
  disabled?: boolean;
}

/**
 * Compact `− value +` editor. The value is click-to-type with commit-on-blur/Enter,
 * Escape cancels, and values snap to `step`. Designed to feel like a number, not a form field.
 */
export function Stepper({
  value,
  onChange,
  step = 0.5,
  min = 0,
  max = 999,
  suffix = 'h',
  disabled,
}: StepperProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(String(value));
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!editing) setDraft(formatValue(value));
  }, [value, editing]);

  useEffect(() => {
    if (editing) inputRef.current?.select();
  }, [editing]);

  const commit = () => {
    setEditing(false);
    const n = parseFloat(draft);
    if (!Number.isFinite(n) || n < min || n > max) {
      setDraft(formatValue(value));
      return;
    }
    const snapped = Math.round(n / step) * step;
    const rounded = Math.round(snapped * 100) / 100;
    if (rounded !== value) onChange(rounded);
  };

  const bump = (dir: 1 | -1) => {
    if (disabled) return;
    const next = Math.round((value + dir * step) * 100) / 100;
    if (next < min || next > max) return;
    onChange(next);
  };

  return (
    <div className="stepper">
      <button
        className="stepper-btn"
        onClick={() => bump(-1)}
        disabled={disabled || value <= min}
        aria-label="decrease"
      >
        −
      </button>
      {editing ? (
        <input
          ref={inputRef}
          className="stepper-val"
          value={draft}
          onChange={e => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={e => {
            if (e.key === 'Enter') commit();
            if (e.key === 'Escape') {
              setEditing(false);
              setDraft(formatValue(value));
            }
          }}
          inputMode="decimal"
          autoFocus
        />
      ) : (
        <button
          className="stepper-val"
          onClick={() => !disabled && setEditing(true)}
          disabled={disabled}
          title="click to edit"
        >
          {formatValue(value)}{suffix}
        </button>
      )}
      <button
        className="stepper-btn"
        onClick={() => bump(+1)}
        disabled={disabled || value >= max}
        aria-label="increase"
      >
        +
      </button>
    </div>
  );
}

function formatValue(n: number): string {
  // Trim trailing zeros: 4 → "4", 2.5 → "2.5", 1.25 → "1.25"
  if (Number.isInteger(n)) return String(n);
  return String(Math.round(n * 100) / 100);
}
