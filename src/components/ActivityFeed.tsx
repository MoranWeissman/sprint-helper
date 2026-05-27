import { useState } from 'react';
import type { ApiSessionEvent, SessionEventType } from '../lib/api';

const TYPE_LABELS: Record<SessionEventType, string> = {
  focus: 'Focus',
  progress: 'Progress',
  blocker: 'Blocker',
  decision: 'Decision',
  note: 'Note',
};

/**
 * "Recent activity" feed shown inside the existing expand panels. Two scopes:
 *  - `task`: events for a single task.
 *  - `chip`: rolled-up events across a story's child tasks. We show a small
 *    "rolled up across N tasks" caption next to the section title.
 */
export function ActivityFeed({
  events,
  scope,
  rolledUpFromTasks,
  max = 5,
}: {
  events: ApiSessionEvent[];
  scope: 'task' | 'chip';
  /** Only meaningful when scope === 'chip'. Used for the caption. */
  rolledUpFromTasks?: number;
  max?: number;
}) {
  const [expanded, setExpanded] = useState(false);
  const total = events.length;
  const visible = expanded ? events.slice(0, 20) : events.slice(0, max);

  return (
    <div className="activity-feed">
      <div className="activity-feed-head">
        <span className="activity-feed-title">Recent activity</span>
        {scope === 'chip' && rolledUpFromTasks != null && rolledUpFromTasks > 0 && (
          <span className="activity-feed-meta">
            rolled up across {rolledUpFromTasks} task{rolledUpFromTasks === 1 ? '' : 's'}
          </span>
        )}
      </div>
      {total === 0 ? (
        <p className="activity-empty">
          Nothing yet. Claude Code will log things here as you work.
        </p>
      ) : (
        <>
          <div className="activity-list">
            {visible.map(e => <EventRow key={e.id} event={e} />)}
          </div>
          {total > max && (
            <button
              type="button"
              className="activity-more"
              onClick={() => setExpanded(v => !v)}
            >
              {expanded ? 'Show recent only' : `${max} of ${total} · show all`}
            </button>
          )}
        </>
      )}
    </div>
  );
}

function EventRow({ event }: { event: ApiSessionEvent }) {
  return (
    <div className="activity-event">
      <span className="activity-event-time">{formatEventTime(event.createdAt)}</span>
      <span className={`activity-event-type t-${event.type}`}>
        {TYPE_LABELS[event.type]}
      </span>
      <span className="activity-event-body" title={event.text}>
        {event.text}
      </span>
    </div>
  );
}

/**
 * Today → `HH:MM`. Earlier this week → `Tue HH:MM`. Older → `Tue 03 14:32`.
 * Calendar-day comparison, not 24h windows — "today" = same local date.
 */
function formatEventTime(iso: string): string {
  const d = new Date(iso);
  const hhmm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const now = new Date();
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  if (sameDay) return hhmm;

  const daysAgo = Math.floor((now.getTime() - d.getTime()) / 86400000);
  const weekday = WEEKDAYS[d.getDay()];
  if (daysAgo < 7) return `${weekday} ${hhmm}`;
  return `${weekday} ${pad(d.getDate())} ${hhmm}`;
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}
