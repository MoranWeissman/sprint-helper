import { useCallback, useEffect, useState } from 'react';
import {
  fetchPrePlan,
  savePrePlan,
  type ApiPrePlanCall,
  type ApiPrePlanCard,
  type ApiPrePlanGoal,
  type ApiPrePlanPayload,
} from '../lib/api';

interface PrePlanViewProps {
  onOpenItem?: (id: string) => void;
}

const CALL_OPTIONS: { value: ApiPrePlanCall; label: string }[] = [
  { value: 'on-track', label: 'On track' },
  { value: 'at-risk', label: 'At risk' },
  { value: 'carries-over', label: 'Carries over' },
];

function relAgo(iso: string | null): string {
  if (!iso) return 'no activity logged';
  const then = new Date(iso).getTime();
  const days = Math.floor((Date.now() - then) / (1000 * 60 * 60 * 24));
  if (days <= 0) return 'active today';
  if (days === 1) return 'active yesterday';
  return `last active ${days} days ago`;
}

export function PrePlanView({ onOpenItem }: PrePlanViewProps) {
  const [data, setData] = useState<ApiPrePlanPayload | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    fetchPrePlan()
      .then(d => {
        setData(d);
        setError(null);
      })
      .catch(e => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  useEffect(() => { load(); }, [load]);

  const saveStory = (id: string, patch: { call?: ApiPrePlanCall; goalIndex?: number | null }) => {
    // optimistic
    setData(prev =>
      prev
        ? {
            ...prev,
            cards: prev.cards.map(c =>
              c.id === id
                ? { ...c, ...patch, callIsSuggested: patch.call !== undefined ? false : c.callIsSuggested }
                : c,
            ),
          }
        : prev,
    );
    savePrePlan({ story: { id, ...patch } })
      .then(setData)
      .catch(e => { setError(e instanceof Error ? e.message : String(e)); load(); });
  };

  if (error) {
    return <div className="preplan-state preplan-error">Couldn't load the pre-plan page. {error}</div>;
  }
  if (!data) {
    return <div className="preplan-state">Loading your stories…</div>;
  }

  return (
    <div className="preplan">
      <header className="preplan-head">
        <h1>Pre-plan</h1>
        <p className="preplan-sub">Get ready for the pre-plan meeting. Set where each story stands.</p>
      </header>

      <section className="preplan-goals">
        <p className="preplan-goals-hint">
          Paste your goals email into a chat and ask me to set them up. They’ll appear here.
        </p>
        {data.goals.length === 0 ? (
          <p className="preplan-goals-empty">No goals set yet.</p>
        ) : (
          <ul className="preplan-goals-list">
            {data.goals.map((g, i) => (
              <li key={i} className={`preplan-goal-item${g.isMine ? ' is-mine' : ''}`}>
                <span className="preplan-goal-text">Goal {i + 1}: {g.text}</span>
                {g.owner && <span className="preplan-goal-owner">{g.owner}</span>}
                {g.isMine && <span className="preplan-goal-mine">mine</span>}
              </li>
            ))}
          </ul>
        )}
      </section>

      {data.cards.length === 0 ? (
        <div className="preplan-state">No stories in flight to review — nothing to prep.</div>
      ) : (
        <section className="preplan-cards">
          {data.cards.map(card => (
            <PrePlanCardRow
              key={card.id}
              card={card}
              goals={data.goals}
              onOpenItem={onOpenItem}
              onCall={call => saveStory(card.id, { call })}
              onGoal={goalIndex => saveStory(card.id, { goalIndex })}
            />
          ))}
        </section>
      )}

      {data.goals.length > 0 && (
        <section className="preplan-coverage">
          <h2>Goal coverage</h2>
          <ul>
            {data.coverage.map(g => {
              const countText = g.storyCount === 0
                ? "nobody's carrying this"
                : `${g.storyCount} ${g.storyCount === 1 ? 'story' : 'stories'} on it`;
              return (
                <li key={g.index} className={g.storyCount === 0 ? 'preplan-gap' : ''}>
                  Goal {g.index + 1} — {g.text}: {countText}
                </li>
              );
            })}
          </ul>
        </section>
      )}

      {data.room.hasCapacity && (
        <p className="preplan-room">
          Your open stories need about {data.room.openStoriesRemainingHours}h; you've got about {data.room.roomHours}h of room left
          {data.room.openStoriesRemainingHours > data.room.roomHours
            ? ` — roughly ${data.room.openStoriesRemainingHours - data.room.roomHours}h won't fit.`
            : '.'}
        </p>
      )}
    </div>
  );
}

function PrePlanCardRow(props: {
  card: ApiPrePlanCard;
  goals: ApiPrePlanGoal[];
  onOpenItem?: (id: string) => void;
  onCall: (call: ApiPrePlanCall) => void;
  onGoal: (goalIndex: number | null) => void;
}) {
  const { card, goals, onOpenItem, onCall, onGoal } = props;
  // displayName is **title** (#id) — render the title plain; strip the markdown stars and trailing id.
  const title = card.displayName.replace(/\*\*/g, '').replace(/\s*\(#\d+\)\s*$/, '');
  const idMatch = card.displayName.match(/#(\d+)/);
  const id = idMatch ? idMatch[1] : card.id;

  return (
    <article className={`preplan-card${card.blocked ? ' is-blocked' : ''}`}>
      <div className="preplan-card-main">
        <button type="button" className="preplan-card-title" onClick={() => onOpenItem?.(card.id)}>
          {title} <span className="preplan-id">#{id}</span>
        </button>
        <div className="preplan-facts">
          <span>{card.remainingHours}h left</span>
          {card.blocked && <span className="preplan-blocked">blocked</span>}
          <span>{relAgo(card.lastActivityAt)}</span>
        </div>
      </div>
      <div className="preplan-card-actions">
        <div className="preplan-call" role="group" aria-label="Where does this story stand?">
          {CALL_OPTIONS.map(opt => (
            <button
              key={opt.value}
              type="button"
              className={`preplan-call-btn${card.call === opt.value ? ' is-on' : ''}${card.call === opt.value && card.callIsSuggested ? ' is-suggested' : ''}`}
              onClick={() => onCall(opt.value)}
            >
              {opt.label}
            </button>
          ))}
        </div>
        {goals.length > 0 && (
          <select
            className="preplan-goal-select"
            value={card.goalIndex ?? ''}
            onChange={e => onGoal(e.target.value === '' ? null : Number(e.target.value))}
          >
            <option value="">no goal</option>
            {goals.map((g, i) => (
              <option key={i} value={i}>{`Goal ${i + 1}: ${g.text.length > 40 ? g.text.slice(0, 39) + '…' : g.text}`}</option>
            ))}
          </select>
        )}
      </div>
    </article>
  );
}
