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
const activeTaskPromises = new Set<Promise<void>>();
const activeTaskControllers = new Map<number, AbortController>();

let running = false;
let pollTimer: NodeJS.Timeout | undefined;
let stopPromise: Promise<void> | null = null;

export function isChannelProcessing(jid: string): boolean {
  return activeChannels.has(jid);
}

export function startProcessingLoop(): void {
  if (running) return;

  running = true;
  stopPromise = null;

  // Recover any messages stuck in 'processing' from a previous crash.
  const recovered = recoverStuckMessages();
  if (recovered > 0) {
    logger.info({ count: recovered }, 'Recovered stuck messages');
  }

  schedulePoll(0);
}

export function stopProcessingLoop(opts: { timeoutMs?: number } = {}): Promise<void> {
  if (stopPromise) {
    return stopPromise;
  }

  running = false;
  clearPollTimer();

  stopPromise = drainActiveTasks(opts.timeoutMs ?? config.shutdownTimeoutMs);
  return stopPromise;
}

function schedulePoll(delayMs = config.pollInterval): void {
  if (!running || pollTimer) return;

  pollTimer = setTimeout(() => {
    pollTimer = undefined;
    poll();
  }, delayMs);
}

function clearPollTimer(): void {
  if (!pollTimer) return;
  clearTimeout(pollTimer);
  pollTimer = undefined;
}

function poll(): void {
  if (!running) return;

  try {
    dispatch();
  } catch (err: any) {
    logger.error({ err: err.message }, 'Poll error');
  } finally {
    schedulePoll();
  }
}

function dispatch(): void {
  if (activeTaskPromises.size >= config.maxConcurrency) return;

  for (const jid of channelsWithPending()) {
    if (activeChannels.has(jid)) continue;
    if (activeTaskPromises.size >= config.maxConcurrency) break;

    const msg = claimNextMessage(jid);
    if (!msg) continue;

    const controller = new AbortController();
    activeChannels.add(jid);
    activeTaskControllers.set(msg.rowid, controller);

    const taskPromise = processMessage(
      jid,
      msg.rowid,
      msg.sender_name,
      msg.content,
      controller.signal,
      msg.attachments,
    ).finally(() => {
      activeChannels.delete(jid);
      activeTaskControllers.delete(msg.rowid);
      activeTaskPromises.delete(taskPromise);

      if (running) {
        schedulePoll(0);
      }
    });

    activeTaskPromises.add(taskPromise);
  }
}

async function drainActiveTasks(timeoutMs: number): Promise<void> {
  if (activeTaskPromises.size === 0) {
    return;
  }

  const initialDrain = Promise.allSettled([...activeTaskPromises]);
  const drainedGracefully = await waitForPromise(initialDrain, timeoutMs);
  if (drainedGracefully) {
    return;
  }

  logger.warn(
    { timeoutMs, activeTasks: activeTaskPromises.size },
    'Shutdown timeout reached; aborting in-flight message processing',
  );

  for (const controller of activeTaskControllers.values()) {
    controller.abort();
  }

  if (activeTaskPromises.size > 0) {
    await Promise.allSettled([...activeTaskPromises]);
  }
}

async function waitForPromise(promise: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  if (timeoutMs === 0) {
    return false;
  }

  let timer: NodeJS.Timeout | undefined;

  try {
    await Promise.race([
      promise,
      new Promise((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }

  return activeTaskPromises.size === 0;
}

async function processMessage(
  jid: string,
  rowid: number,
  senderName: string,
  content: string,
  signal: AbortSignal,
  attachments?: string | null,
): Promise<void> {
  const channel = getChannel(jid);
  if (!channel) {
    logger.warn({ jid }, 'Channel disappeared during processing');
    markMessageFailed(rowid);
    return;
  }

  logger.info({ jid, senderName, len: content.length }, 'Processing message');

  const typingLoop = createTypingLoop(jid);

  try {
    const prompt = `[Discord user: ${senderName}]\n${content}`;

    logMessage(jid, 'user', content);

    const effective = computeEffectiveChannelSettings(channel);

    const result = await invokeAgent(channel.folder, prompt, {
      model: effective.rawModelRef || undefined,
      thinking: effective.hasManagedThinking ? effective.effectiveThinking : undefined,
      signal,
      attachments,
    });

    if (signal.aborted) {
      markMessageFailed(rowid);
      logger.info({ jid, rowid }, 'Message abandoned: shutdown interrupted processing');
      return;
    }

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
      return;
    }

    const errMsg = `⚠️ Agent error: ${result.error?.slice(0, 300) || 'unknown error'}`;
    await sendResponse(jid, errMsg);
    markMessageFailed(rowid);
    logger.warn({ jid, error: result.error }, 'Agent returned error');
  } catch (err: any) {
    if (signal.aborted) {
      markMessageFailed(rowid);
      logger.info({ jid, rowid }, 'Message abandoned: shutdown interrupted processing');
      return;
    }

    logger.error({ jid, err: err.message }, 'processMessage failed');
    markMessageFailed(rowid);
    try {
      await sendResponse(jid, `⚠️ Internal error: ${err.message?.slice(0, 200)}`);
    } catch {
      // Nothing else to do here.
    }
  } finally {
    await typingLoop.stop();
  }
}

function createTypingLoop(jid: string): { stop: () => Promise<void> } {
  let typingAlive = true;
  let cancelTypingDelay = () => {};

  const loop = (async () => {
    while (typingAlive) {
      await setTyping(jid);
      if (!typingAlive) break;

      const delay = cancellableSleep(8000);
      cancelTypingDelay = delay.cancel;
      await delay.promise;
      cancelTypingDelay = () => {};
    }
  })();

  return {
    stop: async () => {
      typingAlive = false;
      cancelTypingDelay();
      await loop;
    },
  };
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
