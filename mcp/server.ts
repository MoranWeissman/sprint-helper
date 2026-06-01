#!/usr/bin/env node
/**
 * Sprint-helper MCP server.
 *
 * Exposes sprint-helper backend operations to Claude Code (or any MCP client)
 * over stdio. Tools fall into these buckets:
 *  - read:      orient, sprint_snapshot, list_my_work_items
 *  - guardrail: sprint_check_in, task_create, story_create
 *  - edits:     workitem_edit
 *  - sessions:  session_start, session_log, session_end
 *  - notes:     helper_notes_get, helper_note_set_summary, helper_note_add
 *  - calendar:  calendar_set_url, calendar_status, capacity_check
 *
 * Time is tracked silently by the session lifecycle: session_start begins the
 * timer, session_end pauses it — or, with done=true (only after Moran confirms),
 * pushes the tracked time to Azure DevOps and closes the task.
 *
 * Run: `npm run mcp`  (uses tsx so the same source ships from server/ unchanged).
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import { getCalendarUrl, setCalendarUrl } from '../server/calendar.js';
import { computeCapacity } from '../server/capacity.js';
import { buildDashboard } from '../server/dashboard.js';
import { buildDashboardCached, invalidateDashboardCache } from '../server/dashboard-cache.js';
import { sprintCheckIn } from '../server/guardrail.js';
import { addNote, getHelperNotes, setSummary } from '../server/helper-notes.js';
import { buildOrientPacket } from '../server/orient.js';
import {
  endSession,
  isSessionEventType,
  logEvent,
  startSession,
} from '../server/sessions.js';
import * as timerService from '../server/timer-service.js';
import {
  createStory,
  createTask,
  ensureActive,
  setEffort,
  setEstimate,
  setRemaining,
  setStateBucket,
  setStoryPoints,
  type StateBucket,
} from '../server/writes.js';

const SERVER_INSTRUCTIONS = `
Sprint-helper keeps Moran aligned with his Azure DevOps sprint while he works
in Claude Code. Treat it as his sprint conscience — use it proactively, don't
wait to be asked.

OPENING GREETING — call \`orient\` whenever it's your first chance to ground
yourself before responding to Moran. Moran almost always resumes existing
chats or works through /compact rather than starting fresh, so don't wait for
a "new conversation" — fire on ANY of these triggers, as long as you haven't
already called orient in this conversation:

  TRIGGER 1: Truly new conversation — your very first response, before saying
    anything back to him first message.

  TRIGGER 2: Just-compacted conversation — you see a system reminder along
    the lines of "This session is being continued from a previous conversation
    that ran out of context. The summary below covers..." That means the
    context was just summarized; treat this turn as a fresh start and call
    orient before responding.

  TRIGGER 3: Greeting / orientation message from Moran — his message is
    short and reads like he's checking in or picking up after a break.
    Examples: "hi", "hey", "morning", "good morning", "good afternoon",
    "back", "i'm back", "where were we", "where am i", "what should i do",
    "what should i pick up today", "what's next" (when the recent context
    looks idle — not when he's mid-task and just wondering about the next
    step). When in doubt and the message looks like a check-in rather than a
    work instruction, lean toward calling orient.

Call orient AT MOST ONCE per conversation per trigger event. If you already
greeted him with orientation context earlier in this conversation, don't
re-fire on every "hi" he sends — just answer normally. Compact resets that
budget: after a compact, you may call orient again.

WHAT ORIENT RETURNS: a small read of where he is — a time-of-day greeting,
what day of the sprint we're on (e.g. day 4 of 10), any work sessions still
open from before, the last task he worked on (with the summary he left),
the current helper's notes plus how many nudges are still open, and a quick
count of stories/tasks missing planning fields (story points / effort /
estimate).

HOW TO USE IT: write a friendly 2-4 sentence greeting in PARAGRAPH form (not
bullets, not sub-headers), and:
  - open with the \`greeting\` field (it already knows the time of day);
  - if \`lastSession\` is set, say where Moran left off ("Last time you were
    on #1234 — <title>. <summary if there is one>");
  - if \`liveNow\` has anything, mention it plainly ("you've still got a
    session open on #X");
  - mention the sprint day naturally if it helps ("day 4 of 10");
  - if there are open helper notes, just say how many ("you've got 2 notes
    from your helper waiting") — DO NOT paste the note bodies, he reads
    those on his dashboard;
  - end by asking what he wants to pick up today.

FORMATTING — Moran chose the "bold key terms" style. Use markdown:
  - **Bold** for task IDs (\`**#434964**\`, \`**US #434965**\`), the day
    count (\`**day 7 of 14**\`), the sprint name (\`**26_11**\`), and task
    titles when first mentioned.
  - \`inline code\` for technical strings: hostnames, cluster names, URLs,
    file paths, ARN-like ids. Never bold those — code-style is the right cue.
  - Prefix live-session warnings with \`**Heads-up:**\`.
  - Keep paragraph flow — DO NOT use bullet lists, headers, or horizontal
    rules. The structure is conversational, the bold/code is just scan-aid.
  - **Keep sentences short** — one idea per sentence, easy to scan. If a
    sentence has multiple commas or em-dashes connecting related details,
    break it into two. Moran is ADHD-friendly UI — short sentences read
    faster.

Pick the 2-3 things that actually matter and write them like you'd text a
friend — not a list of fields. If \`orient\` fails for any reason (e.g. ADO is
unreachable), just greet Moran and ask what he's working on. Never block on
the call.

AT THE START OF WORK — before diving in:
When Moran says he's starting or working on something (e.g. "I've started
installing argocd", "let's work on the auth refactor", "I'm looking at the
deploy issue"), your FIRST action is to call \`sprint_check_in\` with a short
description of that work. Do this before reading code or running commands.

Then act on the returned \`nextStep\`:
  - confirm_match: tell Moran which sprint task this looks like, confirm it's
    right, then call \`session_start\` with that workItemId.
  - choose_match: list the candidate tasks, ask which one (or if it's
    something else), then \`session_start\`.
  - no_match: tell Moran plainly that this work is NOT in his current sprint.
    Ask: is it a quick 1-2 hour thing, or does it need its own story? Then call
    \`task_create\` (set adHoc=true for the quick case), and \`session_start\`
    against the new task. Never silently let untracked work slide.

AUTO-FLIP ON SESSION START — \`session_start\` automatically transitions the
work item from a "waiting" state (New / To Do / Proposed) to "going" (Active
/ In Progress) in Azure DevOps. This matches reality: opening a session IS
the act of starting work, so the dashboard and ADO should agree. The flip is
silent (no prompt) — that's the design Moran approved.
  - The return payload includes \`stateFlip: { flipped, fromState, toState }\`.
    If \`flipped\` is true, mention it casually in your reply ("I also flipped
    #1234 from New to Active in ADO so it matches reality").
  - If \`stateFlip.error\` is set, the flip failed (rare). Tell Moran the
    session is still open + tracking time, but he may want to flip it
    manually. Don't retry automatically.
  - Already-Active or Done items: no flip happens, no mention needed.

EFFORT — never skip planning fields on Azure DevOps (the POM delivery manager
watches these to gauge sprint progress):
  - Before \`task_create\`: ALWAYS ask Moran for his hours estimate for the
    task. Don't guess and don't call without it — \`estimateHours\` is required.
    The tool also sets RemainingWork to the same value so burndown starts honest.
  - Before \`story_create\`: ALWAYS ask Moran for BOTH story points and effort
    hours (his team treats 1 story point = 1 day; effort is total hours). Don't
    guess and don't call without both.
  - If you notice an existing story or task with missing planning fields (no
    story points / no effort / no estimate / no remaining), call
    \`workitem_edit\` to backfill after Moran tells you the number — drop a
    nudge via \`helper_note_add\` to flag it if you can't fix it right away.

AS WORK PROCEEDS:
  - The open session tracks time automatically. You do NOT start, pause, or
    sync any timer by hand — just keep the session open while he works.
  - Log meaningful moments with \`session_log\`: focus (switching attention),
    progress (what got done), blocker (something in the way), decision (a
    tradeoff chosen), note (anything else worth remembering).

WHEN WORK WRAPS UP — always ask first:
  Ask Moran plainly: "Is this task done, or are you just stopping for now?"
  - Just stopping: call \`session_end\` with a one-line summary. The tracked
    time pauses and NOTHING is written to Azure DevOps — he can pick it back
    up later. THEN check the RemainingWork on the task: if the prior number
    clearly no longer matches reality (he said "almost there" but it shows
    full hours; or he's spent more than the estimate and still has work), ask
    his plainly: "what do you think is left now, in hours?" and update it via
    \`workitem_edit\` once he gives you a number. This keeps the POM delivery
    manager's burndown honest. Don't ask this every session — only when the
    number visibly doesn't fit reality.
  - Done: confirm with him, THEN call \`session_end\` with done=true and a
    summary. This is the only time you write to Azure DevOps automatically, and
    only after he has said yes — it pushes the tracked time and closes the
    task. Never set done=true without his explicit confirmation.

CAPACITY (Moran's real desk time after meetings):
  Moran's Outlook calendar is wired in via a private published URL (stored
  locally, never echoed). Call \`capacity_check\` whenever capacity is at
  stake:
    - When Moran asks "is this realistic?", "how much time do I really
      have?", "what's my capacity this sprint?", "do I have room for X?",
      etc — answer with the numbers from \`capacity_check\`.
    - At sprint planning / pre-planning moments (Pre-plan and Plan modes),
      always check capacity before agreeing to add work.
    - When the orient packet shows a meaningful gap between planned hours
      and real desk hours (planned much higher than capacity), surface it
      in your opening greeting or drop a helper note.
  The tool returns: workingHoursTotal (9h × working days, Mon-Fri),
  meetingHours (BUSY full, TENTATIVE IGNORED entirely per Moran's
  preference, OOF full, clipped to 08:00–18:00 on Mon-Fri), realDeskHours
  = total − meetingHours, plannedHours (sum of RemainingWork), difference
  = planned − realDesk. If \`hasUrl\` is false, the calendar
  isn't wired up — tell Moran plainly that capacity-vs-meetings is unknown
  and point him at docs/setup/outlook-calendar.md.
  If \`fetchError\` is set, the URL is configured but the fetch failed
  (network, link expired, etc.) — say what the error was and offer to clear
  or replace via \`calendar_set_url\`.

KEEPING MORAN'S NOTES (his dashboard's "helper's notes" space):
  This is where you talk TO Moran about his sprint, in plain casual English.
  - Keep a living summary current with \`helper_note_set_summary\`: 1-3 sentences
    on how the sprint is really going and what today is good for. Rewrite it when
    the picture changes (e.g. at the start of work, after closing a task).
  - Drop a nudge with \`helper_note_add\` when you notice something worth his
    attention: an estimate that looks too small for the real work, tasks with no
    movement for days, a light calendar day that's good for deep work. One thought
    per nudge. He ticks them off himself, so don't spam — only genuinely useful
    things. Call \`helper_notes_get\` first to avoid repeating a nudge.
  - Never write effort or status to Azure DevOps from a note — notes are just your
    read for him; ADO writes still only happen via the confirm-first close-the-loop.

Call \`orient\` at the start of EVERY new chat (see OPENING GREETING above).
Call \`sprint_snapshot\` whenever you need to see what's in the current sprint
and what's already live. Use plain English with Moran — never say "ceremony",
"session", or "work item id" to him; say "live", "task", and "#1234".
`.trim();

const server = new McpServer(
  {
    name: 'sprint-helper',
    version: '0.1.0',
  },
  {
    instructions: SERVER_INSTRUCTIONS,
  },
);

/* ============================================================ */
/*  Helpers                                                      */
/* ============================================================ */

