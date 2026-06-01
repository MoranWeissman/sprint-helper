#!/usr/bin/env node
/**
 * Sprint-helper MCP server.
 *
 * Exposes sprint-helper backend operations to Claude Code (or any MCP client)
 * over stdio. Tools fall into these buckets:
 *  - read:      orient, sprint_snapshot, list_my_work_items, workitem_get
 *  - guardrail: sprint_check_in, task_create, story_create
 *  - estimate:  estimate_anchor
 *  - edits:     workitem_edit, workitem_reparent
 *  - blocking:  workitem_block, workitem_unblock
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
import { buildEstimateAnchor } from '../server/estimate-anchor.js';
import { buildOrientPacket } from '../server/orient.js';
import {
  endSession,
  isSessionEventType,
  logEvent,
  startSession,
} from '../server/sessions.js';
import * as timerService from '../server/timer-service.js';
import { getWorkItem } from '../server/ado.js';
import {
  createStory,
  createTask,
  ensureActive,
  reparent,
  setEffort,
  setEstimate,
  setIterationPath,
  setRemaining,
  setStateBucket,
  setStoryPoints,
  transitionFromBlocked,
  transitionToBlocked,
  updateTags,
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

SPRINT-SCOPED — sprint-helper operates on Moran's CURRENT sprint by default.
All reads (orient, sprint_snapshot, capacity_check) and routing decisions
("which item is 'this'", "which parent for that anchor") use the current
sprint as the primary context. Items outside the current sprint exist
(sprintOptions lists them, sprint_check_in can surface near-matches), but
they are NOT the default context. Don't reach outside the current sprint
unless Moran explicitly references something there ("the story I closed
last sprint", "#430000"). When resolving an ambiguous "this" / "that" /
"the task" / "the story", search in this order:
  1. The live-session item Moran is currently working on (orient.liveNow)
  2. An item he just mentioned by id (#NNNNNN)
  3. A title match against current-sprint items (workItems + userStories)
  4. ASK him — don't expand the search globally.

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

KEEPING CHILD TASKS IN SYNC — silent open, close-the-loop done:
When Moran has an open session (typically against a story), the conversation
will move through specific child tasks ("now I'm setting up the IRSA role",
"moving to the GitHub App connection", "ESO is configured, next is the
secret sync"). You're responsible for keeping ADO in sync with that movement
— Moran does NOT want to manually flip task states. This is the design he
approved 2026-06-01.

  - At the start of an open session, call \`sprint_snapshot\` (or
    \`list_my_work_items\`) once to learn which child tasks belong to the
    story being worked on. Keep that mental map.
  - When you start ACTIVELY working on a specific child task and it's still
    in a "waiting" state (New / To Do / Proposed), call:
        workitem_edit({ workItemId: <task id>, state: 'going' })
    silently. Same philosophy as session_start auto-flip: you're starting
    work, ADO should reflect reality. No prompt.
  - When a task's work is FINISHED (clear from the progress events you've
    logged), ASK Moran plainly: "task #N looks done — want me to close
    it?" Only after he says yes:
        workitem_edit({ workItemId: <task id>, state: 'done' })
    Done writes still need explicit confirmation per the close-the-loop
    rule. NEVER auto-done without his nod.
  - When focus shifts from one task to another within the same session,
    optionally drop a \`session_log\` "focus" event mentioning the new task
    so his activity feed shows the movement.
  - The story (parent) flips automatically at session_start. Child tasks
    flip as you encounter them. There's no cascade — flipping the story
    doesn't flip children, and flipping one child doesn't flip siblings.

EFFORT — propose estimates, don't just ask. Then burn down, then close.
The POM delivery manager watches Azure DevOps planning fields to track
sprint progress, so these must always be set and they must stay honest
through the life of the task.

  AT CREATION — DECOMPOSE, ANCHOR, then PROPOSE:
  - STEP 1 (decompose): mentally break the task into 2-4 concrete
    sub-steps before proposing a number. "Read existing code · write
    new handler · wire it up · test · review feedback loop." This
    kills single-shot anchoring bias — most under-estimates come from
    forgetting setup, testing, or review.
  - STEP 2 (anchor): call \`estimate_anchor({ parentId })\` to pull real
    "estimate vs actual" data from Moran's closed tasks. Read the
    siblings (closed tasks under the same parent story) — pick the
    1-3 most semantically similar by title/type and use their ACTUAL
    hours, not their estimates, as the prior. If sibling data is
    sparse (≤ 2 samples), use the calibration.overallRatio as a
    multiplier on your gut sum from STEP 1. If \`isColdStart\` is
    true, say so plainly: "no history to anchor on yet — proposing a
    gut number, want to tighten it?"
  - STEP 3 (propose): present the proposal honestly, citing the anchor:
    "Similar past tasks under this story ran 4-6h actual (gut would
    have said 3h). Decomposed I get ~5h (1h reading · 2h core · 1h
    tests · 1h cleanup). Proposing 5h. Sound right?" Then ask Moran
    "sound right?". He'll confirm or adjust. Never just "what's your
    estimate?" — that pushes the work back to him. Use the confirmed
    number for \`estimateHours\`. \`task_create\` sets both
    OriginalEstimate and RemainingWork to that value so burndown
    starts honest.
  - Before \`story_create\`: same three steps for effortHours, and
    propose storyPoints (his team: 1 point = 1 day) consistent with
    the hours. Anchor by passing the Feature/Epic id as \`parentId\`
    to estimate_anchor — its calibration ratio still helps even
    without sibling stories.
  - Backfilling existing items with blank planning: same approach.
    Decompose, anchor (use the existing parentId), propose, confirm
    with Moran, then call \`workitem_edit\`.

  AUTO-FIRE on intent — don't make Moran ASK for an estimate. When his
  sentence describes wanting new work tracked, run the full ritual
  without him saying "help me estimate". Trigger phrases:
    "let's add a task for X", "add a task to Y", "I want to track Z",
    "track this", "add this to the sprint", "another task for X",
    "let's spin up a story for X", "add a story for Y", "new story"
  Then: \`sprint_check_in\` → \`estimate_anchor\` → propose with citation →
  confirm → \`task_create\` / \`story_create\`. The "estimate help" path
  fires from this intent — Moran never has to ask for it explicitly.

  AS WORK PROGRESSES — keep RemainingWork honest:
  - This is sprint-helper's PRIMARY job during work: keep Remaining
    accurate so the burn-down chart is honest. Moran shouldn't have to
    update it manually.
  - When you log a \`session_log\` "progress" event that completes a
    SUBSTANTIAL chunk of a task (more than a tweak), also call
    \`workitem_edit({ workItemId: <task id>, remainingWork: <new value> })\`
    with an honest estimate of what's left. No prompt for normal
    decreases — just do it. Same authority as state flips.
  - Skip the update for small tweaks. The signal is "I just finished
    a meaningful part of this" — multiple small steps batch into one
    decrement when the chunk is done.
  - If you genuinely don't know, leave it alone. Better to skip than
    to add noise.

  WHEN A TASK CLOSES — compute Completed from the burndown:
  - The canonical model: CompletedWork = OriginalEstimate - new
    RemainingWork. If Moran has been keeping Remaining honest (which
    is your job), this represents what was actually done.
  - At session_end with done=true (or when Moran confirms a task is
    finished), STATE the proposed Completed number: "OriginalEstimate
    was 4h, Remaining is 1h → Completed = 3h. Sound right?". After
    confirmation, the existing close-the-loop pipeline pushes that.
  - If RemainingWork is far off from actual work done (e.g. you forgot
    to burn it down), surface that plainly: "Remaining still shows 4h
    but the work looks done — what does Completed actually feel like
    in hours?" Then call workitem_edit({remainingWork: 0, ...}) and
    let session_end compute Completed.
  - Session time (the silent timer) is a SECONDARY signal — useful for
    "you've spent 5h, estimate was 4h, want to bump Remaining or
    Estimate?" nudges. It does NOT auto-drive CompletedWork — the
    burndown does.

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
    up later. RemainingWork should already be honest from your burndown work
    during the session (see EFFORT → AS WORK PROGRESSES). If you forgot to
    update it during work and the current number is clearly off, fix it now
    via \`workitem_edit({remainingWork: …})\`.
  - Done: confirm with him, THEN propose the Completed number using the
    burndown formula (CompletedWork = OriginalEstimate - new RemainingWork),
    and ask "sound right?". After he confirms, call \`session_end\` with
    done=true. The existing close-the-loop pipeline will push effort and
    close the task. This is the only time you write CompletedWork
    automatically, and only after his explicit confirmation. Never set
    done=true without his nod.

CAPACITY (Moran's real desk time after meetings):
  Moran's Outlook calendar is wired in via a private published URL (stored
  locally, never echoed). Capacity comes back two ways:

  1. As \`capacity\` inside the orient packet (cheapest — same numbers, no
     extra calendar fetch). Use this for the opening greeting.
  2. Via the explicit \`capacity_check\` tool when capacity is at stake
     mid-conversation.

  When to read capacity from orient:
    - Always read \`orient.capacity\` once at the start of the chat.
    - If \`capacity.hasUrl\` is true and \`difference\` is ≥ 8h
      (planned > real desk), the opening greeting should mention it
      plainly ("you're planned about Xh over capacity"). The system will
      have also dropped a one-time-per-sprint helper note about this.
    - If \`difference\` is ≤ -8h (more slack than planned work), gentle
      "you've got room to pull something in" framing.

  When to call \`capacity_check\` directly:
    - When Moran asks "is this realistic?", "how much time do I really
      have?", "what's my capacity this sprint?", "do I have room for X?".
    - At sprint planning / pre-planning moments (Pre-plan and Plan modes),
      always check capacity before agreeing to add work.

  The shape both paths return: workingHoursTotal (9h × working days,
  Mon-Fri), meetingHours (BUSY full, TENTATIVE IGNORED entirely per
  Moran's preference, OOF full, clipped to 08:00–18:00 on Mon-Fri),
  realDeskHours = total − meetingHours, plannedHours (sum of
  RemainingWork), difference = planned − realDesk. If \`hasUrl\` is false,
  the calendar isn't wired up — tell Moran plainly that
  capacity-vs-meetings is unknown and point him at
  docs/setup/outlook-calendar.md. If \`fetchError\` is set, the URL is
  configured but the fetch failed (network, link expired, etc.) — say
  what the error was and offer to clear or replace via
  \`calendar_set_url\`.

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

BLOCKING (when something can't move forward right now):
  Moran's ADO process template has 'Blocked' as a first-class STATE for
  both Task and User Story — that's the canonical lifecycle signal, not a
  tag. Sprint-helper transitions the real state and bundles in the "why"
  so neither half is ever stranded:
    - To block: call \`workitem_block\` with reason and (if known) owner +
      unblockCondition. This transitions the work item to its 'Blocked'
      state in ADO, captures the prior state (Active, "Waiting for
      Testing", etc.) for restoration, also adds a 'Blocked' tag as a
      legacy/redundant signal, opens a session on the item if needed, and
      records a 'blocker'-type session event with reason/owner/unblock-
      condition.
    - To unblock: call \`workitem_unblock\` with a short summary. This
      transitions the item back to its prior state in ADO (or to Active
      as a fallback), removes the 'Blocked' tag, and records a
      'decision'-type session event.
  NEVER set state to Blocked or add a 'Blocked' tag via \`workitem_edit\`
  — the dedicated tools exist so state and narrative stay welded together.
  Feature work items don't have Blocked; they have 'On Hold' (also
  recognized by the blocked bucket). Bugs don't have Blocked — for those,
  the tag is still the only signal sprint-helper can use.

  AUTO-DETECT — don't make Moran ASK sprint-helper to block. When his
  conversation contains any of these, route to \`workitem_block\` from
  context (resolve the item via SPRINT-SCOPED rules above; use the
  remainder of his sentence as the reason; ask only for missing owner /
  unblockCondition):
    "is blocked", "I'm blocked", "blocked on", "waiting on", "stuck on",
    "X is holding this up", "can't move forward until", "depending on",
    "in someone else's court"
  And for \`workitem_unblock\`:
    "X landed", "Y merged", "we got the green light", "unblocked",
    "back on track", "the fix is in", "X cleared it", "the dep landed"
  Confirm the item id once if ambiguous, then act. Don't pop a menu for
  a state Moran has already described — the menu is for PULL operations
  only (see EXPLICIT MENU below).

PREFER SPRINT-HELPER OVER RAW \`az\` — STRICT. Sprint-helper exists so Moran
has ONE coordinated layer in front of Azure DevOps. Every board read and
write goes through it; nothing else. Caches stay coherent, the dashboard and
the assistant see the same state. Reaching for \`az boards\` is almost
always a sign you missed a sprint-helper tool. Concretely:
  - Reading one item by id → \`workitem_get\`.
  - Listing an epic / story's children → \`workitem_get\` (its \`children\`
    array has id/title/type/state for each direct child).
  - Listing the sprint → \`sprint_snapshot\` or \`list_my_work_items\`.
  - Any field change (state, estimate, remaining, story points, effort,
    tags, iteration path) → \`workitem_edit\`.
  - Moving an item under a different parent → \`workitem_reparent\`.
  - Creating a task / story → \`task_create\` / \`story_create\`.
  - Anchoring an estimate on real history → \`estimate_anchor\` (always
    before proposing an OriginalEstimate, never propose blind).
  - Blocking / unblocking → \`workitem_block\` / \`workitem_unblock\` (never
    add a 'Blocked' tag through \`workitem_edit\` — that strands the why
    from the what).

If you genuinely think sprint-helper lacks an operation you need, STOP
and tell Moran plainly: "sprint-helper doesn't have a tool for X yet —
should I use raw az for this one thing, or pause and ask for a sprint-
helper tool to be added?" Don't silently shell out to az to work around
a perceived gap. The whole point is that we find gaps and close them
together, not route around them.

Call \`orient\` at the start of EVERY new chat (see OPENING GREETING above).
Call \`sprint_snapshot\` whenever you need to see what's in the current sprint
and what's already live. Use plain English with Moran — never say "ceremony",
"session", or "work item id" to him; say "live", "task", and "#1234".

GROUNDING STATE QUESTIONS (mid-conversation): if Moran asks anything about
the CURRENT state of his sprint — "where are we", "what's blocked", "what's
done", "what's next", "status", "recap", "what's pending", "how's the
sprint going", etc. — call \`sprint_snapshot\` (or the relevant read tool)
BEFORE answering. Even when \`orient\` already fired earlier in this same
conversation. Conversation memory drifts the moment any write happens (by
Moran, by you, by another session, by ADO itself). Sprint-helper is the
source of truth; memory is not. The cost of an extra read is small; the
cost of a stale answer is wrong work.

EXPLICIT MENU (\`/sprint-helper\`): Moran has a user-level skill at
\`~/.claude/skills/sprint-helper/SKILL.md\` that pops a menu of common
operations. When he types \`/sprint-helper\` you'll be handed instructions
to show him an \`AskUserQuestion\` menu and route to the right MCP tool.
Follow those instructions verbatim — don't substitute conversation memory
for the called tool.
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
      "Read where Moran left off and what's waiting in his sprint. Call this BEFORE responding whenever you sense he's reorienting: at the start of a new chat, after a /compact, when he resumes and greets you ('hi', 'morning', 'where were we', 'what should i do'), etc. Don't wait for a 'new conversation' — Moran almost always works through resume/compact, so the greeting triggers matter more than session boundaries. Call at most once per orientation moment; don't re-fire on every 'hi'. Returns a time-of-day greeting, what day of the sprint we're on, any work sessions still open, the last task he worked on (with his summary), the current helper's notes plus how many nudges are still open, a quick count of stories/tasks missing planning fields, and his sprint capacity (real desk time vs planned hours, derived from his Outlook calendar). Use it to write a friendly 2-4 sentence greeting — don't paste the numbers. See SERVER_INSTRUCTIONS → OPENING GREETING and → CAPACITY for the full trigger list.",
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
      "Update an existing work item in Azure DevOps. Covers state, effort fields, story planning fields, and tags. State uses Moran's plain English buckets: 'waiting' (New/To Do/Proposed), 'going' (Active/In Progress/Doing), 'done' (Closed/Done/Resolved). Effort fields are in hours. Story-level: storyPoints (his team treats 1 point = 1 day) and effort (total hours). Tags: addTags adds them (case-insensitive dedup), removeTags removes them, both can be passed together.",
    inputSchema: {
      workItemId: workItemIdSchema,
      state: z.enum(['waiting', 'going', 'done']).optional(),
      originalEstimate: z.number().min(0).optional().describe('Task field, in hours.'),
      remainingWork: z.number().min(0).optional().describe('Task field, in hours. Burns down as work happens.'),
      storyPoints: z.number().min(0).optional().describe('Story field. His team treats 1 point = 1 day.'),
      effort: z.number().min(0).optional().describe('Story field, in hours. Total hours he thinks the story is.'),
      addTags: z.array(z.string().min(1)).optional().describe('Tag names to add to this item (e.g. ["Blocked"]). Case-insensitive dedup against existing tags.'),
      removeTags: z.array(z.string().min(1)).optional().describe('Tag names to remove from this item.'),
      iterationPath: z.string().min(1).optional().describe('Full ADO iteration path, backslash-separated (e.g. "IDP - DevOps\\\\2026" for the year-level, or "IDP - DevOps\\\\2026\\\\Q2\\\\26_11" for a specific sprint). Use this to move an item to a different sprint or to a parent iteration node.'),
    },
  },
  async ({ workItemId, state, originalEstimate, remainingWork, storyPoints, effort, addTags, removeTags, iterationPath }) => {
    if (
      state == null && originalEstimate == null && remainingWork == null &&
      storyPoints == null && effort == null &&
      (addTags == null || addTags.length === 0) &&
      (removeTags == null || removeTags.length === 0) &&
      iterationPath == null
    ) {
      return errorResult('At least one of state, originalEstimate, remainingWork, storyPoints, effort, addTags, removeTags, iterationPath is required.');
    }
    const applied: {
      state?: string;
      originalEstimate?: number;
      remainingWork?: number;
      storyPoints?: number;
      effort?: number;
      tags?: string[];
      iterationPath?: string;
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
      if ((addTags && addTags.length > 0) || (removeTags && removeTags.length > 0)) {
        applied.tags = await updateTags(workItemId, { add: addTags, remove: removeTags });
      }
      if (iterationPath != null) {
        await setIterationPath(workItemId, iterationPath);
        applied.iterationPath = iterationPath;
      }
      invalidateDashboardCache();
      return jsonResult({ applied });
    } catch (e) {
      return errorResult(e instanceof Error ? e.message : String(e));
    }
  },
);

server.registerTool(
  'workitem_get',
  {
    title: 'Read a single work item',
    description:
      "Fetch one work item by id from Azure DevOps. Returns id, type, title, state, tags (as an array), assignedTo, iteration (last segment), parent (id+title+type), children list, originalEstimate / remainingWork / completedWork, plus url. Use this instead of shelling out to 'az boards work-item show' so writes stay coordinated with sprint-helper's caches and Moran's POM delivery manager sees consistent state.",
    inputSchema: {
      workItemId: workItemIdSchema,
    },
  },
  async ({ workItemId }) => {
    try {
      const d = await getWorkItem(workItemId);
      const tags = (d.tags ?? '')
        .split(';')
        .map(t => t.trim())
        .filter(t => t.length > 0);
      const iteration = d.iterationPath.split('\\').pop() ?? d.iterationPath;
      return jsonResult({
        id: d.id,
        type: d.type,
        title: d.title,
        state: d.state,
        tags,
        assignedTo: d.assignedTo,
        iteration,
        parent: d.parent
          ? { id: d.parent.id, title: d.parent.title, type: d.parent.type, state: d.parent.state }
          : undefined,
        children: d.children.map(c => ({ id: c.id, title: c.title, type: c.type, state: c.state })),
        originalEstimate: d.originalEstimate,
        remainingWork: d.remainingWork,
        completedWork: d.completedWork,
        webUrl: d.webUrl,
      });
    } catch (e) {
      return errorResult(e instanceof Error ? e.message : String(e));
    }
  },
);

server.registerTool(
  'workitem_reparent',
  {
    title: 'Move a work item under a different parent',
    description:
      "Reparent a work item: remove its existing parent relation(s) and link it under a new parent in Azure DevOps. Use this when reorganizing the board (e.g. moving a task from one user story to another, or pulling a follow-up out of a finished story and putting it under the right one). Returns the previous parent ids that were removed and confirms the new parent.",
    inputSchema: {
      childId: workItemIdSchema.describe('The work item to move.'),
      newParentId: workItemIdSchema.describe('The new parent (User Story / Feature / Epic) to nest the child under.'),
    },
  },
  async ({ childId, newParentId }) => {
    try {
      const result = await reparent(childId, newParentId);
      invalidateDashboardCache();
      return jsonResult(result);
    } catch (e) {
      return errorResult(e instanceof Error ? e.message : String(e));
    }
  },
);

/* ============================================================ */
/*  Blocking                                                     */
/* ============================================================ */

