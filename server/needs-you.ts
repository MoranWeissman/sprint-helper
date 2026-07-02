/**
 * The "Needs you" block for the dashboard's right rail: which live chats are
 * waiting on Moran's answer, and which tasks other chats finished recently.
 * Pure — all inputs injected, no DB or clock access here.
 */
import type { Session } from './sessions';

/** How long a finished task stays on the card before aging out. */
export const RECENTLY_FINISHED_HOURS = 4;

export interface NeedsYouWaiting {
  workItemId: number;
  /** Pre-formatted `**title** (#id)`, or `#id` when the title is unknown. */
  displayName: string;
  question: string;
  waitingSince: string;
}

export interface NeedsYouFinished {
  workItemId: number;
  displayName: string;
  summary: string | null;
  endedAt: string;
}

export interface NeedsYouBlock {
  waiting: NeedsYouWaiting[];
  recentlyFinished: NeedsYouFinished[];
}

export function buildNeedsYou(opts: {
  activeSessions: Session[];
  /** Sessions ended within the window (see listRecentlyEnded). */
  recentlyEnded: Session[];
  titleFor: (workItemId: number) => string | null;
  /** True when the work item's REAL state is a done state right now. */
  isDone: (workItemId: number) => boolean;
}): NeedsYouBlock {
  const displayName = (id: number) => {
    const title = opts.titleFor(id);
    return title ? `**${title}** (#${id})` : `#${id}`;
  };

  const waiting = opts.activeSessions
    .filter(s => s.waitingSince != null && s.waitingNote != null)
    .map(s => ({
      workItemId: s.workItemId,
      displayName: displayName(s.workItemId),
      question: s.waitingNote as string,
      waitingSince: s.waitingSince as string,
    }));

  // A pause also ends a session — only tasks that are REALLY done now count
  // as finished. Everything else ages out silently.
  const recentlyFinished = opts.recentlyEnded
    .filter(s => s.endedAt != null && opts.isDone(s.workItemId))
    .map(s => ({
      workItemId: s.workItemId,
      displayName: displayName(s.workItemId),
      summary: s.summary,
      endedAt: s.endedAt as string,
    }));

  return { waiting, recentlyFinished };
}