/** MCP results return content blocks; this is the boring JSON-in-text variant. */
function jsonResult(value: unknown) {
  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(value, null, 2),
      },
    ],
  };
}

function errorResult(message: string) {
  return {
    isError: true,
    content: [{ type: 'text' as const, text: message }],
  };
}

const workItemIdSchema = z
  .number()
  .int()
  .positive()
  .describe('The Azure DevOps work item id (numeric).');

/* ============================================================ */
/*  Read tools                                                   */
/* ============================================================ */

server.registerTool(
  'orient',
  {
    title: 'Greet Moran at the start of a chat',
    description:
      "Read where Moran left off and what's waiting in his sprint. Call this BEFORE responding whenever you sense he's reorienting: at the start of a new chat, after a /compact, when he resumes and greets you ('hi', 'morning', 'where were we', 'what should i do'), etc. Don't wait for a 'new conversation' — Moran almost always works through resume/compact, so the greeting triggers matter more than session boundaries. Call at most once per orientation moment; don't re-fire on every 'hi'. Returns a time-of-day greeting, what day of the sprint we're on, any work sessions still open, the last task he worked on (with him summary), the current helper's notes plus how many nudges are still open, and a quick count of stories/tasks missing planning fields. Use it to write a friendly 2-4 sentence greeting — don't paste the numbers. See SERVER_INSTRUCTIONS → OPENING GREETING for the full trigger list.",
    inputSchema: {},
  },
  async () => {
    try {
      return jsonResult(await buildOrientPacket());
    } catch (e) {
      return errorResult(e instanceof Error ? e.message : String(e));
    }
  },
);