server.registerTool(
  'workitem_block',
  {
    title: 'Mark a work item blocked (state + tag + structured log)',
    description:
      "ONE call to block a work item — use this as the only way to mark something blocked. Transitions the item to its 'Blocked' state in Azure DevOps (Moran's process has Blocked as a first-class state for Task and User Story — this is the canonical signal, not just a tag). Also adds a 'Blocked' tag as a redundant signal for legacy compatibility, and writes a structured `blocker`-type entry in the item's session log capturing the reason, optional owner, and optional unblockCondition. The prior state is captured so workitem_unblock can restore it. Auto-opens a session on the item if one isn't already open. NEVER set state to Blocked via workitem_edit and leave the narrative stranded — that's the gap this tool exists to close.",
    inputSchema: {
      workItemId: workItemIdSchema,
      reason: z.string().min(1).describe("Plain-English why it's blocked (e.g. 'NAT EIP attach is failing in prod')."),
      owner: z.string().optional().describe("Who's holding the block, if known (e.g. 'Yosef', 'Platform team', 'waiting on Legal')."),
      unblockCondition: z
        .string()
        .optional()
        .describe('Concrete condition for unblocking (e.g. "Yosef finishes NAT EIP retry logic", "Legal sign-off on Article 12 wording").'),
    },
  },
  async ({ workItemId, reason, owner, unblockCondition }) => {
    try {
      const stateChange = await transitionToBlocked(workItemId);
      const tags = await updateTags(workItemId, { add: ['Blocked'] });
      const session = startSession({ workItemId });
      timerService.start(workItemId);

      const parts = [`BLOCKED: ${reason}`];
      if (owner) parts.push(`Owner: ${owner}`);
      if (unblockCondition) parts.push(`Unblock when: ${unblockCondition}`);
      parts.push(`(was ${stateChange.fromState})`);
      const event = logEvent({ sessionId: session.id, type: 'blocker', text: parts.join(' · ') });

      invalidateDashboardCache();
      return jsonResult({ workItemId, stateChange, tags, session, event });
    } catch (e) {
      return errorResult(e instanceof Error ? e.message : String(e));
    }
  },
);

