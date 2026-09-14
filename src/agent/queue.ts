/** SQLite queue: execute each conversation serially; resume saved delivery only. */
import { config } from '../config.js';
import { logger } from '../logger.js';
import {
  channelsWithPending,
  claimNextMessage,
  clearPendingMessages,
  markMessageDone,
  markMessageFailed,
  recoverStuckMessages,
  logMessage,
  getChannel,
  getQueuedMessage,
  saveResponse,
  setMessageState,
  pendingNotices,
  markNoticeSent,
  postponeNotice,
} from '../db.js';
import { invokeAgent } from './invoke.js';
import { sendResponse, sendDurableResponse, setTyping } from '../discord/client.js';
import { splitResponse } from '../discord/delivery.js';
import { routeQueuedMessage } from '../discord/threads.js';
import { computeEffectiveChannelSettings } from './channel-settings.js';
import type { QueuedMessage } from '../types.js';

const activeChannels = new Map<
  string,
  { controller: AbortController; promise: Promise<void>; rowid: number }
>();
let running = false;
let pollTimer: NodeJS.Timeout | undefined;
let stopPromise: Promise<void> | undefined;
let notices: Promise<void> | undefined;
let nextNoticeAt = 0;

export function isChannelProcessing(jid: string): boolean {
  return activeChannels.has(jid);
}
export function abortChannelTask(jid: string): { aborted: boolean; cleared: number } {
  const active = activeChannels.get(jid);
  if (active) {
    setMessageState(active.rowid, 'cancelled');
    active.controller.abort('user');
  }
  return { aborted: Boolean(active), cleared: clearPendingMessages(jid) };
}
export function startProcessingLoop(): void {
  if (running) return;
  running = true;
  stopPromise = undefined;
  const interrupted = recoverStuckMessages();
  if (interrupted)
    logger.warn({ interrupted }, 'Recorded interrupted tasks; execution will not be replayed');
  schedulePoll(0);
}
export function stopProcessingLoop(options: { timeoutMs?: number } = {}): Promise<void> {
  if (stopPromise) return stopPromise;
  running = false;
  clearTimeout(pollTimer);
  pollTimer = undefined;
  stopPromise = (async () => {
    let timer: NodeJS.Timeout | undefined;
    const all = Promise.allSettled([...activeChannels.values()].map((task) => task.promise));
    await Promise.race([
      all,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, options.timeoutMs ?? config.shutdownTimeoutMs);
      }),
    ]);
    if (timer) clearTimeout(timer);
    for (const active of activeChannels.values()) active.controller.abort('shutdown');
    // All process and delivery operations have their own bounds. Drain before closing SQLite.
    await all;
    await notices;
  })();
  return stopPromise;
}
function schedulePoll(delay = config.pollInterval): void {
  if (!running || pollTimer) return;
  pollTimer = setTimeout(() => {
    pollTimer = undefined;
    try {
      dispatch();
    } catch (err) {
      logger.error({ err }, 'Queue dispatch failed');
    }
    schedulePoll();
  }, delay);
}
function dispatch(): void {
  if (!running) return;
  if (!notices && Date.now() >= nextNoticeAt) {
    nextNoticeAt = Date.now() + 30_000;
    notices = (async () => {
      for (const notice of pendingNotices()) {
        if (!running) break;
        if (await sendResponse(notice.channel_jid, `⚠️ ${notice.notice_text}`))
          markNoticeSent(notice.rowid);
        else postponeNotice(notice.rowid);
      }
    })()
      .catch((err) => logger.warn({ err }, 'Task notices could not be delivered'))
      .finally(() => {
        notices = undefined;
      });
  }
  for (const jid of channelsWithPending()) {
    if (activeChannels.size >= config.maxConcurrency) break;
    if (activeChannels.has(jid)) continue;
    const message = claimNextMessage(jid);
    if (!message) continue;
    const controller = new AbortController();
    const promise = processMessage(message, controller.signal)
      .catch((err) => {
        logger.error({ err, rowid: message.rowid }, 'Task processing failed');
        const status = getQueuedMessage(message.rowid)?.status;
        if (status === 'processing')
          markMessageFailed(
            message.rowid,
            `Internal error: ${(err instanceof Error ? err.message : String(err)).slice(0, 200)}`,
          );
        if (status === 'delivering')
          setMessageState(
            message.rowid,
            'delivery_failed',
            `Delivery failed; the answer is saved. Use piscord result ${message.rowid}.`,
          );
      })
      .finally(() => {
        activeChannels.delete(jid);
        nextNoticeAt = 0;
        schedulePoll(0);
      });
    activeChannels.set(jid, { promise, controller, rowid: message.rowid });
  }
}
async function processMessage(message: QueuedMessage, signal: AbortSignal): Promise<void> {
  const jid = message.channel_jid;
  const channel = getChannel(jid);
  if (!channel || channel.deletedAt) {
    markMessageFailed(message.rowid, 'The destination channel is no longer available.');
    return;
  }
  if (message.status === 'routing') {
    try {
      await routeQueuedMessage(message, signal);
    } catch (err) {
      logger.warn({ err, rowid: message.rowid }, 'Thread creation failed');
      if (!signal.aborted)
        markMessageFailed(
          message.rowid,
          `Could not open a conversation thread for task #${message.rowid}. The task has not run. Check thread permissions and try again.`,
        );
    }
    return;
  }
  const typing = createTypingLoop(jid);
  try {
    if (message.status === 'processing') {
      const effective = computeEffectiveChannelSettings(channel);
      logMessage(jid, 'user', message.content);
      const result = await invokeAgent(
        channel.folder,
        `[Discord user: ${message.sender_name}]\n${message.content}`,
        {
          model: effective.rawModelRef || undefined,
          thinking: effective.hasManagedThinking ? effective.effectiveThinking : undefined,
          cwd: effective.effectiveCwd,
          signal,
          attachments: message.attachments,
        },
      );
      if (signal.aborted) {
        if (signal.reason !== 'user')
          setMessageState(
            message.rowid,
            'interrupted',
            'The gateway stopped during this task. Some operations may have completed; check before submitting it again.',
          );
        return;
      }
      if (!result.ok) {
        markMessageFailed(
          message.rowid,
          result.reason === 'timeout'
            ? result.error
            : `Agent error: ${result.error?.slice(0, 300) || 'unknown error'}`,
        );
        logger.warn({ rowid: message.rowid, error: result.error }, 'Agent returned an error');
        return;
      }
      saveResponse(message.rowid, result.text, splitResponse(result.text));
    }
    if (await sendDurableResponse(message.rowid, signal)) {
      const saved = getQueuedMessage(message.rowid);
      if (saved?.response_text) logMessage(jid, 'assistant', saved.response_text);
      markMessageDone(message.rowid);
    }
  } finally {
    typing.stop();
  }
}
function createTypingLoop(jid: string): { stop(): void } {
  let inFlight = false;
  const tick = () => {
    if (inFlight) return;
    inFlight = true;
    void setTyping(jid)
      .catch(() => {})
      .finally(() => {
        inFlight = false;
      });
  };
  tick();
  const timer = setInterval(tick, 8_000);
  return { stop: () => clearInterval(timer) };
}