server.registerTool(
  'sprint_snapshot',
  {
    title: 'Sprint snapshot',
    description:
      "Get a condensed view of Moran's current sprint: which work items are in progress, up next, and done; which timers are running; which Claude Code sessions are live. Call this at the start of a conversation so you understand what he's working on.",
    inputSchema: {},
  },
  async () => {
    const d = await buildDashboard();
    const condensed = {
      sprint: d.sprint && {
        name: d.sprint.name,
        startDate: d.sprint.startDate,
        finishDate: d.sprint.finishDate,
      },
      counts: {
        inProgress: d.workItems.inProgress.length,
        upNext: d.workItems.upNext.length,
        done: d.workItems.done.length,
      },
      capacity: d.capacity,
      activeSessions: d.activeSessions,
      pendingChanges: d.pendingChanges,
      inProgressItems: d.workItems.inProgress.map(slim),
      activeSessionDetails: d.workItems.inProgress
        .filter(w => w.activeSession)
        .map(w => ({
          workItemId: w.id,
          title: w.title,
          sessionId: w.activeSession!.id,
          startedAt: w.activeSession!.startedAt,
        })),
    };
    return jsonResult(condensed);
  },
);

server.registerTool(
  'list_my_work_items',
  {
    title: 'List my work items',
    description:
      "List Moran's work items in the current sprint, optionally filtered by state bucket. Use 'inProgress' for active work, 'upNext' for new/to-do/proposed, 'done' for closed. Omit `state` to get all three buckets.",
    inputSchema: {
      state: z
        .enum(['inProgress', 'upNext', 'done'])
        .optional()
        .describe('Filter by state bucket. Omit for all.'),
    },
  },
  async ({ state }) => {
    const d = await buildDashboard();
    if (state) return jsonResult({ [state]: d.workItems[state].map(slim) });
    return jsonResult({
      inProgress: d.workItems.inProgress.map(slim),
      upNext: d.workItems.upNext.map(slim),
      done: d.workItems.done.map(slim),
    });
  },
);

