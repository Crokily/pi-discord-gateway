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
import { computeEffectiveChannelSettings } from './channel-settings.js';

/** Channels currently being processed (per-channel serial lock) */
const activeChannels = new Set<string>();
let running = false;
let activeTasks = 0;

export function isChannelProcessing(jid: string): boolean {
  return activeChannels.has(jid);
}

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
    processMessage(jid, msg.rowid, msg.sender_name, msg.content, msg.attachments)
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
  attachments?: string | null,
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
  let cancelTypingDelay = () => {};
  const stopTypingLoop = async () => {
    typingAlive = false;
    cancelTypingDelay();
    await typingPromise;
  };
  const typingLoop = async () => {
    while (typingAlive) {
      await setTyping(jid);
      if (!typingAlive) break;
      const delay = cancellableSleep(8000);
      cancelTypingDelay = delay.cancel;
      await delay.promise;
      cancelTypingDelay = () => {};
    }
  };
  const typingPromise = typingLoop();

  try {
    // Prepend sender name for context
    const prompt = `[Discord user: ${senderName}]\n${content}`;

    logMessage(jid, 'user', content);

    const effective = computeEffectiveChannelSettings(channel);

    const result = await invokeAgent(channel.folder, prompt, {
      model: effective.rawModelRef || undefined,
      thinking: effective.hasManagedThinking ? effective.effectiveThinking : undefined,
      attachments,
    });

    await stopTypingLoop();

    if (result.ok) {
      const sent = await sendResponse(jid, result.text);
      if (!sent) {
        markMessageFailed(rowid);
        logger.warn({ jid }, 'Agent response generated but could not be delivered to Discord');
        return;
      }

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
    await stopTypingLoop();
    logger.error({ jid, err: err.message }, 'processMessage failed');
    markMessageFailed(rowid);
    try {
      await sendResponse(jid, `⚠️ Internal error: ${err.message?.slice(0, 200)}`);
    } catch {
      // nothing we can do
    }
  }
}

function cancellableSleep(ms: number): { promise: Promise<void>; cancel: () => void } {
  let finished = false;
  let timer: NodeJS.Timeout | undefined;
  let resolvePromise: () => void = () => {};

  const promise = new Promise<void>((resolve) => {
    resolvePromise = () => {
      if (finished) return;
      finished = true;
      if (timer) clearTimeout(timer);
      resolve();
    };

    timer = setTimeout(resolvePromise, ms);
  });

  return {
    promise,
    cancel: resolvePromise,
  };
}
