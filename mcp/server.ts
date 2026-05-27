#!/usr/bin/env node
/**
 * Sprint-helper MCP server.
 *
 * Exposes sprint-helper backend operations to Claude Code (or any MCP client)
 * over stdio. Tools fall into four buckets:
 *  - read:    sprint_snapshot, list_my_work_items
 *  - timers:  timer_start, timer_pause, timer_sync, timer_done
 *  - edits:   workitem_edit
 *  - sessions: session_start, session_log, session_end
 *
 * The sprint guardrail (`sprint_check_in`, `task_create`) lives in slice 2.1c
 * and is not yet wired up here.
 *
 * Run: `npm run mcp`  (uses tsx so the same source ships from server/ unchanged).
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import { buildDashboard } from '../server/dashboard.js';
import {
  endSession,
  isSessionEventType,
  logEvent,
  startSession,
} from '../server/sessions.js';
import * as timerService from '../server/timer-service.js';
import {
  setEstimate,
  setRemaining,
  setStateBucket,
  type StateBucket,
} from '../server/writes.js';

const server = new McpServer({
  name: 'sprint-helper',
  version: '0.1.0',
});

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
  'sprint_snapshot',
  {
    title: 'Sprint snapshot',
    description:
      "Get a condensed view of Moran's current sprint: which work items are in progress, up next, and done; which timers are running; which Claude Code sessions are live. Call this at the start of a conversation so you understand what she's working on.",
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
/*  Timer tools                                                  */
/* ============================================================ */

server.registerTool(
  'timer_start',
  {
    title: 'Start timer',
    description:
      "Start a timer on a work item. Use when Moran starts actively working on a task. Idempotent — returns the existing timer's state if one is already running.",
    inputSchema: { workItemId: workItemIdSchema },
  },
  async ({ workItemId }) => jsonResult(timerService.start(workItemId)),
);

server.registerTool(
  'timer_pause',
  {
    title: 'Pause timer',
    description:
      'Pause the running timer on a work item. Use when Moran stops working on a task without finishing it. No-op if no timer is running.',
    inputSchema: { workItemId: workItemIdSchema },
  },
  async ({ workItemId }) => jsonResult(timerService.pause(workItemId)),
);

server.registerTool(
  'timer_sync',
  {
    title: 'Sync timer to ADO',
    description:
      'Push tracked time on a work item to Azure DevOps (updates CompletedWork, decrements RemainingWork). Pauses any running timer first so its time is included.',
    inputSchema: { workItemId: workItemIdSchema },
  },
  async ({ workItemId }) => {
    try {
      return jsonResult(await timerService.sync(workItemId));
    } catch (e) {
      return errorResult(e instanceof Error ? e.message : String(e));
    }
  },
);

server.registerTool(
  'timer_done',
  {
    title: 'Mark work item done',
    description:
      'Sync the timer to ADO and transition the work item to Done/Closed. Use when Moran finishes a task entirely.',
    inputSchema: { workItemId: workItemIdSchema },
  },
  async ({ workItemId }) => {
    try {
      return jsonResult(await timerService.markDone(workItemId));
    } catch (e) {
      return errorResult(e instanceof Error ? e.message : String(e));
    }
  },
);

/* ============================================================ */
/*  Edit tool                                                    */
/* ============================================================ */

server.registerTool(
  'workitem_edit',
  {
    title: 'Edit work item fields',
    description:
      "Update a work item in Azure DevOps. State uses Moran's plain English buckets: 'waiting' (New/To Do/Proposed), 'going' (Active/In Progress/Doing), 'done' (Closed/Done/Resolved). Effort fields are in hours; 1 ADO point = 1 hour by team convention.",
    inputSchema: {
      workItemId: workItemIdSchema,
      state: z.enum(['waiting', 'going', 'done']).optional(),
      originalEstimate: z.number().min(0).optional().describe('In hours.'),
      remainingWork: z.number().min(0).optional().describe('In hours.'),
    },
  },
  async ({ workItemId, state, originalEstimate, remainingWork }) => {
    if (state == null && originalEstimate == null && remainingWork == null) {
      return errorResult('At least one of state, originalEstimate, remainingWork is required.');
    }
    const applied: { state?: string; originalEstimate?: number; remainingWork?: number } = {};
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
      return jsonResult({ applied });
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
      "Open a session against a work item. Tells sprint-helper that Moran is now working on this item with you. Returns a sessionId you'll pass to later session_log / session_end calls. Idempotent — returns the existing session if one is already open.",
    inputSchema: {
      workItemId: workItemIdSchema,
      client: z
        .string()
        .optional()
        .describe('Optional client identifier. Defaults to "claude-code".'),
    },
  },
  async ({ workItemId, client }) =>
    jsonResult(startSession({ workItemId, client })),
);

server.registerTool(
  'session_log',
  {
    title: 'Log a session event',
    description:
      "Record an event in an open session. Types: 'focus' (switching attention), 'summary' (what got done so far), 'blocker' (something getting in the way), 'decision' (a tradeoff Moran chose), 'note' (anything else). These surface in her Day dashboard.",
    inputSchema: {
      sessionId: z.string().describe('Session id returned by session_start.'),
      type: z.enum(['focus', 'summary', 'blocker', 'decision', 'note']),
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
      'Close a session, optionally with a final summary of what got done. Surfaces in her dashboard and feeds future Demo prep recall.',
    inputSchema: {
      sessionId: z.string(),
      summary: z.string().optional(),
    },
  },
  async ({ sessionId, summary }) => {
    const result = endSession({ sessionId, summary });
    if (!result) return errorResult(`Session not found: ${sessionId}`);
    return jsonResult(result);
  },
);

/* ============================================================ */
/*  Boot                                                         */
/* ============================================================ */

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stdio transport keeps the process alive; nothing else needed.
}

main().catch(err => {
  // eslint-disable-next-line no-console
  console.error('sprint-helper MCP server crashed:', err);
  process.exit(1);
});