function slim(w: Awaited<ReturnType<typeof buildDashboard>>['workItems']['inProgress'][number]) {
  return {
    id: w.id,
    title: w.title,
    type: w.type,
    state: w.state,
    parent: w.parent ? { id: w.parent.id, title: w.parent.title } : undefined,
    originalEstimate: w.originalEstimate,
    remainingWork: w.remainingWork,
    runningTimer: w.runningSince ? { startedAt: w.runningSince } : undefined,
    activeSession: w.activeSession,
    recentActivity: w.recentActivity,
  };
}

/* ============================================================ */
/*  Edit tool                                                    */
/* ============================================================ */

server.registerTool(
  'workitem_edit',
  {
    title: 'Edit work item fields',
    description:
      "Update an existing work item in Azure DevOps. Use this to backfill planning fields the POM delivery manager needs. State uses Moran's plain English buckets: 'waiting' (New/To Do/Proposed), 'going' (Active/In Progress/Doing), 'done' (Closed/Done/Resolved). Effort fields are in hours. Story-level fields: storyPoints (his team treats 1 point = 1 day) and effort (total hours he thinks the story is) — use these to fix stories with blank planning.",
    inputSchema: {
      workItemId: workItemIdSchema,
      state: z.enum(['waiting', 'going', 'done']).optional(),
      originalEstimate: z.number().min(0).optional().describe('Task field, in hours.'),
      remainingWork: z.number().min(0).optional().describe('Task field, in hours. Burns down as work happens.'),
      storyPoints: z.number().min(0).optional().describe('Story field. His team treats 1 point = 1 day.'),
      effort: z.number().min(0).optional().describe('Story field, in hours. Total hours he thinks the story is.'),
    },
  },
  async ({ workItemId, state, originalEstimate, remainingWork, storyPoints, effort }) => {
    if (state == null && originalEstimate == null && remainingWork == null && storyPoints == null && effort == null) {
      return errorResult('At least one of state, originalEstimate, remainingWork, storyPoints, effort is required.');
    }
    const applied: {
      state?: string;
      originalEstimate?: number;
      remainingWork?: number;
      storyPoints?: number;
      effort?: number;
    } = {};
    try {
      if (state) applied.state = await setStateBucket(workItemId, state as StateBucket);
      if (originalEstimate != null) {
        await setEstimate(workItemId, originalEstimate);
        applied.originalEstimate = originalEstimate;
      }
      if (remainingWork != null) {
        await setRemaining(workItemId, remainingWork);
        applied.remainingWork = remainingWork;
      }
      if (storyPoints != null) {
        await setStoryPoints(workItemId, storyPoints);
        applied.storyPoints = storyPoints;
      }
      if (effort != null) {
        await setEffort(workItemId, effort);
        applied.effort = effort;
      }
      return jsonResult({ applied });
    } catch (e) {
      return errorResult(e instanceof Error ? e.message : String(e));
    }
  },
);

