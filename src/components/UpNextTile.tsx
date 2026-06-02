import type { ApiUpcomingCeremony, ModeId } from '../lib/api';
import { ModeGlyph } from './ModeGlyphs';
import { Mono } from './Mono';

/**
 * Recompute minutes-until from `startsAt` + a fresh client `now`. The server
 * ships its own `minutesUntil` but the stale-while-revalidate dashboard cache
 * can serve a value computed up to a few minutes ago, which is enough to
 * make "started 1h ago" look like "starting now". The client always has a
 * fresh time; trust it for relative phrasing.
 */
function minutesUntilFresh(startsAtISO: string, now: Date): number {
  return Math.round((new Date(startsAtISO).getTime() - now.getTime()) / 60000);
}

/** Map a schedule entry id back to its mode id (daily → day, others 1:1). */
function modeForCeremony(id: ApiUpcomingCeremony['id']): ModeId {
  return id === 'daily' ? 'day' : id;
}

const WEEKDAYS_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function formatTime(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function formatRelative(minutesUntil: number): string {
  if (minutesUntil >= 60) {
    const h = Math.floor(minutesUntil / 60);
    const m = minutesUntil % 60;
    return m === 0 ? `in ${h}h` : `in ${h}h ${m}m`;
  }
  if (minutesUntil > 0) return `in ${minutesUntil} min`;
  if (minutesUntil === 0) return 'starting now';
  const ago = -minutesUntil;
  if (ago < 60) return `started ${ago} min ago`;
  const h = Math.floor(ago / 60);
  const m = ago % 60;
  return m === 0 ? `started ${h}h ago` : `started ${h}h ${m}m ago`;
}

function formatPeekItem(c: ApiUpcomingCeremony, now: Date): string {
  const d = new Date(c.startsAt);
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) return formatTime(c.startsAt);
  // For another day: "Fri 11:00"
  return `${WEEKDAYS_SHORT[d.getDay()]} ${formatTime(c.startsAt)}`;
}

interface UpNextTileProps {
  next: ApiUpcomingCeremony | null;
  upcoming: ApiUpcomingCeremony[];
  /** Fresh client-side current time. Used to recompute relative phrasing locally. */
  now: Date;
  onJump: (mode: ModeId) => void;
  onOpenSchedule: () => void;
}

export function UpNextTile({ next, upcoming, now, onJump, onOpenSchedule }: UpNextTileProps) {
  // Empty state
  if (!next) {
    return (
      <div className="up-next-tile">
        <div className="up-next-head">
          <span className="up-next-flag">
            <span className="dot" />
            UP NEXT
          </span>
          <button
            className="up-next-gear"
            onClick={onOpenSchedule}
            aria-label="Edit schedule"
            title="Edit schedule"
          >
            <ModeGlyph mode="gear" />
          </button>
        </div>
        <p className="up-next-empty">Nothing scheduled in the next two weeks.</p>
      </div>
    );
  }

  // Recompute from the fresh client clock — don't trust the payload's
  // (possibly cached) minutesUntil for relative phrasing.
  const minutesUntil = minutesUntilFresh(next.startsAt, now);
  // "Imminent" = within 15 min of start OR overdue by up to 60 min.
  const imminent = minutesUntil <= 15 && minutesUntil >= -60;
  // Peek list = next 2 entries AFTER the headline one (de-duped by id+date).
  const headlineKey = `${next.id}-${next.startsAt}`;
  const peek = upcoming
    .filter(u => `${u.id}-${u.startsAt}` !== headlineKey)
    .slice(0, 2);

  return (
    <button
      className={`up-next-tile ${imminent ? 'is-imminent' : ''}`}
      onClick={() => onJump(modeForCeremony(next.id))}
      title={`Switch to the ${next.label} workspace`}
    >
      <div className="up-next-head">
        <span className="up-next-flag">
          <span className="dot" />
          UP NEXT · {next.label.toUpperCase()}
        </span>
        <span
          className="up-next-gear"
          onClick={e => {
            e.stopPropagation();
            onOpenSchedule();
          }}
          role="button"
          tabIndex={0}
          aria-label="Edit schedule"
          onKeyDown={e => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              e.stopPropagation();
              onOpenSchedule();
            }
          }}
        >
          <ModeGlyph mode="gear" />
        </span>
      </div>
      <h4 className="up-next-name">{next.label}</h4>
      <div className="up-next-when">
        <Mono className="time">{formatTime(next.startsAt)}</Mono>
        <span className="rel">{formatRelative(minutesUntil)}</span>
      </div>
      {peek.length > 0 && (
        <div className="up-next-peek">
          {peek.map((c, i) => (
            <span key={`${c.id}-${c.startsAt}`}>
              {i > 0 ? ' · ' : ''}
              <span className="v">{c.label}</span>{' '}
              <Mono>{formatPeekItem(c, now)}</Mono>
            </span>
          ))}
        </div>
      )}
    </button>
  );
}
