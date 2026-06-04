/**
 * Stale-session log nudge. Detects open sessions that haven't seen a
 * session_event in a while and surfaces a one-line reminder the AI sees
 * inside its own tool-response context — so the rule "log at checkpoints"
 * gets active feedback instead of relying on the model remembering.
 *
 * Deduped per session per stale window via a settings key: once a nudge
 * fires for a session, it doesn't re-fire until either a session_event
 * lands (resetting the activity clock) OR the session closes.
 *
 * Threshold: 45 minutes of no activity = stale. Picked to avoid firing
 * during a normal stretch of code work + commit cycle, but catch the
 * "I delegated to four agents and forgot to log" failure mode within
 * one batch's typical runtime.
 */
import { getDb } from './db';

const STALE_THRESHOLD_MS = 45 * 60 * 1000;
const NUDGE_KEY_PREFIX = 'log_nudge';

interface OpenSession {
  id: string;
  work_item_id: number;
  started_at: string;
}

interface StaleSession {
  sessionId: string;
  workItemId: number;
  lastActivityAt: string;
  staleMinutes: number;
}

/**
 * Scan open sessions for staleness; fire nudges where needed; return the
 * formatted reminder text (or null if nothing to nudge).
 *
 * Marks each nudged session in `settings` so re-checks within the same
 * stale window don't re-fire. The marker is keyed by session id so
 * different sessions get independent dedup.
 */
export function checkStaleLogNudge(): string | null {
  const db = getDb();
  const now = Date.now();

  const openSessions = db
    .prepare<[], OpenSession>(
      `SELECT id, work_item_id, started_at FROM sessions WHERE ended_at IS NULL`,
    )
    .all();
  if (openSessions.length === 0) return null;

  const stale: StaleSession[] = [];

  for (const s of openSessions) {
    const lastRow = db
      .prepare<[string], { last_at: string | null }>(
        `SELECT MAX(created_at) AS last_at FROM session_events WHERE session_id = ?`,
      )
      .get(s.id);
    const lastActivity = lastRow?.last_at ?? s.started_at;
    const ageMs = now - Date.parse(lastActivity);
    if (ageMs < STALE_THRESHOLD_MS) continue;

    const nudgeKey = `${NUDGE_KEY_PREFIX}_${s.id}`;
    const nudgeRow = db
      .prepare<[string], { value: string }>(`SELECT value FROM settings WHERE key = ?`)
      .get(nudgeKey);
    if (nudgeRow) {
      // Already nudged within this stale window — only re-arm once activity
      // resumes (a session_event lands).
      const lastNudgeMs = Date.parse(nudgeRow.value);
      if (lastNudgeMs > Date.parse(lastActivity)) continue;
    }

    stale.push({
      sessionId: s.id,
      workItemId: s.work_item_id,
      lastActivityAt: lastActivity,
      staleMinutes: Math.floor(ageMs / 60_000),
    });

    db.prepare(
      `INSERT INTO settings (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    ).run(nudgeKey, new Date(now).toISOString());
  }

  if (stale.length === 0) return null;
  return formatNudge(stale);
}

function formatNudge(stale: StaleSession[]): string {
  if (stale.length === 1) {
    const s = stale[0];
    return [
      '',
      '⏰ STALE SESSION — open session on work item #' +
        s.workItemId +
        ' has had no session_log activity in ' +
        s.staleMinutes +
        ' minutes.',
      'If you have been working (including dispatching sub-agents): log a `progress` entry now, naming what got done.',
      'If you have drifted off the task: call `session_end` to close it cleanly.',
      'This nudge fires once per stale window — it will not repeat until either you log or the session closes.',
    ].join('\n');
  }

  const lines = stale.map(
    s => `  - work item #${s.workItemId}: ${s.staleMinutes} min since last activity`,
  );
  return [
    '',
    '⏰ STALE SESSIONS — multiple open sessions have had no session_log activity:',
    ...lines,
    'Log a `progress` entry on each (or call `session_end` on the ones that have drifted).',
    'This nudge fires once per stale window per session.',
  ].join('\n');
}