/* ============================================================ */
/*  Sprint guardrail                                             */
/* ============================================================ */

server.registerTool(
  'sprint_check_in',
  {
    title: 'Sprint check-in (guardrail)',
    description:
      "Before starting a stretch of work, check whether it's in Moran's current sprint. Pass a short natural description of what he wants to do. Returns matching work items (if any), plus a `nextStep` field telling you what to do: 'confirm_match' (one strong candidate — confirm with him then session_start), 'choose_match' (a few possibilities — ask which), or 'no_match' (nothing matches — ask if it's a quick ad-hoc thing or needs a new story, then task_create). ALWAYS call this before opening a new session against work you didn't pick from sprint_snapshot.",
    inputSchema: {
      description: z
        .string()
        .min(1)
        .describe('A short, natural description of what Moran is about to work on.'),
    },
  },
  async ({ description }) => jsonResult(await sprintCheckIn(description)),
);

server.registerTool(
  'task_create',
  {
    title: 'Create an ADO task in the current sprint',
    description:
      "Create a new Task in Azure DevOps, placed in Moran's current sprint and assigned to him. Use after sprint_check_in returned `no_match` AND Moran confirmed he wants this work tracked. ALWAYS ask Moran for his hours estimate before calling — never guess and never skip. estimateHours is required so the POM delivery manager always sees a planning number; RemainingWork is also set to the same value so burndown starts honest. Pass `adHoc: true` for the quick 1–2 hour case (tags it 'ad-hoc'). Pass `parentStoryId` to nest under an existing user story when known. Returns the new task's id and URL.",
    inputSchema: {
      title: z.string().min(1).describe('Task title — short and specific.'),
      description: z.string().optional().describe('Optional details. Plain text or simple HTML.'),
      parentStoryId: z
        .number()
        .int()
        .positive()
        .optional()
        .describe('Optional user story id to link this task under.'),
      estimateHours: z
        .number()
        .min(0)
        .describe("REQUIRED. Moran's own hours estimate — ask him for it before calling. Sets OriginalEstimate AND RemainingWork."),
      adHoc: z
        .boolean()
        .optional()
        .describe('True if this is unplanned ad-hoc work — adds the "ad-hoc" tag for visibility.'),
    },
  },
  async ({ title, description, parentStoryId, estimateHours, adHoc }) => {
    try {
      const created = await createTask({
        title,
        description,
        parentStoryId,
        estimateHours,
        tags: adHoc ? ['ad-hoc'] : undefined,
      });
      return jsonResult(created);
    } catch (e) {
      return errorResult(e instanceof Error ? e.message : String(e));
    }
  },
);

