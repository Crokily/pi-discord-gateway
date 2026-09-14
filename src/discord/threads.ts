import {
  attachThreadParent,
  clearPendingMessages,
  getAllChannels,
  getChannel,
  getQueuedMessage,
  markThreadDeleted,
  registerChannel,
  removeDeletedThread,
  routeMessageToThread,
  routingAnchor,
  setRoutingAnchor,
} from '../db.js';
import { abortChannelTask, isChannelProcessing } from '../agent/queue.js';
import { rotateChannelSessionDir } from '../session/path.js';
import type { QueuedMessage, RegisteredChannel } from '../types.js';
import { logger } from '../logger.js';

export interface ThreadInfo {
  id: string;
  name: string;
  parentId?: string;
  isThread: boolean;
  textParent: boolean;
}
export interface ThreadTransport {
  get(id: string): Promise<ThreadInfo>;
  create(parentId: string, anchorId: string, name: string): Promise<ThreadInfo>;
  sendAnchor(jid: string, text: string, nonce: string): Promise<string>;
  findAnchor(jid: string, nonce: string): Promise<string | undefined>;
}
let transport: ThreadTransport | undefined;
export function setThreadTransport(value: ThreadTransport): void {
  transport = value;
}

export async function routeQueuedMessage(
  message: QueuedMessage,
  signal: AbortSignal,
  io = transport,
): Promise<void> {
  if (!io) throw new Error('Discord is not ready');
  signal.throwIfAborted();
  const parentId = message.channel_jid.replace(/^dc:/, '');
  const parent = await io.get(parentId);
  if (!parent.textParent)
    throw new Error('Automatic threads require a regular server text channel');
  let anchorId = message.source_message_id || message.anchor_message_id;
  if (!anchorId) {
    const anchor = routingAnchor(message.rowid);
    anchorId =
      (await io.findAnchor(message.channel_jid, anchor.nonce).catch(() => undefined)) ?? null;
    signal.throwIfAborted();
    if (!anchorId && Date.now() - anchor.sendingAt > 120_000)
      throw new Error('The scheduled-task starter message could not be confirmed');
    anchorId ??= await io.sendAnchor(
      message.channel_jid,
      `Scheduled conversation · task #${message.rowid}`,
      anchor.nonce,
    );
    setRoutingAnchor(message.rowid, anchorId);
  }
  signal.throwIfAborted();
  let thread: ThreadInfo;
  try {
    thread = await io.get(anchorId);
  } catch (error) {
    if (!isUnknownChannel(error)) throw error;
    try {
      thread = await io.create(
        parentId,
        anchorId,
        message.content.split(/\r?\n/)[0].slice(0, 90) || 'Pi conversation',
      );
    } catch (createError) {
      // A previous request may have created it before its response was lost.
      try {
        thread = await io.get(anchorId);
      } catch {
        throw createError;
      }
    }
  }
  signal.throwIfAborted();
  if (!thread.isThread || thread.parentId !== parentId)
    throw new Error('Unexpected thread destination');
  if (getQueuedMessage(message.rowid)?.status !== 'routing') return;
  const existing = getChannel(`dc:${thread.id}`);
  routeMessageToThread(message.rowid, {
    jid: `dc:${thread.id}`,
    name: thread.name,
    folder: existing?.folder || `ch_${thread.id}`,
    requiresTrigger: false,
    isMain: false,
    modelOverride: '',
    thinkingOverride: '',
    cwdOverride: '',
    parentJid: message.channel_jid,
    threadMode: 'off',
    managedThread: true,
  });
}

export function registerIncomingThread(
  jid: string,
  name: string,
  parentId: string,
  existing?: RegisteredChannel,
  requiresTrigger = true,
): RegisteredChannel {
  const parentJid = `dc:${parentId}`;
  if (existing) {
    attachThreadParent(jid, parentJid);
    return getChannel(jid)!;
  }
  const channel: RegisteredChannel = {
    jid,
    name,
    folder: `ch_${jid.replace(/^dc:/, '')}`,
    requiresTrigger,
    isMain: false,
    modelOverride: '',
    thinkingOverride: '',
    cwdOverride: '',
    parentJid,
  };
  registerChannel(channel);
  return getChannel(jid)!;
}

export function isUnknownChannel(error: unknown): boolean {
  return (error as { code?: number })?.code === 10003;
}

export function handleThreadDeleted(id: string): void {
  const jid = `dc:${id}`;
  if (!getChannel(jid)) {
    clearPendingMessages(jid);
    return;
  }
  abortChannelTask(jid);
  markThreadDeleted(jid);
}

/** Reconcile missed delete events and archive files only after active work has drained. */
export function startThreadMaintenance(): () => Promise<void> {
  let stopped = false;
  let work: Promise<void> | undefined;
  const tick = () => {
    if (work || stopped || !transport) return;
    work = (async () => {
      for (const channel of getAllChannels().filter((ch) => ch.parentJid)) {
        if (stopped) break;
        if (!channel.deletedAt) {
          try {
            await transport!.get(channel.jid.replace(/^dc:/, ''));
          } catch (error) {
            if (isUnknownChannel(error)) handleThreadDeleted(channel.jid.replace(/^dc:/, ''));
          }
        }
        if (getChannel(channel.jid)?.deletedAt && !isChannelProcessing(channel.jid)) {
          rotateChannelSessionDir(channel.folder);
          removeDeletedThread(channel.jid);
        }
      }
    })()
      .catch((err) => logger.warn({ err }, 'Thread cleanup failed'))
      .finally(() => {
        work = undefined;
      });
  };
  tick();
  const timer = setInterval(tick, 60 * 60_000);
  return async () => {
    stopped = true;
    clearInterval(timer);
    await work;
  };
}
