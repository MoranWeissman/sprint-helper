/**
 * Small `live` pill that appears on a task row when Claude Code has a session
 * open against it. The `rollup` variant is the dimmer chip-header treatment:
 * the chip itself isn't live — its child is — so it reads as quieter context.
 */
export function LiveMarker({
  rollup = false,
  rollupCount,
}: {
  rollup?: boolean;
  /** When `rollup`, how many child tasks are live. Shown as "live · 2 tasks". */
  rollupCount?: number;
}) {
  if (rollup) {
    const label = rollupCount && rollupCount !== 1
      ? `live · ${rollupCount} tasks`
      : 'live · 1 task';
    return (
      <span
        className="live-pill is-rollup"
        title="Claude Code is working on a task in this story"
      >
        {label}
      </span>
    );
  }
  return (
    <span className="live-pill" title="Claude Code is working on this">
      live
    </span>
  );
}