server.registerTool(
  'story_create',
  {
    title: 'Create an ADO user story in the current sprint',
    description:
      "Create a new User Story in Azure DevOps, placed in Moran's current sprint and assigned to him. ALWAYS ask Moran for storyPoints AND effortHours before calling — never guess, never skip. These are the planning fields the POM delivery manager looks at to gauge sprint progress, so they must be set on every story you create. storyPoints uses his team's convention: 1 point = 1 day. effortHours is the total hours he thinks the story is. Pass `parentFeatureId` to nest under an existing Feature/Epic if he has one. Returns the new story's id and URL.",
    inputSchema: {
      title: z.string().min(1).describe('Story title — short and specific.'),
      description: z.string().optional().describe('Optional details. Plain text or simple HTML.'),
      storyPoints: z
        .number()
        .min(0)
        .describe("REQUIRED. Moran's team convention: 1 point = 1 day. Ask him for it before calling."),
      effortHours: z
        .number()
        .min(0)
        .describe('REQUIRED. Total hours Moran thinks this story is. Ask him for it before calling.'),
      parentFeatureId: z
        .number()
        .int()
        .positive()
        .optional()
        .describe('Optional Feature/Epic id to link this story under.'),
    },
  },
  async ({ title, description, storyPoints, effortHours, parentFeatureId }) => {
    try {
      const created = await createStory({
        title,
        description,
        storyPoints,
        effortHours,
        parentFeatureId,
      });
      return jsonResult(created);
    } catch (e) {
      return errorResult(e instanceof Error ? e.message : String(e));
    }
  },
);

/* ============================================================ */
/*  Session tools                                                */
/* ============================================================ */

server.registerTool(
  'session_start',
  {
    title: 'Start a Claude Code session',
    description:
      "Open a session against a work item. Tells sprint-helper that Moran is now working on this item with you. Returns a sessionId you'll pass to later session_log / session_end calls. Idempotent — returns the existing session if one is already open. AUTO-FLIPS the work item state from any 'waiting' state (New / To Do / Proposed) to 'going' (Active / In Progress) in Azure DevOps, since opening a session IS the act of starting work. No prompt — that's the design Moran approved. Reports `stateFlip` so you can mention the flip in your reply.",
    inputSchema: {
      workItemId: workItemIdSchema,
      client: z
        .string()
        .optional()
        .describe('Optional client identifier. Defaults to "claude-code".'),
    },
  },
  async ({ workItemId, client }) => {
    const session = startSession({ workItemId, client });
    timerService.start(workItemId); // silent time tracking begins with the session

    // Auto-flip waiting → going in ADO. If the flip throws, don't fail
    // the whole session_start; report the error in the payload.
    let stateFlip: {
      flipped: boolean;
      fromState: string;
      toState: string;
      error?: string;
    };
    try {
      stateFlip = await ensureActive(workItemId);
      if (stateFlip.flipped) invalidateDashboardCache();
    } catch (e) {
      stateFlip = {
        flipped: false,
        fromState: 'unknown',
        toState: 'unknown',
        error: e instanceof Error ? e.message : String(e),
      };
    }

    return jsonResult({ session, stateFlip });
  },
);