server.registerTool(
  'workitem_unblock',
  {
    title: 'Clear a block on a work item (state + log)',
    description:
      "ONE call to clear a block — use this as the only way to unblock. Transitions the work item back to its prior state in Azure DevOps (captured when workitem_block ran — typically Active, but could be 'Waiting for Testing' or another in-progress state). Removes the 'Blocked' tag, and writes a `decision`-type entry in the item's session log explaining what got unblocked. Opens a session on the item if one isn't already open. Use this even for drive-by unblocks — the log is how Moran sees later that the block went away and why.",
    inputSchema: {
      workItemId: workItemIdSchema,
      summary: z
        .string()
        .min(1)
        .describe("Short plain-English note: what got unblocked / what changed (e.g. 'Yosef merged the NAT EIP retry fix', 'Legal cleared Article 12')."),
    },
  },
  async ({ workItemId, summary }) => {
    try {
      const stateChange = await transitionFromBlocked(workItemId);
      const tags = await updateTags(workItemId, { remove: ['Blocked'] });
      const session = startSession({ workItemId });
      timerService.start(workItemId);

      const restoredNote = stateChange.restored ? '' : ', prior state not captured';
      const event = logEvent({
        sessionId: session.id,
        type: 'decision',
        text: `UNBLOCKED: ${summary} · (now ${stateChange.toState}${restoredNote})`,
      });

      invalidateDashboardCache();
      return jsonResult({ workItemId, stateChange, tags, session, event });
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
/*  Estimation help                                              */
/* ============================================================ */

server.registerTool(
  'estimate_anchor',
  {
    title: 'Anchor an hour estimate on real past actuals',
    description:
      "Pull real estimate-vs-actual data from Moran's closed Azure DevOps tasks so you propose hour estimates anchored to history, not to gut. Call this BEFORE proposing OriginalEstimate for any new task (in task_create or workitem_edit). Returns: (1) siblings — closed tasks under the SAME parent story with their estimate / actual / ratio; (2) calibration — Moran's recent closed tasks across the project with median/average actual-over-estimate ratios. The AI picks the most semantically similar siblings (read titles + types) and uses them as the primary anchor; the calibration ratio is a fallback multiplier when sibling data is sparse. If isColdStart is true (no usable history at all), say so plainly to Moran — propose a labeled gut estimate and ask if it feels right.",
    inputSchema: {
      parentId: z
        .number()
        .int()
        .positive()
        .optional()
        .describe('Parent User Story id (or Feature/Epic if no story above). Sharper sibling anchor with it; without it, only the global calibration ratio comes back.'),
    },
  },
  async ({ parentId }) => {
    try {
      const anchor = await buildEstimateAnchor({ parentId });
      return jsonResult(anchor);
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
