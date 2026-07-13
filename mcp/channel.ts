/**
 * SPIKE (2026-07-13) — Claude Code Channels experiment. THROWAWAY.
 *
 * Proves whether sprint-helper can push an unprompted line INTO the chat that
 * spawned it (a channel reaches only its own session — see memory
 * project-channels-spike). Not a real feature yet; gated behind SH_CHANNEL_SPIKE
 * so it never fires in normal work chats.
 *
 * Mechanism (verified against @modelcontextprotocol/sdk types 2026-07-13):
 *  - declare capability `experimental['claude/channel']` BEFORE connect;
 *  - emit `notifications/claude/channel` with { content, meta } — Claude Code
 *    injects it as a <channel source="sprint-helper"> tag in the chat context.
 *  - The chat must be launched with `claude --channels server:sprint-helper
 *    --dangerously-load-development-channels` or the event is dropped silently.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

/** On when the env flag is set — keeps the spike out of real work chats. */
export function channelSpikeEnabled(): boolean {
  const v = process.env.SH_CHANNEL_SPIKE;
  return !!v && v.trim() !== '' && v.trim() !== '0' && v.trim().toLowerCase() !== 'false';
}

/**
 * SPIKE observability — append a timestamped line to ~/.sprint-helper/channel-spike.log
 * so we can see whether the code armed/fired even when nothing shows in the chat.
 * Tells apart "env var never reached the MCP child process" from "fired but the
 * chat dropped it". Best-effort; never throws.
 */
export function spikeLog(line: string): void {
  try {
    const dir = join(homedir(), '.sprint-helper');
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, 'channel-spike.log'), `${new Date().toISOString()} pid=${process.pid} ${line}\n`);
  } catch {
    /* ignore */
  }
}

/** Declare the channel capability. MUST run before server.connect(). */
export function registerChannelCapability(server: McpServer): void {
  server.server.registerCapabilities({
    experimental: { 'claude/channel': {} },
  });
}

/**
 * Push one line into the chat that owns this MCP process. Fire-and-forget:
 * resolves when written to the transport, NOT when Claude reads it. Dropped
 * silently if the chat didn't load the channel — so never rely on delivery.
 */
export async function pushChannel(
  server: McpServer,
  content: string,
  meta: Record<string, string> = {},
): Promise<void> {
  // The SDK's typed notification union doesn't include this custom method, so
  // cast — the transport sends whatever method string we give it.
  await (server.server.notification as (n: unknown) => Promise<void>)({
    method: 'notifications/claude/channel',
    params: { content, meta: { source: 'sprint-helper', ...meta } },
  });
}