server.registerTool(
  'session_log',
  {
    title: 'Log a session event',
    description:
      "Record an event in an open session. Types: 'focus' (switching attention), 'progress' (what got done so far), 'blocker' (something getting in the way), 'decision' (a tradeoff Moran chose), 'note' (anything else). These surface in his Day dashboard.",
    inputSchema: {
      sessionId: z.string().describe('Session id returned by session_start.'),
      type: z.enum(['focus', 'progress', 'blocker', 'decision', 'note']),
      text: z.string().min(1),
    },
  },
  async ({ sessionId, type, text }) => {
    if (!isSessionEventType(type)) return errorResult(`Unknown event type: ${type}`);
    const event = logEvent({ sessionId, type, text });
    if (!event) return errorResult(`Session not found: ${sessionId}`);
    return jsonResult(event);
  },
);

server.registerTool(
  'session_end',
  {
    title: 'End a Claude Code session',
    description:
      'Close a session with a one-line summary of what got done. Set done=true ONLY after Moran has confirmed the task is finished — that pushes the tracked time to Azure DevOps and closes the task. Omit done (or pass false) when he is just stopping for now: the silent timer pauses and NOTHING is written to Azure DevOps, so he can pick it back up later.',
    inputSchema: {
      sessionId: z.string(),
      summary: z.string().optional(),
      done: z
        .boolean()
        .optional()
        .describe('True only when Moran has explicitly confirmed the task is complete. Pushes tracked time + closes the task in Azure DevOps.'),
    },
  },
  async ({ sessionId, summary, done }) => {
    const session = endSession({ sessionId, summary });
    if (!session) return errorResult(`Session not found: ${sessionId}`);
    try {
      const timer = done
        ? await timerService.markDone(session.workItemId)
        : timerService.pause(session.workItemId);
      return jsonResult({ session, timer });
    } catch (e) {
      return errorResult(e instanceof Error ? e.message : String(e));
    }
  },
);

/* ============================================================ */
/*  Helper's notes                                               */
/* ============================================================ */

server.registerTool(
  'helper_notes_get',
  {
    title: "Get the helper's notes",
    description:
      "Read what's currently in Moran's helper-notes space on his dashboard: the living summary plus his open (not-yet-cleared) nudges. Call this before writing so you don't repeat a nudge that's already there.",
    inputSchema: {},
  },
  async () => jsonResult(getHelperNotes()),
);

server.registerTool(
  'helper_note_set_summary',
  {
    title: "Set the helper's living summary",
    description:
      "Rewrite the one short, always-current plain-English read of Moran's sprint shown at the top of his notes space. Keep it to 1-3 casual sentences — how the sprint is really going, what today is good for. This REPLACES the previous summary. Pass an empty string to clear it.",
    inputSchema: {
      summary: z.string().describe('1-3 casual, plain-English sentences. Empty string clears it.'),
    },
  },
  async ({ summary }) => jsonResult(setSummary(summary)),
);

server.registerTool(
  'helper_note_add',
  {
    title: "Add a nudge to the helper's notes",
    description:
      "Drop a single short nudge into Moran's notes space — something you noticed worth his attention (an estimate that looks low, tasks gone quiet, a good day for deep work). Plain, casual English, one thought per note. He ticks these off himself once handled, so only add things that are genuinely actionable or worth seeing.",
    inputSchema: {
      body: z.string().min(1).describe('One short, casual, plain-English nudge.'),
    },
  },
  async ({ body }) => jsonResult(addNote(body)),
);

