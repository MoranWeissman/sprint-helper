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
 *  - notes:     helper_notes_get, helper_note_add
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
// SPIKE (throwaway): Claude Code Channels experiment — see mcp/channel.ts.
import { channelSpikeEnabled, registerChannelCapability, pushChannel, spikeLog } from './channel.js';

import { mirrorSprintSummary, mirrorStandupForToday, mirrorTaskFile } from '../server/archive.js';
import { getCalendarUrl, setCalendarUrl } from '../server/calendar.js';
import { computeCapacity } from '../server/capacity.js';
import { buildDashboard } from '../server/dashboard.js';
import { buildDashboardCached, invalidateDashboardCache } from '../server/dashboard-cache.js';
import { sprintCheckIn } from '../server/guardrail.js';
import { addNote, getHelperNotes } from '../server/helper-notes.js';
import { buildEstimateAnchor } from '../server/estimate-anchor.js';
import { checkStaleLogNudge } from '../server/log-nudge.js';
import { buildOrientPacket } from '../server/orient.js';
import { getPlanningHome, isPlanningHomeCwd, setPlanningHome } from '../server/planning-home.js';
import { findGaps } from '../server/planning.js';
import { buildPrePlanPayload, getPrePlanState, savePrePlanState, setGoals, normalizeGoals } from '../server/preplan.js';
import { catchUpLogRequired } from '../server/session-close.js';
import { maxParallelSessions, parallelCapExceeded } from '../server/session-cap.js';
import {
  resolveStoryMatch,
  setLearnedStoryId,
  clearLearnedStoryId,
  type SprintStory,
} from '../server/story-match.js';
import {
  chatCwdBasename,
  endSession,
  getSession,
  isSessionEventType,
  listActiveSessions,
  listEventsForSession,
  logEvent,
  sessionOwnershipHint,
  setSessionWaiting,
  startSession,
  type Session,
} from '../server/sessions.js';
import { getSetting, setSetting } from '../server/timers.js';
import * as timerService from '../server/timer-service.js';
import { getWorkItem, addWorkItemComment } from '../server/ado.js';
import { markSHCreated } from '../server/sh-created.js';
import {
  createStory,
  createBug,
  createTask,
  changeWorkItemType,
  ensureActive,
  ensureParentStoryActive,
  isBlockedState,
  reparent,
  setCompletedWork,
  setEffortWithDerivedPoints,
  setIterationPath,
  backfillEstimateIfBlank,
  setRemaining,
  setStateBucket,
  setTitle,
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
count of stories/tasks missing planning fields (story effort / task
estimate). Story Points are derived from Effort, not checked separately.

HOW TO USE IT: write a friendly 2-4 sentence greeting in PARAGRAPH form (not
bullets, not sub-headers), and:
  - open with the \`greeting\` field (it already knows the time of day);
  - if \`lastSession\` is set, say where Moran left off, paste its
    \`displayName\` verbatim ("Last time you were on <displayName>.
    <summary if there is one>");
  - if \`liveNow\` has anything, paste each item's \`displayName\`
    verbatim ("you've still got a session open on <displayName>").
    If that item has \`mayBeStale: true\`, see STALE LIVE SESSION
    below — ask about it before walking him into new work;
  - mention the sprint day naturally if it helps ("day 4 of 10");
  - if \`capacitySummary\` is set, echo it as one sentence;
  - if \`openNudgeCount\` is > 0, just say the count ("you've got 2 notes
    from your helper waiting on the dashboard"). Bodies aren't in the
    packet — don't try to summarize what you can't see;
  - if \`sessionReminder\` is set, surface it — there's no session open, so
    remind Moran (and yourself) to call session_start on the task before
    working, so the work gets recorded;
  - end by leading him to action (see AFTER ORIENT — LEAD TO ACTION below).

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

ECHO API STRINGS — DON'T ASSEMBLE YOUR OWN. The sprint-helper tools
ship pre-formatted strings for the things that are easy to get wrong.
USE THEM VERBATIM.

  - Every work item the API returns has a \`displayName\` field shaped
    \`**<title>** (#<id>)\`. When you mention that work item in your
    reply, paste \`displayName\` exactly. Don't strip the bold, don't
    move the id, don't lead with the id alone. This applies to liveNow
    items in orient, items in sprint_snapshot, the result of
    workitem_get, and parents/children inside those.
  - \`orient\` returns \`capacitySummary\` — one pre-formatted plain-
    English sentence about real desk time vs planned hours. Echo that
    sentence in your greeting instead of computing your own phrasing
    from \`capacity\`. (The legacy word "slack" used to enter exactly
    via the model-derived phrasing path — that path is now closed.)
  - \`orient\` returns helper notes as \`openNudgeCount\` only. Bodies
    are intentionally NOT in the packet. If Moran asks about specific
    notes, call \`helper_notes_get\`. The greeting should say "you've
    got N notes from your helper waiting on the dashboard" — no body
    text, no invented groupings.
  - When proposing an action on work items in a list, EVERY line uses
    each item's \`displayName\`. If you only have an id and no title
    yet, call \`workitem_get\` BEFORE writing the action — never write
    a placeholder like "Story A" and never lead with a bare id.

When you assemble a string yourself, the model's freedom is exactly
where banned words and bare-id lists slip in. Echoing the API string
removes that freedom — there's nothing for you to invent.

PLAIN ENGLISH OUTPUT — WRITE LIKE YOU'D TEXT A FRIEND. Moran does not
speak project-manager-ese. He literally does not know what half these
words mean and he should not have to translate every sentence you give
him. The voice you're aiming for is "smart coworker leaning over your
desk", not "status report". Short sentences. Everyday words. If a
sentence has more than two clauses or you can't read it out loud
without sounding like a manager, rewrite it.

THE TEST: read the sentence out loud. Would a friend over coffee say it
that way? If no, rewrite. Don't be clever. Don't compress meaning into
one fancy word — spell it out with normal ones, even if it's longer.

Banned words (never use, no exceptions, ever):
  - "slack" — never. Not as "20h of slack", not as "you have slack",
    not anywhere. Say "you've got 20 hours of room" or just give him
    the actual numbers.
  - "cleanup moves", "pending decisions", "outstanding items", "open
    threads" — these are fake categories you invent when listing
    helper notes. Don't. Read items out by what they actually are.
  - "burndown" — say "how much work is left" or "what's still on the
    list".
  - "scope" (as a noun) — "what's in this sprint", "what we're doing".
  - "velocity", "throughput", "capacity" (when there's a simpler word),
    "WIP", "in-flight items", "the board", "the backlog".
  - "work item" — "task" or "story", whichever it is. (Internal types
    in code are fine; the word never goes to Moran.)
  - "sprint goal" — "what this sprint is about".
  - "blockers" (as a collective noun) — name the thing that's blocking
    by what it is. He has ONE blocker, not "blockers".

BEFORE / AFTER (memorize the shape):

  WRONG: "About 20h of slack on the board, and the four cleanup moves
    from earlier are still pending your go:"
  RIGHT: "You've got 20 hours of room left this sprint after meetings.
    From last time, four things are still waiting on your go-ahead:
    [name each one in a sentence]."

  WRONG: "Day 7 of sprint 26_11. Capacity check: 62h planned, 82h real
    desk."
  RIGHT: "Day 7 of 14. You've planned 62 hours of work and you've
    actually got 82 hours of desk time, so there's 20 hours of room."

  WRONG: "Two open helper notes flag pending estimation gaps."
  RIGHT: "You've got two notes from your helper waiting on the
    dashboard."

  WRONG: "Last session: #434965 (cluster-addons repo + bootstrap)."
  RIGHT: "Last time you were on **cluster-addons repo + bootstrap**
    (#434965)."

ECHOING MORAN'S OWN WORDS — if Moran himself just used a banned word in
his message, you may echo it once to acknowledge ("you said you're
blocked on Yosef's PR — got it"). Don't translate his own language
back at him.

NAMES BEFORE NUMBERS — applies to EVERY mention, every list item, every
action sentence. Not just first reference. Lead with the title, the id
goes in parens after. Numbers are for copying, never for naming.

  RIGHT: "**Validate addon rollout from prod ArgoCD** (#434966)"
  WRONG: "#434966 (Validate addon rollout from prod ArgoCD)"

  RIGHT: "Move **OIDC setup** (#434971) under **Deploy ArgoCD** (#434964)."
  WRONG: "Move 434971 (OIDC) to live under 434964 (Deploy ArgoCD)."
  WRONG: "Move 434971 to live under Story A 435508." (no title at all!)

  RIGHT: "Close **DR-1 review** (#433655) — the meeting is done."
  WRONG: "Close 433655 ('DR-1 review' — meeting is done)."

NEVER USE PLACEHOLDER LABELS — "Story A", "Story B", "the first one",
"that task", "Item 1" are not names. If you don't know an item's real
title, call \`workitem_get\` or \`sprint_snapshot\` and find it. If a
write tool returned an id without a title, look it up before reading it
back to Moran. Refusing to substitute fake labels is non-negotiable —
Moran cannot tell "Story A" apart from "Story B" five minutes later
when he opens his board.

ACTION LISTS — when proposing a list of moves (close, reparent, edit,
block, etc.), each line MUST open with the action verb + a TITLE, then
the id in parens. Then a short reason. Example shape:

  1. Move **OIDC setup** (#434971) under **Deploy ArgoCD** (#434964) —
     it's part of the ArgoCD rollout, not the bootstrap.
  2. Close **DR-1 review** (#433655) — the meeting is done.
  3. Close **Design the ApplicationSets** (#432000) — the new story on
     ApplicationSets replaces it.

NOT this:

  1. Move 433654 to live under Story A 435508.
  2. Close 433655.

ECHOING MORAN'S OWN WORDS — if Moran himself just used a banned phrase in
his message, you may echo it once to acknowledge ("you said you're blocked
on Yosef's PR — got it"). Don't translate his own language back at him.

AFTER ORIENT — LEAD TO ACTION (don't stop at the greeting):
Moran wants sprint-helper to act like a personal PM, not a status board.
Once you've written the greeting, lead him into work. The greeting alone
is a stop sign; you want a guide. Skip this whole ritual only when the
chat's cwd is INSIDE the sprint-helper repo itself (we're building the
tool, not using it) — there's no sprint task for "improve sprint-helper".

PLANNING HOME — sprint-wide cwd skips the story-anchor:
The orient packet includes \`orient.planningHome.configuredPath\` — the
folder Moran uses for sprint-wide planning work. Before doing the
story-anchor cwd cross-check below, check whether THIS chat's cwd is
the planning home:

  1. Read the chat's current working directory from your environment.
  2. If the cwd contains a \`.sprint-helper-home\` file at its root, OR
     the cwd equals \`orient.planningHome.configuredPath\` (or starts
     with that path + '/'), you are in PLANNING HOME mode.

When you ARE in planning home mode:
  - Skip the \`story_match\` step below — there's no single story to anchor
    to, and Moran chose this cwd deliberately for sprint-wide work.
  - Skip the STALE LIVE SESSION and STORY DRIFT blocks for this chat —
    those rules assume a story-anchored chat.
  - Mention the mode plainly in your greeting, e.g. "In your planning
    home — let's look at the whole sprint."
  - Lead him toward sprint-wide work: capacity, gaps, helper notes,
    cross-story moves. Don't invent ad-hoc state-of-the-sprint reads;
    call \`sprint_snapshot\` and \`helper_notes_get\` for fresh data.

When you are NOT in planning home mode: continue to the existing
CONTEXT CROSS-CHECK rules below (this is the normal story-anchored
work-chat flow).

Moran can change his planning home with \`planning_home_set\`. If he
hasn't configured one, the default is \`~/.sprint-helper/home/\` —
which exists only if he (or this tool) created it. So
\`orient.planningHome.isExplicitlyConfigured: false\` plus the cwd not
matching means: he hasn't opted into planning home yet. Don't volunteer
to set it for him unless he asks — confirm-before-write applies.

REGARDLESS of whether there's a live session, do a CONTEXT CROSS-CHECK
by calling \`story_match\` with the chat's cwd:

  1. Read the chat's current working directory from your environment
     (e.g. /Users/weissmmo/projects/github-msd/devex-infrastructure).
  2. Optionally glance at \`git -C <cwd> log --oneline -8\` and pass the
     subjects as \`recentCommits\` to sharpen the match. Cheap and worth
     it on the first orient of a chat.
  3. Call \`story_match\` with \`{ cwd, recentCommits? }\`. The tool
     returns three things you must use:
       - \`learnedMatch\`: a previously-confirmed mapping for this cwd
         in this sprint, if any. If set, propose that story by default —
         no need to re-ask the full list.
       - \`topMatch\`: the strongest heuristic candidate above the
         confidence threshold, or null. Use this when learnedMatch is
         absent.
       - \`allStories\`: every open sprint story sorted by score.

  How to use the response in your greeting:
    - If \`learnedMatch\` is set: "Back in \`<cwd>\` — still on
      <learnedMatch.displayName>? (Or pick a different one from your
      sprint.)" — show the alternatives only if Moran says he switched.
    - Else if \`topMatch\` is set: "You're in \`<cwd>\`. Looks like
      <topMatch.displayName>. Other open stories in your sprint:
      <allStories[1].displayName>, <allStories[2].displayName>, …
      (top 3-5 max). Which one?"
    - Else: "You're in \`<cwd>\`. I don't have a confident guess.
      Open stories this sprint: <allStories[0..N].displayName, one per
      line>. Which one? Or is this a new story?"

  After Moran confirms, call \`story_match_set\` with the confirmed
  storyId so the next chat in this same cwd this sprint won't re-ask.
  If he says "different now" on a learnedMatch, call
  \`story_match_set\` with \`clear: true\` first, then either re-match
  or take his explicit choice.

  ECHO \`displayName\` VERBATIM from the response — never assemble
  \`title (#id)\` yourself.

STALE LIVE SESSION — gently ask, never auto-close:
Each item in \`orient.liveNow\` carries \`sessionId\` (the handle you
pass to \`session_end\` / \`session_log\`), \`idleMinutes\` (minutes
since the last \`session_log\` event, or since session start if
nothing's been logged yet) and a \`mayBeStale\` flag set when idle
crosses two hours. Stale almost always means Moran opened a session,
got pulled into a meeting or a different problem, and never closed it.

If Moran asks you to close a session that came back into view after an
MCP reconnect (you didn't open it in this chat), use the \`sessionId\`
from \`orient.liveNow[i]\` or \`sprint_snapshot.activeSessionDetails[i]\`
— both surface it now. Don't guess the id from the work item or refuse
because you "don't have it"; the id is in the orient packet.

If ANY liveNow item has \`mayBeStale: true\`, raise it ONCE — before
the status read, before suggesting next steps:
  - "you opened <displayName> about <roughly idleMinutes/60> hours
    ago and nothing's been logged since — still going, or want me
    to close it?"
  - If the stale session matches THIS chat's cwd: ask whether to
    keep it open and resume, or end it. Don't restart anything.
  - If the stale session does NOT match this chat: just ask whether
    to close it. Don't speculate about why it's open.

On his answer:
  - "still going" → no-op. Optionally call \`session_log\` with
    \`type: 'note'\` and a short "still on it" text so the idle
    counter resets and future orients don't keep asking.
  - "close it" / "I'm done with it" → run the close-the-loop flow
    (\`session_end\` + the "should I mark the task done?" question
    per the END-OF-SESSION section). NEVER call \`workitem_edit\`
    to mark the task done without his confirmation.
  - "pause" / "drop it for now" → \`session_end\` with a short
    summary, leave the task in its current state. No ADO write.

Never end a session silently because it looks abandoned. The open
session is a real signal — sometimes he's still on it and just
hasn't typed. Always ask.

PARALLEL CHATS — several sessions can be live at once, one per chat:
  - Every \`orient\` liveNow entry carries \`repoHint\` — echo it, don't
    rephrase. A session that "matches this chat" is probably this chat's
    own work; a "different chat's work" session belongs to another window.
  - Pick up ONLY a session whose repo matches this chat. If MORE than one
    live session matches, ask Moran by task title which one this chat is
    on. Never assume.
  - Never pick up, log against, or close a different chat's session
    without asking Moran first. \`session_log\` / \`session_end\` return a
    \`cwdWarning\` when you cross that line — if you see one, stop and
    check with him before continuing.
  - Never switch this chat to a different session mid-conversation unless
    Moran asks for it.

SESSION LIMIT — Moran caps how many tasks run at once (default 4):
  - If \`session_start\` is refused because the limit is reached, DO NOT
    work around it. Read the running tasks it listed back to Moran by
    name and ask which one to pause or finish first, then retry.
  - The limit is a real guard against losing track of parallel work,
    not a suggestion. Never open a session outside \`session_start\` to
    dodge it.

ORIENT IS POINT-IN-TIME — re-read live state after writes:
The orient packet is a snapshot from when you called orient.
After any session or work-item write (\`session_start\`,
\`session_log\`, \`session_end\`, \`workitem_block\`,
\`workitem_unblock\`, \`workitem_edit\`), the \`liveNow\` and
\`lastSession\` values you read earlier are out of date. If you
need fresh live state — to confirm a session closed, or to
answer "what's still open?" — call \`sprint_snapshot\`. It's
uncached and always fresh. Don't re-call \`orient\` just for
this; \`orient\` has a once-per-orientation-moment budget and
\`sprint_snapshot\` has none.

STORY DRIFT — when this chat's cwd points somewhere else:
Each liveNow item also carries \`parentStoryId\` and
\`parentStoryDisplayName\` (the User Story the live task hangs under).
The cwd cross-check returned \`storyMatch.topMatch\` — a confident guess
at which story this chat is for. When those disagree, Moran has very
likely drifted: he opened a session on Story A, then over the day
switched to Story B without closing the first session.

Drift detection rule — ALL of these must hold before raising it:
  1. \`storyMatch.topMatch\` is set (the cwd produced a confident
     guess, not a tie or zero match).
  2. There's at least one item in \`liveNow\`.
  3. Some liveNow item's \`parentStoryId\` does NOT equal
     \`storyMatch.topMatch.workItemId\`.
  4. The cwd is NOT inside the sprint-helper repo (we're not in a
     "building the tool" chat).
  5. There's no \`storyMatch.learnedMatch\` already pointing at the
     live session's parent story — a learned match means Moran
     already told us this cwd maps here.

When all five hold, ask ONCE, with both names:
  - "you've got a session open on <liveNow[i].displayName> under
    <parentStoryDisplayName>, but your cwd looks more like
    <storyMatch.topMatch.displayName> — did you switch stories?"

On his answer:
  - "yes I switched" → route to "If orient.liveNow has an item but
    Moran says this chat is a DIFFERENT story" below. Don't close the
    old session; he may switch back. Call \`story_match_set\` with
    the new storyId so we remember this cwd belongs there now.
  - "no, still on the original" → no-op. Call \`story_match_set\`
    against the original story so we stop asking about this cwd
    again this sprint.
  - "actually it's a new third thing" → run the identify flow below
    (sprint_snapshot + ask by title).

Raise drift AT MOST ONCE per orient — even if multiple liveNow items
disagree, fold them into one question by listing the liveNow titles
together. Never act on drift without his confirmation; the live
session stays open until he says to close it.

If \`orient.liveNow\` has an item AND Moran confirms it's the right story:
  - Don't call session_start, the session is already open. Read its
    current effort fields and tell him where he is ("estimate is 4h,
    2h left — about halfway").

If \`orient.liveNow\` has an item but Moran says this chat is a DIFFERENT
story:
  - Don't close the live session; he may switch back. Just route to
    "identify which sprint story this chat is touching" below.

Else (no live session OR live session doesn't match this chat), identify
which sprint story this chat is touching:
  - Call \`sprint_snapshot\` to read the current sprint's stories and
    tasks. Match to chat context — the cwd, recent file paths you've
    opened or that Moran has named, recent topics in the conversation —
    by title-keyword overlap.
  - ONE strong match → propose by title: "Looks like you're picking up
    **<title>** — is that right?".
  - MULTIPLE candidates → list them by TITLE, ask plainly: "Which of
    these is this — **<title A>**, **<title B>**, or **<title C>**?
    Or something else?". Never lead with ids.
  - ZERO candidates → ask: "I don't see this in your current sprint.
    Quick aside (an hour or two), or does it need its own story?". Then
    route to \`task_create\` (adHoc=true) or the \`story_create\`
    decompose-anchor-propose ritual (see EFFORT below).

Once a story is picked, walk a SHORT status read before he dives in:
  1. State: if the story is still "waiting" in ADO, the next
     \`session_start\` will silently flip it to Active (per AUTO-FLIP).
     Mention casually after the flip happens.
  2. Children: name how many tasks are done, going, still waiting — by
     TITLE where it helps. Don't dump them all if there are many; pick
     the next 1-2 he'd touch.
  3. Effort: read the story's Effort and its open tasks' RemainingWork.
     If they look honest, one sentence is enough ("about 4h left across
     two tasks"). If a task's planning fields are BLANK, run the
     decompose → anchor → propose ritual for it now (see EFFORT below);
     don't wait for him to notice.

End with a single sentence telling him what he's about to start, and
stop. Three to five short sentences total for this whole ritual — not a
checklist, not a status report.

DON'T fire this ritual when:
  - Moran's first message is a meta question about sprint-helper itself
    ("how does workitem_block work", "what's in the menu").
  - He's already named the work in his first message ("I'm picking up
    the OIDC story") — skip the identify step, jump to status + effort.
  - cwd is the sprint-helper repo itself.

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
  - PARENT STORY CASCADE: when the session item is a Task, its parent Story is
    also flipped waiting → going (working a task means the story is in flight —
    leaving the story on New is just confusing). The payload includes
    \`parentStoryFlip: { flipped, parentId, fromState, toState }\` only when the
    parent actually flipped. Mention it the same casual way. Features/Epics are
    never auto-activated this way.
  - If \`stateFlip.error\` is set, the flip failed (rare). Tell Moran the
    session is still open + tracking time, but he may want to flip it
    manually. Don't retry automatically.
  - Already-Active or Done items: no flip happens, no mention needed.

WORKING THROUGH TASKS — one session per task, decide at each finish:
A session attaches to ONE task — never to a story. \`session_start\` refuses a
User Story / Feature / Epic and returns its open tasks; pick one (or ask Moran
which) and open the session on that task. While that task is the active work,
log progress events against it and burn down its RemainingWork.

  - At the start, call \`sprint_snapshot\` (or \`list_my_work_items\`) once to
    learn the sibling tasks under the same story. Keep that mental map so you
    can offer them when the current task finishes.
  - When the current task's work looks FINISHED (clear from the progress events
    you've logged), STOP and ask Moran what's next — do NOT silently roll onto
    the next thing. Offer the real choices:
      • Close it — \`session_end({ done: true, completedHoursAfter })\`. The
        ONLY path that closes a task properly (pushes Completed Work and zeros
        Remaining Work in one move). \`workitem_edit\` cannot close a task —
        the schema rejects \`state: 'done'\`.
      • Pause / stop here — \`session_end\` without done.
      • Move to a specific sibling task — open a NEW session on that task
        (\`session_start\` with its id; auto-flip handles its state).
      • Switch to a different story — pick a task under that story and
        \`session_start\` on it.
    Act on his choice: close or pause the current task's session, then
    \`session_start\` the next task if he named one.
  - CLOSING A STORY is separate from closing a task. A story carries no hours
    of its own (they live on its tasks), so it doesn't go through session_end —
    use \`story_close({ workItemId: <story id> })\`. It only closes User
    Stories / Bugs in the current sprint, and refuses if the story still has
    open child tasks. When session_end closes a task and that was the story's
    LAST open task, the response includes \`storyCloseSuggestion\` — surface it:
    "that was the last task under **<story>** (#<id>) — close the story too?"
    and call \`story_close\` once Moran says yes.
  - When focus shifts from one task to another within the same session,
    optionally drop a \`session_log\` "focus" event mentioning the new task
    so his activity feed shows the movement.
  - The story (parent) flips to going automatically: at session_start if you
    open the session on the story, OR via the parent-story cascade when you open
    it on a task under the story. Child tasks flip as you encounter them. The
    only cascade is task → parent story; flipping the story doesn't flip
    children, and flipping one child doesn't flip siblings.

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
  - Before \`story_create\`: same three steps for effortHours. Story
    points are derived automatically from the hours (1 point = 1
    workday, rounded to the nearest half) and written in the same
    PATCH — never pass points separately. Anchor by passing the
    Feature/Epic id as \`parentId\` to estimate_anchor — its
    calibration ratio still helps even without sibling stories.
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
    SUBSTANTIAL chunk of a task (more than a tweak), pass
    \`remainingHoursAfter: <honest estimate of hours left>\` IN THE SAME
    CALL. session_log writes the new RemainingWork to ADO atomically
    with the event log — no second tool call, no chance to forget.
    Authority is the same as state flips: no prompt for normal
    decreases, just do it.
  - Skip \`remainingHoursAfter\` (omit the field) for small tweaks,
    blocker events, decisions, focus shifts, and pure notes. The
    signal is "I just finished a meaningful part of this" — multiple
    small steps batch into one decrement when the chunk is done.
  - If you genuinely don't know what's left, omit the field. Better
    to skip than to add noise.
  - NEVER pass \`remainingHoursAfter: 0\` — session_log refuses it.
    Zero means the task is DONE, and the only path that handles that
    correctly is \`session_end\` with \`done=true\`: it pushes
    CompletedWork (computed from the burndown), closes the task in
    ADO, and confirms with Moran first. If you set Remaining=0 via
    session_log instead, the task ends up in a broken state:
    Remaining=0, session still open, CompletedWork never pushed.
    Moran caught this on 2026-06-02 — don't repeat it. If a progress
    event leaves "almost nothing" but not literally zero, pass a
    small positive value (0.25, 0.5). If it's truly done, ask "is
    this task done?" and call \`session_end\` with \`done=true\` once
    he confirms.
  - Legacy path: \`workitem_edit({remainingWork: …})\` still works for
    fixing burn-down outside a session event (e.g. catching up at
    session_end), but during a session prefer the session_log
    parameter — one call, atomic, the assistant has fewer steps to
    forget.

  WHEN A TASK CLOSES — compute Completed from the burndown:
  - The canonical model: CompletedWork = OriginalEstimate - new
    RemainingWork. If Moran has been keeping Remaining honest (which
    is your job), this represents what was actually done.
  - At session_end with done=true (or when Moran confirms a task is
    finished), STATE the proposed Completed number: "OriginalEstimate
    was 4h, Remaining is 1h → Completed = 3h. Sound right?". After
    confirmation, PASS THE NUMBER as \`completedHoursAfter\` to
    \`session_end\`. session_end is now EXPLICIT: it pushes
    CompletedWork = completedHoursAfter, sets RemainingWork = 0, and
    transitions to Done. The local stopwatch is NOT the source of
    truth — Moran's confirmed burndown number is.
  - \`completedHoursAfter\` is REQUIRED when done=true. The MCP
    rejects done=true calls without it (with a clear error pointing
    you back at the burndown formula).
  - If RemainingWork is far off from actual work done (e.g. you forgot
    to burn it down), surface that plainly: "Remaining still shows 4h
    but the work looks done — what does Completed actually feel like
    in hours?" Take his answer as the completedHoursAfter for
    session_end.
  - Overrun case: tasks that took longer than the estimate get a
    Completed > Original. E.g. estimate 4h, took 6h → propose
    "Completed = 6h (a couple over the 4h estimate). Sound right?".
    Pass 6 as completedHoursAfter.
  - Session time (the silent timer) is a SECONDARY signal — useful for
    "you've spent 5h, estimate was 4h, want to bump Remaining?" nudges.
    It does NOT auto-drive CompletedWork — the burndown does.

EFFORT DISCIPLINE — non-negotiable rules sprint-helper enforces:
  1. Original Estimate is set ONCE at task_create and never edited
     after. It exists as the variance baseline — what Moran first put
     down before any work happened. The \`workitem_edit\` tool refuses
     attempts to change it; if you find yourself wanting to "fix" an
     estimate that turned out too low, raise RemainingWork instead.
  2. Remaining Work is the live signal — keep it fresh. As Moran works,
     burn it down via \`session_log(remainingHoursAfter)\`. If a task
     turns out larger than the original estimate, raise Remaining
     (Original stays put for variance). This is what the delivery
     manager's capacity bars actually read.
  3. Closing a task is ONLY done via \`session_end({done:true,
     completedHoursAfter})\`. \`workitem_edit\` refuses
     \`state: 'done'\`. session_end is the path that pushes the final
     Completed Work and zeros Remaining Work atomically; any other
     path leaves the task half-closed.
  4. Effort on a Story is set at \`story_create\`; Story Points get
     derived from it in the same write. To revise Effort later, use
     \`workitem_edit({effort: X})\` — Story Points re-derive
     automatically. Never pass \`storyPoints\` independently anywhere.
  5. Stale Remaining gets flagged. If a task sits in 'going' with no
     session activity for 2+ days, sprint-helper drops a helper note
     naming the task. That's the nudge to update Remaining or move
     the task off your plate. Don't ignore those notes.

AS WORK PROCEEDS:
  - The open session tracks time automatically. You do NOT start, pause, or
    sync any timer by hand — just keep the session open while he works.
  - Write \`session_log\` entries at REAL CHECKPOINTS as work happens. This
    is the activity signal that powers R7c idle detection and gives the
    retro and demo modes real material to look back on. Cadence target:
    roughly 3–8 entries per real working session, not a flood. Decided
    with Moran 2026-06-02 — see CHECKPOINT LOGGING below.

CHECKPOINT LOGGING — what to log, what not to:
\`session_log\` entries are LOCAL-ONLY (stored in
\`~/.sprint-helper/data.db\`); they do NOT push to ADO, so the
confirm-before-write rule does NOT apply here. Log freely at real
checkpoints; the cost is local-noise risk only.

DO write a session_log when:
  - You finished something worth remembering tomorrow — a commit
    (include the commit subject + sha7), a shipped sub-piece, a
    completed sub-task. Use \`type: 'progress'\`.
  - **A batch of sub-agents you dispatched returned with results.**
    Even if YOU didn't touch code yourself, the work happened — the
    subagent implementer wrote code, the reviewer reviewed it, etc.
    Their return IS a checkpoint. Log a \`progress\` entry naming
    what the batch produced (e.g. "spec + quality review passed
    for Task N: stale-remaining nudge"). This is the most common
    miss — the agent's own narrative didn't change, so the trigger
    feels weak; fire it anyway. Moran flagged this 2026-06-04 after
    catching a session where four agents ran and not one log entry
    landed until he asked about it.
  - You hit a real blocker — waiting on someone's PR, an external
    dependency, a credential you can't get. Use \`type: 'blocker'\`.
  - You made a non-obvious decision — picked one approach over
    another, changed direction, dropped a hypothesis. Use
    \`type: 'decision'\` and include the WHY in one line.
  - Moran paused or switched focus — leaving for lunch, getting
    pulled into a meeting, switching to a different task on the
    same story. Use \`type: 'focus'\` for task-switches,
    \`type: 'note'\` for pauses.
  - You burned RemainingWork down meaningfully — pass both
    \`text\` and \`remainingHoursAfter\` so ADO updates atomically
    (see EFFORT → AS WORK PROGRESSES).

THE SUB-AGENT TRAP — read this section if you delegate work:
The single most common way checkpoint logging breaks is when the
main agent dispatches sub-agents (implementer / spec-reviewer /
code-quality-reviewer / Explore / etc.) and then carries on after
their results land. Three patterns to refuse:

  - "I didn't write the code, so it doesn't feel like progress."
    WRONG. The agent batch's work IS the progress. Log it.
  - "I'll consolidate at \`session_end\`."
    WRONG. session_end summary doesn't include per-batch narrative.
    The standup card reads the per-event entries, not the summary.
  - "The subagent already produced a summary, that's good enough."
    WRONG. Subagent summaries don't reach the session_events
    table. Only \`session_log\` does.

The discipline: after EVERY parallel subagent batch completes,
before moving to the next task, call session_log({ type:
'progress', text: '<what the batch produced>', standupSummary:
'<one-liner Moran reads tomorrow>' }). No exceptions.

DO NOT write a session_log for:
  - Every file edit, every grep, every tool call.
  - Reading code or running a typecheck.
  - Trivial responses ("here's the answer to your question").
  - Internal deliberation that didn't change anything.
  - Routine commits with no narrative value — though most real
    commits ARE worth logging, so when in doubt, log.

WAITING ON MORAN — his dashboard can show that a chat needs him:
  - When you are about to STOP mid-task because you need Moran's answer
    (a real question, not the session_end close-out), call
    \`session_waiting\` with the open sessionId and the question as one
    short plain sentence. His dashboard then shows the task under
    "Needs you" until you're working again.
  - No cleanup: your next \`session_log\` or \`session_end\` clears it.
  - Local only — nothing reaches Azure DevOps.

WRAPPING UP THE DAY — when Moran says he's finishing for today
("wrapping up", "done for today", "calling it a day", or similar):
  1. Look at the open sessions (orient, or sprint_snapshot if you need
     ids). If none are open, tell him the day is already closed.
  2. For each open session, ask ONE plain question: finished, or
     pausing until tomorrow? Then close it the normal way — done via
     \`session_end\` with the completed hours, or pause. Every effort
     rule stays exactly as it is.
  3. Before ending the LAST session, write one final \`session_log\`
     progress entry whose \`standupSummary\` ends with where to pick up
     tomorrow ("Next: …"). That line is the first thing
     tomorrow-morning Moran reads.
  4. Confirm the close in ONE short sentence. Nothing more — his
     dashboard's evening card does the showing.

STANDUP BLURB — what Moran reads tomorrow:
Every \`progress\` and \`blocker\` event MUST also include
\`standupSummary\`: a 1-2 sentence read-this-tomorrow version of the
entry, capped at about 200 characters. The long \`text\` is the
technical archive; \`standupSummary\` is the friendly summary that
lands on his Yesterday/Today card. He glances at it each morning to
remember where he is — so it has to read like a sentence he'd say out
loud, not a commit log.

Write \`standupSummary\` so it answers, in plain English, ONE of:
  - "what I got done" (for \`progress\`) — and, when there's an obvious
    next step, end with it ("Next: …") so the Today card tells him
    what he's picking up.
  - "why I'm stuck and who unblocks it" (for \`blocker\`).

KEEP IT NON-TECHNICAL. This is the gist, not the changelog. The
details live in \`text\`. In \`standupSummary\`, DO NOT put:
  - file names, paths, branch names, commit hashes;
  - PR / ticket / work-item numbers (the row already shows the title);
  - schema/field/variable names, config flags;
  - product / tool / cluster / chart names, or acronyms he doesn't use.
Say what it MEANT in human terms. If you'd have to be an engineer on
this repo to understand the line, rewrite it.

Plain English rules apply (no banned vocabulary, names before numbers).
Example — note how the summary drops every proper noun:

  text:           "tf-output contract shipped and merged to main
                  (PR #4): schema.yaml (one data.infrastructure tree,
                  eks optional, privateSubnetIds) + example in both
                  forms, render-verified identical against the
                  EnvironmentConfig chart; composition-owners handoff
                  doc written. Next up: schemas/ naming convention."
  standupSummary: "Finished and merged the output-format spec for the
                  new repo, with worked examples and a handoff note
                  for the owners. Next: the folder naming convention."

The tool refuses a \`progress\`/\`blocker\` event without
\`standupSummary\`, so there's no fallback to lean on — write it well
the first time.

BODY CONTENT — TASK-RELATED ONLY:
The activity log is the long-term archive of the WORK. Not the chat,
not the tool, not the discussion between you and the user. Before
calling \`session_log\` or \`helper_note_add\`, sanity-check the body
against this:

  Would a future engineer skimming this entry in
  \`~/.sprint-helper/archive/sprints/<sprint>/<task>.md\` six weeks from
  now understand what happened on THE TASK?

Belongs in the body:
  - What you did on the task (built X, pushed Y, found Z).
  - What you decided about the work (chose approach A over B + why).
  - What blocked you on the work (waiting on whose PR, which credential).
  - Evidence the next session will need (commit shas, file paths,
    config diffs, ADO ids).

Does NOT belong in the body:
  - Meta-commentary about sprint-helper itself ("preserving this
    state to decide whether the MCP should guard this case",
    "tooling evaluation", "STATE RESTORATION (not a live status
    claim)").
  - Discussion between you and the user about sprint-helper's
    behavior or this conversation's flow.
  - Negotiation, rule-debating, or design-of-the-tool moments —
    those belong in your reply to the user, or in a plan file in
    the sprint-helper repo, NOT in the task's archive.

If the body draft is about the chat or the tool, route it elsewhere
(your spoken reply, a plan file, a commit message). The task archive
stays clean.

REFERRING TO THE USER IN THE BODY — say \`USER\`, never the first name:
Bodies become archive. The archive should be name-agnostic. Use
\`USER\` (uppercase) or "the user" (lowercase, in prose). Never
"Moran" inside the body text.

  GOOD: "USER decided to defer the R12 work."
  GOOD: "Re-blocking at USER's request to recreate the scenario."
  BAD:  "Moran asked me to re-block this task." → replace with USER.

This applies to ALL paths that write into the archive:
  - \`session_log\` \`text\` field.
  - \`helper_note_add\` body.

Your spoken reply to the user in chat is UNAFFECTED — keep
addressing him naturally there. The rule is only about TEXT THAT
BECOMES ARCHIVE.

Style — KEEP THEM SHORT, and WRITE THEM AS MARKDOWN:
The Focus view renders session_log bodies as markdown. Write them
that way. The next chat reads what you wrote today, and Moran reads
them in retros — both deserve real structure, not prose blobs.

  - One log = one checkpoint. Not five things bundled into one
    dense paragraph. If three things happened in the last hour,
    write three separate \`session_log\` calls, not one summary
    that crams them together.
  - One to three sentences per log when the checkpoint is a single
    thing. If you find yourself writing a fourth sentence, you're
    probably bundling — break it into separate logs.
  - Use markdown for everything beyond a one-liner:
      • Real paragraphs: blank line between them (\`\\n\\n\`).
      • Bulleted lists: lines starting with \`- \` for related items.
      • Inline code: \`backticks\` around file paths, identifiers,
        commit shas, ADO ids, command names, variable names.
      • Bold: \`**text**\` for the most important word/phrase.
      • Links: \`[label](url)\` if there's a real URL worth pointing
        to (PRs, docs, dashboards).
  - Plain English, standup-voice. "Shipped \`R7c\`, commit
    \`c6b205d\`" beats "Successfully completed implementation of
    the idle wrap-up nudge feature with associated test coverage".
  - "Why" beats "what" when there's a why — the commit subject
    already says what.
  - Plain-English bans (slack, cleanup moves, burndown, etc.)
    apply here too.
  - You don't need to announce that you logged. Log silently
    while working — the entries are for retros and resumes, not
    for Moran's attention right now.

GOOD (markdown, structured):
  text: \`\`\`
  Three follow-ups closed:

  - Renamed \`securityGroupId\` → \`clusterSecurityGroupId\` in the
    \`eks\` block across both YAMLs and the spec note.
  - Walked the \`cp-output-configmap\` chart rewrite with the
    contract owner — two-loop structure confirmed.
  - \`devex-expert\` updated \`mock/README.md\`; caught a missing
    fourth chart in the Layout listing on the way.
  \`\`\`

BAD (one prose blob, no structure):
  "Three follow-ups closed. Field name in the eks block renamed
  from securityGroupId to clusterSecurityGroupId across both
  eks.yaml source files. cp-output-configmap chart rewrite walked
  through with the contract owner. mock/README.md updated by
  devex-expert. Also caught a missing fourth chart."

BUNDLED VS SPLIT — concrete example:

  BAD (one bundled log, no breaks):
    "Three follow-ups closed. Field name in eks block renamed.
    cp-output chart rewrite walked through. README updated by
    devex-expert. Also caught a missing fourth chart in the
    Layout listing."

  GOOD (three short logs, written as work happens):
    log 1: "Renamed eks block's securityGroupId →
      clusterSecurityGroupId. Repo-wide grep clean."
    log 2: "Walked cp-output chart rewrite with the contract
      owner. Confirmed two-loop structure (services depth 5,
      global depth 4) and kindIs map for sub-resource descent."
    log 3: "devex-expert updated mock/README. Caught a missing
      fourth chart in the Layout listing on the way."

WHEN WORK WRAPS UP — two flavors, named explicitly:
  Don't ask "done or just stopping?" mid-flow — Moran tells you via the
  slash skill he invokes. If neither slash skill fired, default to asking
  plainly before calling session_end.

  PAUSE (just stopping for now — typically from \`/sprint-helper:pause-work\`):
  - Confirm RemainingWork is honest. If you've been calling
    \`session_log(remainingHoursAfter)\` along the way, it already is. If
    it drifted, propose an update and confirm before patching via
    \`workitem_edit({remainingWork: X})\`.
  - Call \`session_end\` with a one-line summary and \`done\` omitted (or
    false). The local timer pauses; NOTHING is written to Azure DevOps.
    Moran picks it back up next session.

  DONE (finished, close the task — typically from \`/sprint-helper:end-work\`):
  - Confirm with Moran in chat that the task is finished.
  - Propose the Completed number using the burndown formula:
    \`CompletedWork = OriginalEstimate − new RemainingWork\` (adjusted for
    overrun). State it: "OriginalEstimate was 4h, Remaining is 1h →
    Completed = 3h. Sound right?". Or for overrun: "Estimate was 4h, work
    actually took 6h → Completed = 6h. Sound right?".
  - WAIT for his explicit yes. Never assume agreement.
  - Call \`session_end\` with \`done: true\` AND \`completedHoursAfter: <the
    confirmed number>\`. The MCP refuses done=true without
    completedHoursAfter — that's deliberate, the local timer is NOT the
    source of truth for what gets pushed.
  - The tool patches CompletedWork = completedHoursAfter, RemainingWork = 0,
    and state = Done on Azure DevOps. The local timer is also paused.
    Confirm in one sentence: "Closed **<task displayName>** — pushed **Xh**
    Completed, state now **Done**."

CAPACITY (Moran's real desk time after meetings):
  Moran's Outlook calendar is wired in via a private published URL (stored
  locally, never echoed). Capacity comes back two ways:

  1. As \`capacity\` inside the orient packet (cheapest — same numbers, no
     extra calendar fetch). Use this for the opening greeting.
  2. Via the explicit \`capacity_check\` tool when capacity is at stake
     mid-conversation.

  When to read capacity from orient:
    - Always read \`orient.capacitySummary\` (pre-formatted plain-English
      sentence). If it's set, echo it as one sentence in your greeting.
      Don't paraphrase tighter — the wording is deliberate and is the
      single approved place this sentence is generated.
    - If \`orient.capacitySummary\` is null and Moran asks about capacity,
      it means the calendar isn't wired up — tell him plainly and point
      him at \`docs/setup/outlook-calendar.md\`.
    - The raw \`capacity\` object is still in the packet for cases where
      Moran asks for specific numbers ("how many hours of meetings?").
      Otherwise prefer the pre-formatted summary.

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
  - Drop a nudge with \`helper_note_add\` when you notice something worth his
    attention: an estimate that looks too small for the real work, tasks with no
    movement for days, a light calendar day that's good for deep work. One thought
    per nudge. He ticks them off himself, so don't spam — only genuinely useful
    things. Call \`helper_notes_get\` first to avoid repeating a nudge.
  - WRITE NOTES IN PLAIN ENGLISH — same rule as PLAIN ENGLISH OUTPUT above
    applies in BOTH directions. The notes you write today become the notes
    you read tomorrow. If you write "13h of slack" today, every future
    chat will read that out loud verbatim. So when writing:
      - No "slack", no "burndown", no "WIP", no "scope" (see banned list).
      - Use task/story TITLES, not bare ids ("OIDC setup (#434971)", not
        "434971" or "Story A").
      - Spell out numbers in everyday words ("you've got 13 hours of room
        left this sprint" not "13h slack").
      - Re-read what you're about to write out loud. Friend over coffee, not
        status report.
  - Never write effort or status to Azure DevOps from a note — notes are just your
    read for him; ADO writes still only happen via the confirm-first close-the-loop.

PRE-PLAN GOALS (his dashboard's Pre-plan page):
  - When Moran pastes the delivery manager's goals email, or says "set my
    goals" / "here are the sprint goals", call \`preplan_set_goals\`.
  - The tool description has the exact steps: confirm the sprint matches the
    current one, take only the current-sprint goal rows (drop the header and
    owner-name lines and the previous-sprint table), capture each goal's owner,
    and mark which are Moran's (his story matches first, else owner name).
  - It's local prep only — it never writes to Azure DevOps. After it saves,
    tell him it's set and to refresh the Pre-plan page.

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

BLOCK GUARD — \`blockNudge\` in session_start / session_log responses:
\`session_start\` and \`session_log\` (for any type except \`blocker\`)
now check whether the work item is still in a Blocked state. When it
is, the response carries a \`blockNudge\` string — a heads-up that
work is happening on a Blocked item, which is almost always a stale
flag that drifted past its unblock condition.

When you see \`blockNudge\` in a response, raise it IMMEDIATELY with
Moran in your next reply, before continuing the work in your head:
  - "you've still got <displayName> tagged Blocked but we're actively
    working on it. <one-line summary of the apparent unblock signal,
    e.g. the latest progress event>. Want me to clear the block?"
  - On yes → call \`workitem_unblock\` with a short summary of what
    cleared it. The tool restores the prior state and removes the tag.
  - On "no, keep it blocked" → ask why. If he's deliberately working
    on a blocked item (verbal-only unblock, partial unblock, state
    restoration for testing), record that with one \`session_log\` of
    type=note so the log doesn't look stale to a future reader.

This guard exists because activity on a Blocked item is the single
most common drift in Moran's flow. Caught by Moran 2026-06-03 after
his other chat logged five progress events against #434966 while it
stayed tagged Blocked. Never silently keep working past a blockNudge.

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
  - Matching this chat's cwd to a sprint story → \`story_match\` (always
    after orient on the first message of a chat); persisting a confirmed
    match → \`story_match_set\`.
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

/**
 * MCP results return content blocks; this is the boring JSON-in-text variant.
 * Every successful tool response also gets a stale-session-log check appended
 * — if any open session hasn't seen activity in 45 min, the assistant gets
 * a one-line nudge inside its own context. See server/log-nudge.ts.
 */
function jsonResult(value: unknown) {
  const blocks: Array<{ type: 'text'; text: string }> = [
    {
      type: 'text',
      text: JSON.stringify(value, null, 2),
    },
  ];
  const nudge = checkStaleLogNudge();
  if (nudge) blocks.push({ type: 'text', text: nudge });
  return { content: blocks };
}

function errorResult(message: string) {
  const blocks: Array<{ type: 'text'; text: string }> = [{ type: 'text', text: message }];
  const nudge = checkStaleLogNudge();
  if (nudge) blocks.push({ type: 'text', text: nudge });
  return {
    isError: true,
    content: blocks,
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
      "Read where Moran left off and what's waiting in his sprint, then write a friendly 2-4 sentence greeting (don't paste the numbers). Call once when he's reorienting — new chat, after a /compact, or a greeting like 'hi' / 'where were we'. Full trigger list and how to use the packet: SERVER_INSTRUCTIONS → OPENING GREETING and → CAPACITY.",
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
      // Walk ALL three buckets, not just inProgress — a session can outlive
      // its task's state. Example: another chat closes the task to Done
      // without calling session_end, leaving the timer ticking on a row
      // that's now in `payload.workItems.done`. Filtering only on inProgress
      // made those sessions look invisible to sprint_snapshot, so the
      // assistant couldn't find the sessionId to stop them.
      activeSessionDetails: [
        ...d.workItems.inProgress,
        ...d.workItems.upNext,
        ...d.workItems.done,
      ]
        .filter(w => w.activeSession)
        .map(w => ({
          workItemId: w.id,
          title: w.title,
          displayName: displayNameFor(w.id, w.title),
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

function displayNameFor(id: number | string, title: string): string {
  return `**${title}** (#${id})`;
}

function slim(w: Awaited<ReturnType<typeof buildDashboard>>['workItems']['inProgress'][number]) {
  return {
    id: w.id,
    title: w.title,
    /** Pre-formatted `**title** (#id)` — echo verbatim. Never assemble yourself. */
    displayName: displayNameFor(w.id, w.title),
    type: w.type,
    state: w.state,
    parent: w.parent
      ? {
          id: w.parent.id,
          title: w.parent.title,
          displayName: displayNameFor(w.parent.id, w.parent.title),
        }
      : undefined,
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
      "Update an existing Azure DevOps work item: title, state (waiting/going only — close via session_end, not here), Remaining Work, Completed Work, Original Estimate (backfill only — see field), story Effort, tags, iteration path. Pass at least one field; per-field rules are on each field below.",
    inputSchema: {
      workItemId: workItemIdSchema,
      title: z.string().min(1).optional().describe("Rename the work item (overwrites the title shown on the board). The title is visible to Moran's delivery manager, so confirm the exact new wording with Moran before calling — don't reword on your own."),
      state: z.enum(['waiting', 'going']).optional().describe("Move the item between 'waiting' and 'going'. To CLOSE a task, use session_end({done:true, completedHoursAfter}) instead — that's the only path that pushes Completed Work and zeros Remaining Work in one move."),
      remainingWork: z.number().min(0).optional().describe('Task field, in hours. The live signal — burns down as work happens. If a task is taking longer than estimated, raise this number (Original Estimate stays fixed for variance reporting).'),
      originalEstimate: z.number().min(0).optional().describe("Task field, in hours. BACKFILL ONLY — fills the Original Estimate when it's currently blank (e.g. a task that already existed with no estimate). REFUSED if the task already has one: that value is the baseline the delivery manager compares actual hours against, set once and never rewritten. To reflect a task growing, use remainingWork. Anchor the number to history with estimate_anchor before proposing it, same as at task_create."),
      completedWork: z.number().min(0).optional().describe('Task field, in hours. Climbs up as work happens — overwrite (not additive). The DM tracks the sprint by this field.'),
      effort: z.number().min(0).optional().describe('Story field, in hours. Total hours he thinks the story is. StoryPoints is derived from this automatically (1 point = 1 workday) and written in the same patch — do not try to set points separately.'),
      addTags: z.array(z.string().min(1)).optional().describe('Tag names to add to this item (e.g. ["Blocked"]). Case-insensitive dedup against existing tags.'),
      removeTags: z.array(z.string().min(1)).optional().describe('Tag names to remove from this item.'),
      iterationPath: z.string().min(1).optional().describe('Full ADO iteration path, backslash-separated (e.g. "IDP - DevOps\\\\2026" for the year-level, or "IDP - DevOps\\\\2026\\\\Q2\\\\26_11" for a specific sprint). Use this to move an item to a different sprint or to a parent iteration node. PLANNING RULE (enforced server-side): a story that is already underway stays in the sprint it started in — only its open TASKS carry over to a new sprint. Moving a started story (any state other than New / To Do / Proposed / Approved / Ready For Dev / Accepted) is refused. Move the tasks instead, or close the story. Never-started stories and tasks move freely.'),
    },
  },
  async ({ workItemId, title, state, remainingWork, completedWork, originalEstimate, effort, addTags, removeTags, iterationPath }) => {
    if (
      title == null &&
      state == null && remainingWork == null && completedWork == null &&
      originalEstimate == null && effort == null &&
      (addTags == null || addTags.length === 0) &&
      (removeTags == null || removeTags.length === 0) &&
      iterationPath == null
    ) {
      return errorResult('At least one of title, state, remainingWork, completedWork, originalEstimate, effort, addTags, removeTags, iterationPath is required.');
    }
    const applied: {
      title?: string;
      state?: string;
      remainingWork?: number;
      completedWork?: number;
      originalEstimate?: number;
      storyPoints?: number;
      effort?: number;
      tags?: string[];
      iterationPath?: string;
    } = {};
    try {
      if (title != null) applied.title = await setTitle(workItemId, title);
      if (state) applied.state = await setStateBucket(workItemId, state as StateBucket);
      if (remainingWork != null) {
        await setRemaining(workItemId, remainingWork);
        applied.remainingWork = remainingWork;
      }
      if (originalEstimate != null) {
        await backfillEstimateIfBlank(workItemId, originalEstimate);
        applied.originalEstimate = originalEstimate;
      }
      if (completedWork != null) {
        await setCompletedWork(workItemId, completedWork);
        applied.completedWork = completedWork;
      }
      if (effort != null) {
        const { effort: appliedEffort, storyPoints: appliedPoints } =
          await setEffortWithDerivedPoints(workItemId, effort);
        applied.effort = appliedEffort;
        applied.storyPoints = appliedPoints;
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

/** ADO states that mean "finished", lowercased — used by the story-close guards. */
const DONE_STATE_NAMES = new Set(['done', 'closed', 'resolved', 'completed', 'removed']);
function isDoneStateName(state: string): boolean {
  return DONE_STATE_NAMES.has(state.trim().toLowerCase());
}

/**
 * After a task closes, check whether its parent story is now fully done (all
 * children closed) but the story itself is still open. Returns a suggestion the
 * AI can raise with Moran ("its last task is done — close the story?"), or null.
 */
async function maybeSuggestStoryClose(
  taskId: number,
): Promise<{ workItemId: number; displayName: string } | null> {
  try {
    const task = await getWorkItem(taskId);
    const parentId = task.parent?.id;
    if (parentId == null) return null;
    const story = await getWorkItem(parentId);
    const stype = story.type.toLowerCase();
    if (stype === 'task' || stype === 'feature' || stype === 'epic') return null;
    if (isDoneStateName(story.state)) return null;
    if (story.children.some(c => !isDoneStateName(c.state))) return null;
    return { workItemId: story.id, displayName: displayNameFor(story.id, story.title) };
  } catch {
    return null;
  }
}

server.registerTool(
  'story_close',
  {
    title: 'Close a story',
    description:
      "Close a User Story or Bug (move it to the team's Done/Closed state) once its work is finished. STORIES ONLY — close Tasks via session_end({done:true, completedHoursAfter}), which captures the hours; a story has no hours of its own (they live on its tasks), so it closes directly here. Guards (all enforced server-side): refuses Tasks, Features and Epics; refuses to close a story that still has open (not-done) child tasks — close or move those first. Works for a story in ANY sprint, including leftovers from a previous iteration — closing a finished story is always allowed. Use this to close out a story whose tasks are all done.",
    inputSchema: {
      workItemId: workItemIdSchema,
    },
  },
  async ({ workItemId }) => {
    try {
      const d = await getWorkItem(workItemId);
      const typeLower = d.type.toLowerCase();
      if (typeLower === 'task') {
        return errorResult(
          `#${workItemId} is a Task. Close tasks with session_end({done:true, completedHoursAfter}) so the hours land on Azure DevOps — story_close is for stories only.`,
        );
      }
      if (typeLower === 'feature' || typeLower === 'epic') {
        return errorResult(`#${workItemId} is a ${d.type}. story_close is for User Stories / Bugs, not containers.`);
      }
      // Don't close over unfinished work.
      const openChildren = d.children.filter(c => !isDoneStateName(c.state));
      if (openChildren.length > 0) {
        const names = openChildren.map(c => displayNameFor(c.id, c.title)).join(', ');
        return errorResult(
          `#${workItemId} still has open tasks: ${names}. Close or move those to the next sprint first, then close the story.`,
        );
      }
      const toState = await setStateBucket(workItemId, 'done');
      invalidateDashboardCache();
      void mirrorSprintSummary();
      return jsonResult({ closed: { id: d.id, displayName: displayNameFor(d.id, d.title), toState } });
    } catch (e) {
      return errorResult(e instanceof Error ? e.message : String(e));
    }
  },
);

server.registerTool(
  'workitem_change_type',
  {
    title: 'Change a work item between User Story and Bug',
    description:
      "Flip an existing work item's type between User Story and Bug. ONLY these two types — refuses Tasks, Features and Epics (changing those would corrupt the hierarchy). Refuses a no-op if the item is already the requested type. The type is visible to Moran's delivery manager, so CONFIRM with Moran before calling — don't flip a type on your own. The item's state carries across (Story and Bug share New/Active/Closed here). Returns the item's new type and state.",
    inputSchema: {
      workItemId: workItemIdSchema,
      toType: z.enum(['story', 'bug']).describe("Target type: 'story' (User Story) or 'bug' (Bug)."),
    },
  },
  async ({ workItemId, toType }) => {
    try {
      const changed = await changeWorkItemType(workItemId, toType);
      invalidateDashboardCache();
      return jsonResult({
        changed: {
          id: changed.id,
          displayName: displayNameFor(changed.id, changed.title),
          toType: changed.type,
          state: changed.state,
        },
      });
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
      "Fetch one work item by id from Azure DevOps (fields, parent, children, effort, url). Use this instead of shelling out to 'az boards work-item show' so everything stays coordinated with sprint-helper's caches.",
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
        displayName: displayNameFor(d.id, d.title),
        state: d.state,
        tags,
        assignedTo: d.assignedTo,
        iteration,
        parent: d.parent
          ? {
              id: d.parent.id,
              title: d.parent.title,
              displayName: displayNameFor(d.parent.id, d.parent.title),
              type: d.parent.type,
              state: d.parent.state,
            }
          : undefined,
        children: d.children.map(c => ({
          id: c.id,
          title: c.title,
          displayName: displayNameFor(c.id, c.title),
          type: c.type,
          state: c.state,
        })),
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
      // A block can be called from any chat window, not necessarily the one
      // actually working the task — so don't let this window's cwd stamp
      // the session's home. Leave cwd unknown; the first working chat's
      // session_start backfills it (never-overwrite keeps it honest).
      const session = startSession({ workItemId, cwd: null });
      // Blocked ≠ working. If a stopwatch was running on this item, stop it;
      // never start a new one from the block action. The session row is kept
      // so the structured 'blocker' event has a container to live in.
      timerService.pause(workItemId);

      const parts = [`BLOCKED: ${reason}`];
      if (owner) parts.push(`Owner: ${owner}`);
      if (unblockCondition) parts.push(`Unblock when: ${unblockCondition}`);
      parts.push(`(was ${stateChange.fromState})`);
      const text = parts.join(' · ');
      const event = logEvent({ sessionId: session.id, type: 'blocker', text });

      // Mirror the reason into ADO's Discussion so the delivery manager sees
      // it on the board (CommentCount bumps by one). Don't fail the whole
      // block action if the comment write fails — surface it in the payload.
      let adoComment: { posted: boolean; error?: string };
      try {
        await addWorkItemComment(workItemId, text);
        adoComment = { posted: true };
      } catch (err) {
        adoComment = { posted: false, error: err instanceof Error ? err.message : String(err) };
      }

      invalidateDashboardCache();
      return jsonResult({ workItemId, stateChange, tags, session, event, adoComment });
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
      // Same constraint as workitem_block: an unblock can come from any
      // window, so don't stamp this chat's cwd onto the session. Leave it
      // unknown and let the first working chat's session_start backfill it.
      const session = startSession({ workItemId, cwd: null });
      timerService.start(workItemId);

      const restoredNote = stateChange.restored ? '' : ', prior state not captured';
      const text = `UNBLOCKED: ${summary} · (now ${stateChange.toState}${restoredNote})`;
      const event = logEvent({ sessionId: session.id, type: 'decision', text });

      let adoComment: { posted: boolean; error?: string };
      try {
        await addWorkItemComment(workItemId, text);
        adoComment = { posted: true };
      } catch (err) {
        adoComment = { posted: false, error: err instanceof Error ? err.message : String(err) };
      }

      invalidateDashboardCache();
      return jsonResult({ workItemId, stateChange, tags, session, event, adoComment });
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
      markSHCreated(created.id, 'task');
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
      "Create a new User Story in Azure DevOps, placed in Moran's current sprint and assigned to him. ALWAYS ask Moran for effortHours before calling — never guess, never skip. Effort is the single planning field the POM delivery manager reads; Story Points are derived from it automatically (1 point = 1 workday, rounded to the nearest half) and written in the same patch. Pass `parentFeatureId` to nest under an existing Feature/Epic if he has one. Returns the new story's id and URL.",
    inputSchema: {
      title: z.string().min(1).describe('Story title — short and specific.'),
      description: z.string().optional().describe('Optional details. Plain text or simple HTML.'),
      effortHours: z
        .number()
        .min(0)
        .describe('REQUIRED. Total hours Moran thinks this story is. Ask him for it before calling. StoryPoints is derived from this automatically (1 point = 1 workday) — do not pass points separately.'),
      parentFeatureId: z
        .number()
        .int()
        .positive()
        .optional()
        .describe('Optional Feature/Epic id to link this story under.'),
    },
  },
  async ({ title, description, effortHours, parentFeatureId }) => {
    try {
      const created = await createStory({
        title,
        description,
        effortHours,
        parentFeatureId,
      });
      markSHCreated(created.id, 'story');
      return jsonResult(created);
    } catch (e) {
      return errorResult(e instanceof Error ? e.message : String(e));
    }
  },
);

server.registerTool(
  'bug_create',
  {
    title: 'Create an ADO bug in the current sprint',
    description:
      "Create a new Bug in Azure DevOps, placed in Moran's current sprint and assigned to him. The twin of story_create — same flow: ALWAYS ask Moran for effortHours before calling (never guess, never skip). Story Points are derived from it automatically (1 point = 1 workday). Pass `parentFeatureId` to nest under a Feature/Epic. Use this when the work is a defect rather than new scope. Note: Bugs have no 'Blocked' state in this tenant — workitem_block falls back to a tag for bugs. Returns the new bug's id and URL.",
    inputSchema: {
      title: z.string().min(1).describe('Bug title — short and specific.'),
      description: z.string().optional().describe('Optional details. Plain text or simple HTML.'),
      effortHours: z
        .number()
        .min(0)
        .describe('REQUIRED. Total hours Moran thinks this bug is. Ask him for it before calling. StoryPoints is derived from this automatically — do not pass points separately.'),
      parentFeatureId: z
        .number()
        .int()
        .positive()
        .optional()
        .describe('Optional Feature/Epic id to link this bug under.'),
    },
  },
  async ({ title, description, effortHours, parentFeatureId }) => {
    try {
      const created = await createBug({ title, description, effortHours, parentFeatureId });
      // A bug is a story-level item here, so it's marked 'story'-kind (the kind
      // only matters for retro filtering; the dashboard pip ignores it).
      markSHCreated(created.id, 'story');
      // Drop the cache so a freshly created bug shows on the board right away.
      invalidateDashboardCache();
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

server.registerTool(
  'planning_gaps',
  {
    title: 'List sprint items missing effort fields',
    description:
      "Return every Task in the sprint being planned (the NEXT sprint by default, falling back to the current one when no next sprint is scheduled) missing OriginalEstimate or RemainingWork, plus every open Story missing Effort. Each gap is paired with a deterministic anchor proposal (median sibling actual from estimate_anchor, or a cold-start flag). Use this in a PLANNING HOME chat to walk Moran through the decompose-anchor-propose ritual one item at a time. Don't use this in a story-anchored work chat — it's a sprint-wide read.",
    inputSchema: {},
  },
  async () => {
    try {
      const result = await findGaps();
      return jsonResult(result);
    } catch (e) {
      return errorResult(e instanceof Error ? e.message : String(e));
    }
  },
);

server.registerTool(
  'preplan_set_goals',
  {
    title: 'Set the pre-plan goals from the PM email',
    description:
      "Set the sprint goals on Moran's PRIVATE pre-plan page (local only — never writes to Azure DevOps). Use this when Moran pastes the delivery manager's goals email (or says 'set my goals'). BEFORE calling: (1) confirm the email's sprint matches the current sprint — if it names a different sprint, ask Moran rather than mis-filing; (2) take ONLY the current-sprint goal rows — drop the table header row ('Goal'/'Status'/'Owner'), drop owner-name-only lines, and IGNORE any previous-sprint 'Is Achieved' table; (3) for each goal capture its `text` and `owner` (from the Owner column; null if none); (4) set `isMine`: a goal is Moran's if it lines up with one of HIS stories in the current sprint (check via sprint_snapshot / list_my_work_items) — if no story of his matches, fall back to whether the owner name is Moran (you know his name). If the pasted text doesn't actually look like a goals email — no recognizable goal rows, no sprint context, random unrelated text — say so and don't call this tool at all; never save junk just because Moran pasted something. This REPLACES the whole goal set for the current sprint each call, so always pass the full cleaned list. Returns how many were saved and the sprint name. After saving, tell Moran it's set and remind him to refresh the Pre-plan page.",
    inputSchema: {
      goals: z
        .array(
          z.object({
            text: z.string().min(1).describe('The goal itself, e.g. "GitOps - finish Phase 1".'),
            owner: z.string().nullish().describe('The Owner column value, e.g. "Gleb" or "Maxim + Vis". Null/omit when none.'),
            isMine: z.boolean().optional().describe("True when this goal is Moran's (story-match first, owner-name fallback). Defaults false."),
          }),
        )
        .describe('The full, cleaned list of current-sprint goals. Replaces any existing goals for the sprint.'),
    },
  },
  async ({ goals }) => {
    const payload = await buildPrePlanPayload();
    const sprintName = payload.sprintName;
    if (!sprintName) return errorResult('No current sprint — set a sprint first.');
    const cleaned = normalizeGoals(
      goals.map(g => ({ text: g.text, owner: g.owner ?? null, isMine: g.isMine ?? false })),
    );
    const next = setGoals(getPrePlanState(sprintName), cleaned);
    savePrePlanState(sprintName, next);
    return jsonResult({ saved: cleaned.length, sprintName });
  },
);

/* ============================================================ */
/*  Session tools                                                */
/* ============================================================ */

/**
 * Read current block state for a work item from the dashboard cache.
 * Returns blocked=true when the item is either in a Blocked state or has
 * the 'Blocked' tag set (legacy compat). Used by session_start /
 * session_log to surface a nudge when activity hits a still-blocked
 * item — see R10a, the gap Moran's other chat surfaced 2026-06-03
 * (working on #434966 while it stayed tagged Blocked).
 */
async function readBlockState(workItemId: number): Promise<{
  blocked: boolean;
  state: string;
  hasTag: boolean;
}> {
  const { payload } = await buildDashboardCached();
  const all = [
    ...payload.workItems.inProgress,
    ...payload.workItems.upNext,
    ...payload.workItems.done,
  ];
  const w = all.find(x => Number(x.id) === workItemId);
  if (!w) return { blocked: false, state: 'unknown', hasTag: false };
  const stateBlocked = isBlockedState(w.state);
  const hasTag = (w.tags ?? []).includes('Blocked');
  return { blocked: stateBlocked || hasTag, state: w.state, hasTag };
}

function buildBlockNudge(block: { blocked: boolean; state: string; hasTag: boolean }): string | null {
  if (!block.blocked) return null;
  const sig = isBlockedState(block.state)
    ? `state \`${block.state}\``
    : block.hasTag
      ? `the 'Blocked' tag`
      : 'a block signal';
  return `Heads-up: this work item is currently blocked (${sig}${block.hasTag && isBlockedState(block.state) ? ' + tag' : ''}). If the block has cleared, call \`workitem_unblock\` now — don't let it drift. If work is genuinely continuing while blocked (state restored for testing, partial unblock, etc.), say so to Moran explicitly so the tag isn't misleading.`;
}

/**
 * Work-item types that are containers, not units of work. You open a session on
 * a TASK under one of these, never on the container itself — a session on a
 * story is why Focus mode shows the story with no task activity. Bug is a
 * workable leaf (often no child tasks), so it's intentionally absent.
 */
const SESSION_CONTAINER_TYPES = new Set([
  'user story',
  'feature',
  'epic',
  'product backlog item',
  'requirement',
]);

server.registerTool(
  'session_start',
  {
    title: 'Start a Claude Code session',
    description:
      "Open a session against a work item — which must be a TASK (or a Bug). Sessions attach to a unit of work, never to a container: if you pass a User Story / Feature / Epic, this REFUSES and returns the open tasks under it — pick one (or ask Moran which) and call again with that task's id. (Opening on a story is why Focus mode shows the story with no task activity.) Returns a sessionId you'll pass to later session_log / session_end calls. Idempotent — returns the existing session if one is already open. AUTO-FLIPS the work item state from any 'waiting' state (New / To Do / Proposed) to 'going' (Active / In Progress) in Azure DevOps, since opening a session IS the act of starting work. When the item is a Task, its parent Story is flipped to 'going' too (a task in flight means the story is in flight) — reported as `parentStoryFlip`. No prompt — that's the design Moran approved. Reports `stateFlip` (and `parentStoryFlip` when the story flipped) so you can mention it in your reply.",
    inputSchema: {
      workItemId: workItemIdSchema,
      client: z
        .string()
        .optional()
        .describe('Optional client identifier. Defaults to "claude-code".'),
    },
  },
  async ({ workItemId, client }) => {
    // Guard: a session attaches to a workable unit (Task/Bug), never to a
    // container story. Read the item; if it's a container, refuse and hand back
    // its open tasks so the assistant picks one instead of landing on the story.
    // A read failure here doesn't block work — we just skip the guard.
    let detail: Awaited<ReturnType<typeof getWorkItem>> | null = null;
    try {
      detail = await getWorkItem(workItemId);
    } catch {
      detail = null;
    }
    if (detail && SESSION_CONTAINER_TYPES.has(detail.type.trim().toLowerCase())) {
      const storyName = `**${detail.title}** (#${detail.id})`;
      const openTasks = detail.children.filter(c => !isDoneStateName(c.state));
      if (openTasks.length === 0) {
        return errorResult(
          `${storyName} is a ${detail.type} — a session attaches to a task, not a story, and this one has no open tasks under it. Create a task first (task_create) before starting work. (If this is planning rather than doing, you don't need a session at all.)`,
        );
      }
      const list = openTasks.map(t => `  • **${t.title}** (#${t.id}) — ${t.state}`).join('\n');
      return errorResult(
        `${storyName} is a ${detail.type}, not a unit of work — open the session on a task under it (that's why a session on a story leaves Focus with nothing to show). Pick one of its open tasks, or ask Moran which, then call session_start again with that task's id:\n${list}`,
      );
    }

    // Cap parallel work. Refuse a genuinely NEW session past the limit and
    // name what's already running so Moran picks one to pause/finish. Re-opening
    // an item that already has a session is never blocked (handled in the predicate).
    const runningSessions = listActiveSessions();
    const max = maxParallelSessions();
    if (parallelCapExceeded({ activeSessions: runningSessions, workItemId, max })) {
      const names = await Promise.all(
        runningSessions.map(async s => {
          try {
            const w = await getWorkItem(s.workItemId);
            return `  • ${displayNameFor(w.id, w.title)}`;
          } catch {
            return `  • #${s.workItemId}`;
          }
        }),
      );
      return errorResult(
        `You already have ${max} tasks running — that's your limit. Pause or finish one before starting another. Running now:\n${names.join('\n')}`,
      );
    }

    const session = startSession({ workItemId, client });
    timerService.start(workItemId); // silent time tracking begins with the session
    void mirrorTaskFile(workItemId); // background — keep the archive file fresh

    // Opening a session changes activeSession / timer state on the dashboard,
    // even when no ADO state flip happens (item was already Active). Always
    // drop the cache so the next dashboard hit reflects the live session.
    invalidateDashboardCache();

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
    } catch (e) {
      stateFlip = {
        flipped: false,
        fromState: 'unknown',
        toState: 'unknown',
        error: e instanceof Error ? e.message : String(e),
      };
    }

    // Cascade up: starting a task pulls its parent story into "going" too, so
    // the board never shows a story as untouched while its tasks are in flight.
    // Best-effort — null when there's nothing to flip (not a task, no parent,
    // parent already active, or parent is a Feature/Epic).
    const parentStoryFlip = await ensureParentStoryActive(workItemId);

    // R10a: opening a session on a Blocked item is the moment to question
    // whether the block still applies. Surface a nudge so the assistant
    // raises it with Moran instead of silently building on a stale block.
    const blockNudge = buildBlockNudge(await readBlockState(workItemId));

    return jsonResult({
      session,
      stateFlip,
      ...(parentStoryFlip?.flipped ? { parentStoryFlip } : {}),
      ...(blockNudge ? { blockNudge } : {}),
    });
  },
);

server.registerTool(
  'session_log',
  {
    title: 'Log a session event (and optionally burn down RemainingWork)',
    description:
      "Record an event in an open session. Types: 'focus' (switching attention), 'progress' (what got done so far), 'blocker' (something getting in the way), 'decision' (a tradeoff Moran chose), 'note' (anything else). These surface in his Day dashboard. PLUS — for 'progress' events that completed a substantial chunk of work, pass `remainingHoursAfter` to burn down RemainingWork on the task in the same call. Single tool call replaces logEvent + workitem_edit; you cannot forget the second step. Skip the field for small tweaks or non-progress events.",
    inputSchema: {
      sessionId: z.string().describe('Session id returned by session_start.'),
      type: z.enum(['focus', 'progress', 'blocker', 'decision', 'note']),
      text: z.string().min(1),
      standupSummary: z
        .string()
        .min(1)
        .optional()
        .describe(
          "1-2 sentence read-this-tomorrow blurb for the standup card. REQUIRED on `progress` and `blocker` events — the tool refuses those without it. It's what Moran sees on his Yesterday/Today rows when he opens the dashboard. PLAIN, NON-TECHNICAL gist — what it MEANT in human terms, ≤200 chars: 'what I got done (and the next step, if obvious)' or 'what's stuck and who unblocks it'. NO file names, paths, branch/commit/PR/ticket references, schema or config names, or product/tool/cluster names — those belong in `text`, not here. Optional on `focus`, `decision`, and `note` events, which don't surface on the standup card.",
        ),
      remainingHoursAfter: z
        .number()
        .gt(0)
        .optional()
        .describe(
          "Honest estimate of how many hours of work are LEFT on this task after this progress event. MUST be strictly > 0 — if the task is done, call session_end with done=true instead, which runs the proper close-the-loop (push CompletedWork, close the task). Setting RemainingWork to 0 via session_log leaves the task in a broken state (Remaining=0 but session still open, CompletedWork not pushed). If set, sprint-helper writes RemainingWork on the work item in the same call. Only include when the event represents a substantial chunk of work landing (not for tweaks, focus shifts, blockers, or pure notes). The whole point is keeping the burn-down honest without forcing a separate tool call.",
        ),
    },
  },
  async ({ sessionId, type, text, standupSummary, remainingHoursAfter }) => {
    if (!isSessionEventType(type)) return errorResult(`Unknown event type: ${type}`);
    // Speed bump (not just a sign): a 'progress' or 'blocker' event is what
    // feeds Moran's standup card, so the friendly one-liner is mandatory for
    // those two types. Refuse the call rather than letting the dashboard fall
    // back to truncating the long-form text into a half-thought. 'focus',
    // 'decision', and 'note' don't surface on the standup card, so they stay
    // free to omit it.
    if ((type === 'progress' || type === 'blocker') && (standupSummary == null || standupSummary.trim() === '')) {
      return errorResult(
        `standupSummary is required for '${type}' events — it's the 1-2 sentence read-this-tomorrow line Moran sees on his standup card. Add a plain-English summary of ${type === 'progress' ? 'what got done' : "what's stuck and who unblocks it"} and call again.`,
      );
    }
    if (remainingHoursAfter != null && remainingHoursAfter <= 0) {
      // Schema's `.gt(0)` already rejects 0, but keep the defensive guard
      // in case the schema gets loosened or a caller bypasses it.
      return errorResult(
        `remainingHoursAfter must be > 0. If the task is done, call session_end with done=true instead — that's the only path that pushes CompletedWork and closes the task properly. Setting RemainingWork to 0 via session_log leaves the task in a broken state (Remaining=0, session still open, CompletedWork not pushed).`,
      );
    }
    // buildCwdWarning is a hoisted function declaration defined just below
    // this handler — it's in scope here even though it appears later in the file.
    const cwdWarning = buildCwdWarning(getSession(sessionId));
    const event = logEvent({ sessionId, type, text, standupSummary });
    if (!event) return errorResult(`Session not found: ${sessionId}`);
    void mirrorTaskFile(event.workItemId); // background — keep the archive file fresh

    // Events surface in the dashboard's recentEvents map and shape the
    // story-state / Day view. Drop the cache so the next read picks them up.
    invalidateDashboardCache();

    // R10a: when active-work events (progress / decision / note / focus)
    // hit a still-blocked item, surface a nudge so the block doesn't
    // silently drift. `blocker` events are legitimately adding context to
    // the block itself — never nudge for those.
    const blockNudge =
      type === 'blocker'
        ? null
        : buildBlockNudge(await readBlockState(event.workItemId));

    if (remainingHoursAfter == null) {
      return jsonResult({
        event,
        ...(blockNudge ? { blockNudge } : {}),
        ...(cwdWarning ? { cwdWarning } : {}),
      });
    }
    try {
      await setRemaining(event.workItemId, remainingHoursAfter);
      // Mark that this session burned down RemainingWork at least once, so
      // session_end can tell whether the board went stale (Rule 2). Keyed by
      // session so it can't leak across sessions on the same task.
      setSetting(`remaining_touched_${sessionId}`, event.createdAt);
      return jsonResult({
        event,
        remainingWork: {
          applied: remainingHoursAfter,
          workItemId: event.workItemId,
        },
        ...(blockNudge ? { blockNudge } : {}),
        ...(cwdWarning ? { cwdWarning } : {}),
      });
    } catch (e) {
      // Event was already logged; surface the partial success + the write error.
      return jsonResult({
        event,
        remainingWork: {
          applied: null,
          workItemId: event.workItemId,
          error: e instanceof Error ? e.message : String(e),
        },
        ...(blockNudge ? { blockNudge } : {}),
        ...(cwdWarning ? { cwdWarning } : {}),
      });
    }
  },
);

// How long a session can run with nothing logged before session_end requires
// a catch-up note (Rule 1). Matches the stale-log nudge window. Tune here.
const SESSION_LOG_REQUIRED_AFTER_MINUTES = 45;

/**
 * Cross-repo speed bump (not a wall): when a chat logs against a session that
 * a chat in a DIFFERENT repo started, warn — but let the call through.
 * 'unknown' (old sessions, odd launch dirs) never warns.
 */
function buildCwdWarning(session: Session | null): string | null {
  if (!session) return null;
  if (sessionOwnershipHint(session.cwd, chatCwdBasename()) !== 'other-repo') return null;
  return `⚠️ This session was started from \`${session.cwd}\` — a different chat's work. Make sure you're in the right chat before logging here.`;
}

server.registerTool(
  'session_end',
  {
    title: 'End a Claude Code session',
    description:
      'Close a session with a one-line summary of what got done. Set done=true ONLY after Moran has confirmed the task is finished AND has confirmed the Completed hours — that pushes CompletedWork + RemainingWork=0 to Azure DevOps and transitions the state to Done. The local stopwatch is NOT the source of truth: completedHoursAfter (required when done=true) is the burndown number Moran agreed to. Omit done (or pass false) when he is just stopping for now: the local timer pauses and NOTHING is written to Azure DevOps.',
    inputSchema: {
      sessionId: z.string(),
      summary: z.string().optional(),
      done: z
        .boolean()
        .optional()
        .describe('True only when Moran has explicitly confirmed the task is complete. Pushes CompletedWork + RemainingWork=0 + state=Done to Azure DevOps.'),
      completedHoursAfter: z
        .number()
        .gt(0)
        .optional()
        .describe('REQUIRED when done=true. The CompletedWork value to push to Azure DevOps, derived from the burndown formula (OriginalEstimate − new RemainingWork, adjusted if the task overran the estimate). Must match the number Moran confirmed in chat. Without this, CompletedWork would stay at its historical value (usually 0) — bad signal for the delivery manager.'),
      remainingHoursAfter: z
        .number()
        .gt(0)
        .optional()
        .describe("For the PAUSE path (done omitted/false). The current honest estimate of hours LEFT on the task. Pass this when you're stopping mid-task and the remaining work has changed since you last burned it down — sprint-helper writes RemainingWork to Azure DevOps so the board doesn't go stale. If you logged progress this session but never updated RemainingWork, session_end will REQUIRE this before it closes. Pass the same number you already have if it genuinely hasn't moved. Ignored when done=true (that path drives RemainingWork to 0)."),
    },
  },
  async ({ sessionId, summary, done, completedHoursAfter, remainingHoursAfter }) => {
    if (done && completedHoursAfter === undefined) {
      return errorResult(
        'completedHoursAfter is required when done=true. Propose the number using the burndown formula (CompletedWork = OriginalEstimate − new RemainingWork, adjusted for overrun), confirm with Moran in chat, then pass it as completedHoursAfter. Closing a task without an explicit Completed value leaves CompletedWork at its historical value on Azure DevOps — usually 0 — which is the wrong signal for the delivery manager.',
      );
    }

    // Computed once up here: used by the no-open-session warning below (Move 3)
    // and saved as the closing summary when the session does close.
    const haveSummary = summary != null && summary.trim() !== '';
    const cwdWarning = buildCwdWarning(getSession(sessionId));

    // ---- Pre-close speed bumps (run BEFORE the session is closed) ----
    // The session is still open here, so we can read what happened during it.
    // If a check fails we return early and the session stays open, so the AI
    // can fix the gap and call session_end again.
    const openSession = listActiveSessions().find((s) => s.id === sessionId);
    if (openSession) {
      const events = listEventsForSession(sessionId);
      const hadProgress = events.some((e) => e.type === 'progress');
      const hadSubstantiveLog = events.some(
        (e) => e.type === 'progress' || e.type === 'blocker' || e.type === 'decision',
      );
      const minutesOpen = (Date.now() - new Date(openSession.startedAt).getTime()) / 60000;

      // Rule 1 (catch-up log): a session that ran a real stretch but recorded
      // nothing about what happened shouldn't close silently. A closing summary
      // alone is NOT enough on a long session — it needs at least one real
      // session_log entry (progress / blocker / decision).
      if (
        catchUpLogRequired({
          minutesOpen,
          hadSubstantiveLog,
          thresholdMinutes: SESSION_LOG_REQUIRED_AFTER_MINUTES,
        })
      ) {
        return errorResult(
          `This session has been open about ${Math.round(minutesOpen)} minutes but nothing was logged about what got done. A closing summary on its own isn't enough on a session this long — call session_log with at least one 'progress' entry naming what happened, then call session_end again. (This is what catches the case where sub-agents did the work and it never got written down.)`,
        );
      }

      // Rule 2 (keep RemainingWork honest): if progress landed but the burndown
      // was never touched this session, the board still shows the old estimate.
      // Satisfiable by passing remainingHoursAfter (the current honest number,
      // or the same value if it truly hasn't moved). Only on the pause path —
      // done=true drives RemainingWork to 0 explicitly below.
      const remainingTouched = getSetting(`remaining_touched_${sessionId}`) != null;
      if (!done && hadProgress && !remainingTouched && remainingHoursAfter == null) {
        return errorResult(
          "You logged progress this session but never updated the remaining hours, so Azure DevOps still shows the old estimate. Pass `remainingHoursAfter` with the current honest number of hours left (or the same value if it genuinely hasn't moved) and call session_end again. If the task is actually finished, use done=true with completedHoursAfter instead.",
        );
      }
    }

    const session = endSession({ sessionId, summary });
    if (!session) {
      // No open session matched. If the agent was clearly closing out work
      // (it passed a summary or done=true), this is the "never opened one"
      // case — warn plainly so Moran sees the session went untracked. This is
      // a message only: we do NOT retroactively create a session (Option 1).
      if (haveSummary || done) {
        return errorResult(
          `No open session matched ${sessionId}, so nothing was recorded against the task during this chat — it went untracked. If work happened here, next time call session_start on the task before working so it gets logged. (Nothing was written to Azure DevOps.)`,
        );
      }
      return errorResult(`Session not found: ${sessionId}`);
    }
    // Ending a session is the single most cache-invalidating event we have —
    // activeSession turns off, timer stops, the Day view re-shapes. Drop the
    // cache here so BOTH the pause-only and done=true paths leave a clean
    // slate, instead of relying on a downstream ADO write to do it.
    invalidateDashboardCache();
    void mirrorTaskFile(session.workItemId); // background — keep the archive file fresh
    void mirrorSprintSummary(); // and refresh the sprint overview
    void mirrorStandupForToday(); // and the standup notes for today
    try {
      if (done) {
        // Stop the local stopwatch (informational only; does not push to ADO).
        timerService.pause(session.workItemId);
        // Explicit close-the-loop. Local timer ticks are NOT the source of
        // truth for Completed — Moran burns down RemainingWork via session_log
        // during work, and the burndown formula gives the Completed number at
        // close. We patch CompletedWork + RemainingWork=0 + state=Done.
        await setCompletedWork(session.workItemId, completedHoursAfter!);
        await setRemaining(session.workItemId, 0);
        const newState = await setStateBucket(session.workItemId, 'done');
        // If this was the story's last open task, suggest closing the story too
        // (story_close) so a finished story doesn't linger on New/Active.
        const storyCloseSuggestion = await maybeSuggestStoryClose(session.workItemId);
        return jsonResult({
          session,
          done: true,
          completedHoursPushed: completedHoursAfter,
          remainingHoursPushed: 0,
          newState,
          ...(storyCloseSuggestion ? { storyCloseSuggestion } : {}),
          ...(cwdWarning ? { cwdWarning } : {}),
        });
      }
      // Pause-only path. Stop the local timer. The only ADO write here is the
      // optional RemainingWork refresh (Rule 2) when the caller passed it.
      const timer = timerService.pause(session.workItemId);
      if (remainingHoursAfter != null) {
        await setRemaining(session.workItemId, remainingHoursAfter);
        return jsonResult({
          session,
          done: false,
          timer,
          remainingHoursPushed: remainingHoursAfter,
          ...(cwdWarning ? { cwdWarning } : {}),
        });
      }
      return jsonResult({ session, done: false, timer, ...(cwdWarning ? { cwdWarning } : {}) });
    } catch (e) {
      return errorResult(e instanceof Error ? e.message : String(e));
    }
  },
);

server.registerTool(
  'session_waiting',
  {
    title: "Flag that you're waiting on Moran",
    description:
      "Call this right BEFORE you stop mid-task to ask Moran a question, so his dashboard shows the task is waiting for him (the 'Needs you' card). Pass the open sessionId and the question as ONE short plain-English sentence — write it like you'd text him, no file paths or tool names. The flag clears itself on this session's next session_log or session_end; no cleanup call needed. Local only — never writes to Azure DevOps. Don't call it for the final 'is this task done?' close-out question at session end — session_end itself covers that moment.",
    inputSchema: {
      sessionId: z.string().describe('Session id returned by session_start.'),
      question: z
        .string()
        .min(1)
        .describe('The question Moran needs to answer. One short plain sentence.'),
    },
  },
  async ({ sessionId, question }) => {
    const session = setSessionWaiting({ sessionId, question });
    if (!session) {
      return errorResult(
        `No open session matched ${sessionId} — nothing was flagged. The 'Needs you' card only tracks open sessions.`,
      );
    }
    // This only clears THIS process's (the MCP server's) own cache, so its
    // own orient/snapshot reads see the flag right away. It does nothing for
    // the dashboard — that's a separate process that reads waiting_note/
    // waiting_since straight from SQLite on its own poll+rebuild cycle
    // (~15-30s), regardless of this call. Don't add more invalidation here
    // to chase dashboard latency — it can't reach across processes.
    invalidateDashboardCache();
    return jsonResult({ waiting: true, question, sessionId: session.id });
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
      "Read what's currently in Moran's helper-notes space on his dashboard: his open (not-yet-cleared) nudges. Call this before writing so you don't repeat a nudge that's already there.",
    inputSchema: {},
  },
  async () => jsonResult(getHelperNotes()),
);

server.registerTool(
  'helper_note_add',
  {
    title: "Add a nudge to the helper's notes",
    description:
      "Drop a single short nudge into Moran's notes space — something you noticed worth his attention (an estimate that looks low, tasks gone quiet, a good day for deep work). Plain, casual English, one thought per note. When the nudge is about a specific task or story, pass its id as workItemId so it also shows up in Focus mode while he's on that work. He ticks these off himself once handled, so only add things that are genuinely actionable or worth seeing.",
    inputSchema: {
      body: z.string().min(1).describe('One short, casual, plain-English nudge.'),
      workItemId: z
        .number()
        .int()
        .positive()
        .optional()
        .describe('The Azure DevOps id this nudge is about, if any, so Focus can surface it.'),
    },
  },
  async ({ body, workItemId }) => jsonResult(addNote(body, workItemId ?? null)),
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
  'planning_home_set',
  {
    title: "Set Moran's sprint-helper planning home folder",
    description:
      "Configure the absolute path Moran wants to use as his sprint-helper PLANNING HOME — the cwd where he runs sprint-wide planning chats (not story-anchored work chats). Creates the folder if needed and drops a `.sprint-helper-home` marker file inside so the assistant can detect the planning-home mode in any future chat opened there. Default location if Moran doesn't override: `~/.sprint-helper/home/`.",
    inputSchema: {
      path: z
        .string()
        .min(1)
        .describe('Absolute path for the planning home folder. `~` is expanded to the home directory.'),
    },
  },
  async ({ path }) => {
    try {
      const abs = setPlanningHome(path);
      return jsonResult({ configuredPath: abs, markerFile: `${abs}/.sprint-helper-home` });
    } catch (e) {
      return errorResult(e instanceof Error ? e.message : String(e));
    }
  },
);

server.registerTool(
  'planning_home_status',
  {
    title: 'Read the configured sprint-helper planning home',
    description:
      "Return the planning-home path Moran has configured (or the default if he never set one) and optionally check whether a given cwd qualifies as a planning home (marker file present OR configured path matches). Use this when the model needs to decide whether to skip the story-anchor in the current chat.",
    inputSchema: {
      cwd: z
        .string()
        .optional()
        .describe('Optional cwd to test. When set, the response includes a `match` block describing how (marker / configured / no match).'),
    },
  },
  async ({ cwd }) => {
    try {
      const status = getPlanningHome();
      const match = cwd ? isPlanningHomeCwd(cwd) : null;
      return jsonResult({ ...status, match });
    } catch (e) {
      return errorResult(e instanceof Error ? e.message : String(e));
    }
  },
);

server.registerTool(
  'capacity_check',
  {
    title: 'Real desk time vs planned',
    description:
      "Compute Moran's real desk time for the current sprint: working hours (9h/day, Sun-Thu) minus meetings from his Outlook calendar (busy + out-of-office, clipped to the workday; tentative is ignored), compared to planned task hours. Use it when he asks 'is this sprint realistic?' or 'how much time do I really have?'. With no calendar URL set it skips the meeting subtraction and flags hasUrl=false — surface that to him.",
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
/*  Story match (slice R7a)                                      */
/* ============================================================ */

server.registerTool(
  'story_match',
  {
    title: 'Match a chat to a sprint story',
    description:
      "Given the chat's cwd (plus optional git remote and recent commit subjects), rank current-sprint stories by relevance. Returns three things: `learnedMatch` (a previously-confirmed story for this cwd in this sprint, if any), `topMatch` (the strongest heuristic candidate above the confidence threshold, or null), and `allStories` (every open sprint story sorted by score descending so the assistant can show alternatives). Call this on first activity in a chat to identify which story to attach to, BEFORE asking Moran to pick — and show him the top guess alongside the full list so he can override.",
    inputSchema: {
      cwd: z.string().min(1).describe("The chat's current working directory (absolute path). Strongest signal for matching."),
      gitRemote: z.string().optional().describe('Optional: the chat\'s git remote URL or short name. The last path segment is used.'),
      recentCommits: z.array(z.string()).optional().describe('Optional: recent commit subject lines for this repo, newest first. Bounded to ~10 for relevance.'),
      recentFiles: z.array(z.string()).optional().describe('Optional: file paths recently touched in this chat. Basenames are used.'),
    },
  },
  async ({ cwd, gitRemote, recentCommits, recentFiles }) => {
    try {
      const { payload } = await buildDashboardCached();
      if (!payload.sprint) return errorResult('No current sprint — set a sprint first.');
      const openStories: SprintStory[] = payload.userStories
        .filter(s => !/(closed|done|removed|resolved)/i.test(s.state ?? ''))
        .map(s => ({
          storyId: Number(s.id),
          title: s.title,
          featureTitle: s.feature?.title,
        }));
      const result = resolveStoryMatch(
        { cwd, gitRemote, recentCommits, recentFiles },
        payload.sprint.name,
        openStories,
      );
      return jsonResult({
        sprintName: payload.sprint.name,
        ...result,
      });
    } catch (e) {
      return errorResult(e instanceof Error ? e.message : String(e));
    }
  },
);

server.registerTool(
  'story_match_set',
  {
    title: 'Remember a confirmed cwd → story mapping',
    description:
      "Persist a confirmed mapping from a cwd to a sprint story id. Call this after Moran confirms 'yes, this chat is on **<title>**' so the next chat in the same repo this sprint doesn't have to re-ask. Pass `storyId: 0` (or omit) with `clear: true` to forget a previous mapping (e.g. when Moran switches what a repo is for).",
    inputSchema: {
      cwd: z.string().min(1).describe('Absolute path of the cwd this mapping applies to.'),
      storyId: workItemIdSchema.optional().describe('The story id Moran confirmed. Required unless `clear: true`.'),
      clear: z.boolean().optional().describe('Set true to clear the existing mapping for this cwd in the current sprint.'),
    },
  },
  async ({ cwd, storyId, clear }) => {
    try {
      const { payload } = await buildDashboardCached();
      if (!payload.sprint) return errorResult('No current sprint — set a sprint first.');
      if (clear) {
        clearLearnedStoryId(cwd, payload.sprint.name);
        return jsonResult({ cleared: true, cwd, sprintName: payload.sprint.name });
      }
      if (storyId == null) return errorResult('storyId is required unless `clear: true`.');
      setLearnedStoryId(cwd, payload.sprint.name, storyId);
      return jsonResult({
        learned: true,
        cwd,
        storyId,
        sprintName: payload.sprint.name,
      });
    } catch (e) {
      return errorResult(e instanceof Error ? e.message : String(e));
    }
  },
);

/* ============================================================ */
/*  Boot                                                         */
/* ============================================================ */

async function main() {
  // SPIKE: log EVERY boot so we can tell if the env var reached this child
  // process at all (Claude Code spawns the MCP server separately).
  spikeLog(`boot: SH_CHANNEL_SPIKE=${JSON.stringify(process.env.SH_CHANNEL_SPIKE)} enabled=${channelSpikeEnabled()}`);

  // SPIKE: declare the channel capability BEFORE connect when the flag is on.
  if (channelSpikeEnabled()) registerChannelCapability(server);

  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Pre-warm the dashboard cache so the first orient/capacity_check
  // call doesn't pay the 10–15s cold ADO fetch. Fire-and-forget;
  // don't block the MCP handshake.
  void buildDashboardCached().catch(() => {
    // eslint-disable-next-line no-console
    console.error('sprint-helper: dashboard pre-warm failed (will lazy-load on first call).');
  });

  // SPIKE: fire ONE unprompted nudge 15s after connect, so you can FEEL an
  // event arriving in an idle chat. Throwaway — remove after the experiment.
  if (channelSpikeEnabled()) {
    spikeLog('armed: nudge in 15s');
    setTimeout(() => {
      spikeLog('firing: pushChannel now');
      void pushChannel(
        server,
        'Channel spike: this line arrived on its own, no tool call — this is what an unprompted in-chat nudge feels like.',
        { kind: 'spike-test' },
      )
        .then(() => spikeLog('push resolved (written to transport)'))
        .catch(e => spikeLog(`push FAILED: ${e instanceof Error ? e.message : String(e)}`));
    }, 15_000);
  }
  // stdio transport keeps the process alive; nothing else needed.
}

main().catch(err => {
  // eslint-disable-next-line no-console
  console.error('sprint-helper MCP server crashed:', err);
  process.exit(1);
});
