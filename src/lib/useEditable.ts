import { useEffect, useState } from 'react';

/**
 * Optimistic edit state for a single field.
 *
 * Display the `actual` value normally; when the user changes it, the new value
 * is shown immediately while the server PATCH is in flight. After the parent
 * refresh propagates the new value into `actual`, the pending state clears.
 *
 * On error, the pending value is dropped and the error string is exposed.
 */
export function useEditable<T>(actual: T) {
  const [pending, setPending] = useState<T | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (pending !== null && actual === pending) setPending(null);
  }, [actual, pending]);

  const display = (pending !== null ? pending : actual) as T;

  async function save(next: T, op: (n: T) => Promise<void>) {
    if (next === actual && pending === null) return;
    setPending(next);
    setError(null);
    setSaving(true);
    try {
      await op(next);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPending(null);
    } finally {
      setSaving(false);
    }
  }

  return { display, saving, error, save };
}