/* ============================================================ */
/*  Calendar + capacity                                          */
/* ============================================================ */

server.registerTool(
  'calendar_set_url',
  {
    title: 'Store Moran\'s Outlook calendar URL',
    description:
      "Save the published ICS URL from Moran's Outlook (one-time setup). Pass an empty string to clear it. The URL is stored in local SQLite — never echoed back in chat. Setup instructions: docs/setup/outlook-calendar.md.",
    inputSchema: {
      url: z
        .string()
        .describe('The published ICS URL from Outlook on the web. Empty string clears the stored URL.'),
    },
  },
  async ({ url }) => {
    const trimmed = url.trim();
    if (trimmed === '') {
      setCalendarUrl(null);
      return jsonResult({ ok: true, cleared: true });
    }
    if (!/^https:\/\//.test(trimmed)) {
      return errorResult('URL must start with https://');
    }
    setCalendarUrl(trimmed);
    // Don't echo the URL back — just confirm the host so Moran can verify.
    let host: string;
    try {
      host = new URL(trimmed).host;
    } catch {
      host = '(unparsable)';
    }
    return jsonResult({ ok: true, host });
  },
);

server.registerTool(
  'calendar_status',
  {
    title: 'Check calendar wiring',
    description:
      "Report whether an Outlook calendar URL is configured for sprint-helper. Returns the host (e.g. outlook.office365.com) but NEVER the full URL — that's private. Use this when Moran asks 'is my calendar hooked up?'.",
    inputSchema: {},
  },
  async () => {
    const url = getCalendarUrl();
    if (!url) return jsonResult({ configured: false });
    try {
      return jsonResult({ configured: true, host: new URL(url).host });
    } catch {
      return jsonResult({ configured: true, host: '(unparsable)' });
    }
  },
);

server.registerTool(
  'capacity_check',
  {
    title: 'Real desk time vs planned',
    description:
      "Compute Moran's real desk time for the current sprint: working hours total (8h/day Mon-Fri by default), minus meetings from his Outlook calendar (BUSY full, TENTATIVE half, OOF full, all clipped to working hours), minus FREE-marked time = real desk hours. Compares to planned task hours (sum of RemainingWork on in-progress + up-next tasks). Use this when Moran asks 'is this sprint realistic?', 'how much time do I really have?', etc. If no calendar URL is set, returns capacity without meeting subtractions and flags hasUrl=false — surface that to Moran.",
    inputSchema: {},
  },
  async () => {
    try {
      const { payload } = await buildDashboardCached();
      if (!payload.sprint) return errorResult('No current sprint — set a sprint first.');
      const plannedHours = payload.capacity.remainingHours;
      const cap = await computeCapacity({
        sprintStart: new Date(payload.sprint.startDate),
        sprintEnd: new Date(payload.sprint.finishDate),
        plannedHours,
      });
      return jsonResult({ sprintName: payload.sprint.name, ...cap });
    } catch (e) {
      return errorResult(e instanceof Error ? e.message : String(e));
    }
  },
);

/* ============================================================ */
/*  Boot                                                         */
/* ============================================================ */

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Pre-warm the dashboard cache so the first orient/capacity_check
  // call doesn't pay the 10–15s cold ADO fetch. Fire-and-forget;
  // don't block the MCP handshake.
  void buildDashboardCached().catch(() => {
    // eslint-disable-next-line no-console
    console.error('sprint-helper: dashboard pre-warm failed (will lazy-load on first call).');
  });
  // stdio transport keeps the process alive; nothing else needed.
}

main().catch(err => {
  // eslint-disable-next-line no-console
  console.error('sprint-helper MCP server crashed:', err);
  process.exit(1);
});
