import { useTick } from '../lib/time';
import { Mono } from './Mono';

export interface LiveNowSession {
  workItemId: string;
  taskTitle: string;
  parentTitle?: string;
  /** ISO timestamp for when the session opened. Used to compute elapsed live. */
  startedAt: string;
}

/**
 * Sidebar tile listing the Claude Code sessions currently open. Renders only
 * when at least one session is open — the parent should skip rendering when
 * the list is empty (we still guard here so it's safe to drop in unconditionally).
 */
export function LiveNowTile({
  sessions,
  onJump,
}: {
  sessions: LiveNowSession[];
  /** Click handler — jumps to the story + expands the task. */
  onJump?: (workItemId: string) => void;
}) {
  // Re-render every second so elapsed times tick.
  useTick();

  if (sessions.length === 0) return null;

  const title = sessions.length === 1
    ? 'LIVE NOW'
    : `LIVE NOW · ${sessions.length} SESSIONS`;

  return (
    <div className="live-now-tile">
      <div className="live-now-head">
        <span className="live-now-dot" aria-hidden="true" />
        <span className="live-now-title">{title}</span>
      </div>
      <div className="live-now-list">
        {sessions.map(s => (
          <button
            key={s.workItemId}
            type="button"
            className="live-now-item"
            onClick={onJump ? () => onJump(s.workItemId) : undefined}
            title={`Jump to ${s.taskTitle}`}
          >
            <span className="live-now-item-title">{s.taskTitle}</span>
            <Mono className="live-now-item-elapsed">{elapsedShort(s.startedAt)}</Mono>
            {s.parentTitle && (
              <span className="live-now-item-sub">{s.parentTitle}</span>
            )}
          </button>
        ))}
      </div>
    </div>
  );
}

function elapsedShort(startedAt: string): string {
  const ms = Date.now() - new Date(startedAt).getTime();
  const min = Math.max(0, Math.floor(ms / 60000));
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}
