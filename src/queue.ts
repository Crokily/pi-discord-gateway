/**
 * Message processing loop.
 *
 * Polls SQLite for pending messages, dispatches to pi agent, sends response
 * back to Discord. Enforces per-channel serial processing and global
 * concurrency limit.
 */

import { config } from './config.js';
import { logger } from './logger.js';
import {
  channelsWithPending,
  claimNextMessage,
  markMessageDone,
  markMessageFailed,
  recoverStuckMessages,
  logMessage,
  getChannel,
} from './db.js';
import { invokeAgent } from './agent.js';
import { sendResponse, setTyping } from './discord.js';

/** Channels currently being processed (per-channel serial lock) */
const activeChannels = new Set<string>();
let running = false;
let activeTasks = 0;

export function startProcessingLoop(): void {
  running = true;

  // Recover any messages stuck in 'processing' from a previous crash
  const recovered = recoverStuckMessages();
  if (recovered > 0) {
    logger.info({ count: recovered }, 'Recovered stuck messages');
  }

  poll();
}

export function stopProcessingLoop(): void {
  running = false;
}

function poll(): void {
  if (!running) return;

  try {
    dispatch();
  } catch (err: any) {
    logger.error({ err: err.message }, 'Poll error');
  }

  setTimeout(poll, config.pollInterval);
}

function dispatch(): void {
  // Find channels with pending messages that aren't already being processed
  const pending = channelsWithPending();

  for (const jid of pending) {
    if (activeChannels.has(jid)) continue; // already processing this channel
    if (activeTasks >= config.maxConcurrency) break; // global concurrency limit

    const msg = claimNextMessage(jid);
    if (!msg) continue;

    activeChannels.add(jid);
    activeTasks++;

    // Fire and forget — processMessage handles its own errors
    processMessage(jid, msg.rowid, msg.sender_name, msg.content)
      .finally(() => {
        activeChannels.delete(jid);
        activeTasks--;
      });
  }
}

async function processMessage(
  jid: string,
  rowid: number,
  senderName: string,
  content: string,
): Promise<void> {
  const channel = getChannel(jid);
  if (!channel) {
    logger.warn({ jid }, 'Channel disappeared during processing');
    markMessageFailed(rowid);
    return;
  }

  logger.info({ jid, senderName, len: content.length }, 'Processing message');

  // Typing indicator (repeat every 8s while agent runs)
  let typingAlive = true;
  const typingLoop = async () => {
    while (typingAlive) {
      await setTyping(jid);
      await sleep(8000);
    }
  };
  const typingPromise = typingLoop();

  try {
    // Prepend sender name for context
    const prompt = `[Discord user: ${senderName}]\n${content}`;

    logMessage(jid, 'user', content);

    const result = await invokeAgent(channel.folder, prompt);

    typingAlive = false;
    await typingPromise;

    if (result.ok) {
      await sendResponse(jid, result.text);
      logMessage(jid, 'assistant', result.text);
      markMessageDone(rowid);
      logger.info({ jid, responseLen: result.text.length }, 'Message processed');
    } else {
      const errMsg = `⚠️ Agent error: ${result.error?.slice(0, 300) || 'unknown error'}`;
      await sendResponse(jid, errMsg);
      markMessageFailed(rowid);
      logger.warn({ jid, error: result.error }, 'Agent returned error');
    }
  } catch (err: any) {
    typingAlive = false;
    await typingPromise;
    logger.error({ jid, err: err.message }, 'processMessage failed');
    markMessageFailed(rowid);
    try {
      await sendResponse(jid, `⚠️ Internal error: ${err.message?.slice(0, 200)}`);
    } catch {
      // nothing we can do
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
