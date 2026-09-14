import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ThreadInfo, ThreadTransport } from '../src/discord/threads.js';
import type { RegisteredChannel } from '../src/types.js';

vi.mock('../src/agent/model-catalog.js', async (original) => ({
  ...(await original<typeof import('../src/agent/model-catalog.js')>()),
  scheduleCatalogRefresh: () => {},
}));
let db: typeof import('../src/db.js');
let folder: string;
const env = { ...process.env };
const channel: RegisteredChannel = {
  jid: 'dc:parent',
  folder: 'parent',
  name: 'Parent',
  requiresTrigger: true,
  isMain: false,
  modelOverride: 'test/alpha',
  thinkingOverride: 'high',
  cwdOverride: '/first',
};
beforeEach(async () => {
  folder = mkdtempSync(join(tmpdir(), 'piscord-recovery-'));
  vi.stubEnv('DB_PATH', join(folder, 'gateway.db'));
  vi.stubEnv('SESSIONS_DIR', join(folder, 'sessions'));
  vi.stubEnv('LOG_LEVEL', 'silent');
  vi.resetModules();
  db = await import('../src/db.js');
  db.initDb();
  db.registerChannel(channel);
});
afterEach(async () => {
  db.closeDb();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(folder, { recursive: true, force: true });
});
function enqueue(extra: Partial<Parameters<typeof db.enqueueMessage>[0]> = {}) {
  return db.enqueueMessage({
    channelJid: channel.jid,
    sender: 'alice',
    senderName: 'Alice',
    content: 'Please inspect this',
    timestamp: new Date().toISOString(),
    ...extra,
  });
}

describe('durable recovery', () => {
  it('waits for rate-limit reset and keeps later work behind the saved answer', async () => {
    const { deliverResponse } = await import('../src/discord/delivery.js');
    const id = enqueue();
    db.claimNextMessage(channel.jid);
    db.saveResponse(id, 'answer', ['answer']);
    const later = enqueue();
    const now = Date.now();
    const io = {
      send: vi
        .fn()
        .mockRejectedValue(
          Object.assign(new Error('rate limited'), { name: 'RateLimitError', timeToReset: 10000 }),
        ),
      find: vi.fn(),
    };
    await deliverResponse(id, io, new AbortController().signal);
    expect(db.getQueuedMessage(id)?.next_attempt_at).toBeGreaterThanOrEqual(now + 10500);
    expect(db.getResponseChunks(id)[0].status).toBe('pending');
    expect(db.claimNextMessage(channel.jid)).toBeUndefined();
    db.retryDelivery(id, 0);
    io.send.mockResolvedValue('accepted');
    expect(await deliverResponse(id, io, new AbortController().signal)).toBe(true);
    db.markMessageDone(id);
    expect(db.claimNextMessage(channel.jid)?.rowid).toBe(later);
  });

  it('renews the retry budget after confirmed progress through a long answer', async () => {
    const { deliverResponse } = await import('../src/discord/delivery.js');
    const id = enqueue();
    db.claimNextMessage(channel.jid);
    db.saveResponse(id, 'one two three', ['one', 'two', 'three']);
    const failed = new Set<string>();
    const io = {
      send: vi.fn(async (_jid: string, content: string) => {
        if (!failed.has(content)) {
          failed.add(content);
          throw new Error('temporary network error');
        }
        return `sent-${content}`;
      }),
      find: vi.fn().mockResolvedValue(undefined),
    };
    const signal = new AbortController().signal;
    for (let attempt = 0; attempt < 3; attempt++)
      expect(await deliverResponse(id, io, signal)).toBe(false);
    expect(await deliverResponse(id, io, signal)).toBe(true);
    expect(io.send).toHaveBeenCalledTimes(6);
  });
  it('preserves pending work and saved answers, interrupts unknown execution, and never revives cancellation', () => {
    const interrupted = enqueue();
    db.claimNextMessage(channel.jid);
    const delivery = enqueue();
    db.claimNextMessage(channel.jid);
    db.saveResponse(delivery, 'answer', ['answer']);
    const cancelled = enqueue();
    db.setMessageState(cancelled, 'cancelled');
    const pending = enqueue();
    db.closeDb();
    db.initDb();
    expect(db.recoverStuckMessages()).toBe(1);
    expect(db.getQueuedMessage(interrupted)?.status).toBe('interrupted');
    expect(db.getQueuedMessage(delivery)).toMatchObject({
      status: 'delivering',
      response_text: 'answer',
    });
    expect(db.getQueuedMessage(cancelled)?.status).toBe('cancelled');
    expect(db.getQueuedMessage(pending)?.status).toBe('pending');
    expect(db.pendingNotices()).toHaveLength(1);
    expect(db.recoverStuckMessages()).toBe(0);
  });
  it('resumes only unsent answer chunks after reopening the database', async () => {
    const { deliverResponse } = await import('../src/discord/delivery.js');
    const id = enqueue();
    db.claimNextMessage(channel.jid);
    db.saveResponse(id, 'first second', ['first', 'second']);
    const send = vi
      .fn()
      .mockResolvedValueOnce('discord-first')
      .mockRejectedValueOnce(Object.assign(new Error('network timeout'), { status: 504 }))
      .mockResolvedValue('discord-second');
    const io = { send, find: vi.fn().mockResolvedValue(undefined) };
    expect(await deliverResponse(id, io, new AbortController().signal)).toBe(false);
    db.closeDb();
    db.initDb();
    db.recoverStuckMessages();
    expect(await deliverResponse(id, io, new AbortController().signal)).toBe(true);
    expect(send.mock.calls.map((call) => call[1])).toEqual(['first', 'second', 'second']);
    expect(send.mock.calls[1][2]).toBe(send.mock.calls[2][2]);
    expect(db.getResponseChunks(id).every((chunk) => chunk.status === 'sent')).toBe(true);
  });
  it('reconciles accepted sends and stops uncertain sends outside the nonce window', async () => {
    const { deliverResponse } = await import('../src/discord/delivery.js');
    const id = enqueue();
    db.claimNextMessage(channel.jid);
    db.saveResponse(id, 'answer', ['answer']);
    db.beginChunk(id, 0);
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now + 180_000);
    const io = { send: vi.fn(), find: vi.fn().mockResolvedValue(undefined) };
    expect(await deliverResponse(id, io, new AbortController().signal)).toBe(false);
    expect(db.getQueuedMessage(id)?.status).toBe('delivery_uncertain');
    expect(io.send).not.toHaveBeenCalled();
    db.setMessageState(id, 'delivering');
    io.find.mockResolvedValue('accepted-before-crash');
    expect(await deliverResponse(id, io, new AbortController().signal)).toBe(true);
    expect(io.send).not.toHaveBeenCalled();
  });
  it('preserves cancellation when an in-flight Discord request fails later', async () => {
    const { deliverResponse } = await import('../src/discord/delivery.js');
    const id = enqueue();
    db.claimNextMessage(channel.jid);
    db.saveResponse(id, 'answer', ['answer']);
    const controller = new AbortController();
    const io = {
      find: vi.fn().mockResolvedValue(undefined),
      send: vi.fn(async () => {
        db.setMessageState(id, 'cancelled');
        controller.abort('user');
        throw Object.assign(new Error('Forbidden'), { status: 403 });
      }),
    };
    expect(await deliverResponse(id, io, controller.signal)).toBe(false);
    expect(db.getQueuedMessage(id)?.status).toBe('cancelled');
    expect(db.pendingNotices()).toHaveLength(0);
  });
  it('stops retries for permissions and honours cancellation between chunks', async () => {
    const { deliverResponse } = await import('../src/discord/delivery.js');
    const id = enqueue();
    db.claimNextMessage(channel.jid);
    db.saveResponse(id, 'answer', ['one', 'two']);
    const io = {
      send: vi.fn().mockRejectedValue(Object.assign(new Error('forbidden'), { status: 403 })),
      find: vi.fn().mockResolvedValue(undefined),
    };
    await deliverResponse(id, io, new AbortController().signal);
    expect(db.getQueuedMessage(id)?.status).toBe('delivery_failed');
    const controller = new AbortController();
    db.setMessageState(id, 'delivering');
    io.send.mockImplementation(async () => {
      controller.abort();
      return 'one';
    });
    await deliverResponse(id, io, controller.signal);
    expect(io.send).toHaveBeenCalledTimes(2);
    expect(db.getResponseChunks(id)[1].status).toBe('pending');
  });
});

function threadTransport() {
  const threads = new Map<string, ThreadInfo>();
  const io: ThreadTransport = {
    get: vi.fn(async (id) => {
      if (id === 'parent') return { id, name: 'Parent', isThread: false, textParent: true };
      const found = threads.get(id);
      if (!found) throw Object.assign(new Error('Unknown Channel'), { code: 10003 });
      return found;
    }),
    create: vi.fn(async (parentId, anchorId) => {
      const value = {
        id: anchorId,
        name: 'Conversation',
        parentId,
        isThread: true,
        textParent: false,
      };
      threads.set(anchorId, value);
      return value;
    }),
    sendAnchor: vi.fn(async () => 'scheduled-starter'),
    findAnchor: vi.fn(async () => undefined),
  };
  return { io, threads };
}
describe('conversation threads', () => {
  it('cancels a starter still being routed when stop is issued in its new thread', async () => {
    db.setChannelThreadMode(channel.jid, 'auto');
    const id = enqueue({ sourceMessageId: 'question' });
    const pending = db.claimNextMessage(channel.jid)!;
    const { routeQueuedMessage } = await import('../src/discord/threads.js');
    const { io } = threadTransport();
    await io.create('parent', 'question', 'Created before routing finished');
    expect(db.clearPendingMessages('dc:question')).toBe(1);
    await routeQueuedMessage(pending, new AbortController().signal, io);
    expect(db.getQueuedMessage(id)?.status).toBe('cancelled');
    expect(db.claimNextMessage('dc:question')).toBeUndefined();
  });
  it('defaults off and routes the original question and attachments exactly once', async () => {
    expect(db.getChannel(channel.jid)?.threadMode).toBe('off');
    db.setChannelThreadMode(channel.jid, 'auto');
    const id = enqueue({ sourceMessageId: 'question', attachments: '[{"name":"file.txt"}]' });
    expect(enqueue({ sourceMessageId: 'question' })).toBe(0);
    const message = db.claimNextMessage(channel.jid)!;
    const { routeQueuedMessage } = await import('../src/discord/threads.js');
    const { io } = threadTransport();
    await routeQueuedMessage(message, new AbortController().signal, io);
    expect(db.getQueuedMessage(id)).toMatchObject({
      status: 'pending',
      channel_jid: 'dc:question',
      attachments: '[{"name":"file.txt"}]',
    });
    expect(db.getChannel('dc:question')).toMatchObject({
      parentJid: channel.jid,
      folder: 'ch_question',
      requiresTrigger: false,
    });
    expect(io.sendAnchor).not.toHaveBeenCalled();
    expect(db.claimNextMessage('dc:question')?.rowid).toBe(id);
  });
  it('uses the same routing for schedules and reuses a thread after a routing crash', async () => {
    db.setChannelThreadMode(channel.jid, 'auto');
    const id = enqueue({ sender: 'scheduler' });
    const message = db.claimNextMessage(channel.jid)!;
    const { routeQueuedMessage } = await import('../src/discord/threads.js');
    const { io } = threadTransport();
    await routeQueuedMessage(message, new AbortController().signal, io);
    expect(io.sendAnchor).toHaveBeenCalledTimes(1);
    expect(db.getQueuedMessage(id)?.channel_jid).toBe('dc:scheduled-starter');
    const id2 = enqueue({ sourceMessageId: 'user-question' });
    const second = db.claimNextMessage(channel.jid)!;
    await io.create('parent', 'user-question', 'Created before crash');
    await routeQueuedMessage(second, new AbortController().signal, io);
    expect(db.getQueuedMessage(id2)?.channel_jid).toBe('dc:user-question');
    expect(io.create).toHaveBeenCalledTimes(2);
  });
  it('does not let a fast thread follow-up overtake its original question', () => {
    db.setChannelThreadMode(channel.jid, 'auto');
    const id = enqueue({ sourceMessageId: 'question' });
    db.claimNextMessage(channel.jid);
    db.registerChannel({
      ...channel,
      jid: 'dc:question',
      folder: 'ch_question',
      parentJid: channel.jid,
    });
    const followup = enqueue({ channelJid: 'dc:question', routeThread: false });
    expect(db.claimNextMessage('dc:question')).toBeUndefined();
    db.routeMessageToThread(id, db.getChannel('dc:question')!);
    expect(db.claimNextMessage('dc:question')?.rowid).toBe(id);
    db.markMessageDone(id);
    expect(db.claimNextMessage('dc:question')?.rowid).toBe(followup);
  });
  it('inherits parent settings dynamically while preserving explicit thread overrides', async () => {
    const child = {
      ...channel,
      jid: 'dc:child',
      folder: 'child',
      parentJid: channel.jid,
      modelOverride: '',
      thinkingOverride: '' as const,
      cwdOverride: '',
    };
    db.registerChannel(child);
    const { computeEffectiveChannelSettings } = await import('../src/agent/channel-settings.js');
    expect(computeEffectiveChannelSettings(child)).toMatchObject({
      rawModelRef: 'test/alpha',
      modelSource: 'parent',
      effectiveCwd: '/first',
      effectiveThinking: 'high',
    });
    db.setChannelModelOverride(channel.jid, 'test/beta');
    expect(computeEffectiveChannelSettings(child).rawModelRef).toBe('test/beta');
    db.setChannelModelOverride(child.jid, 'test/own');
    expect(computeEffectiveChannelSettings(db.getChannel(child.jid)!).rawModelRef).toBe('test/own');
    db.clearChannelModelOverride(child.jid);
    expect(computeEffectiveChannelSettings(db.getChannel(child.jid)!).rawModelRef).toBe(
      'test/beta',
    );
    expect(process.env.HOME).toBe(env.HOME);
  });
  it('keeps denied thread creation from invoking or rerouting the task', async () => {
    db.setChannelThreadMode(channel.jid, 'auto');
    const id = enqueue({ sourceMessageId: 'question' });
    const { routeQueuedMessage } = await import('../src/discord/threads.js');
    const { io } = threadTransport();
    io.create = vi.fn().mockRejectedValue(Object.assign(new Error('Forbidden'), { status: 403 }));
    await expect(
      routeQueuedMessage(db.claimNextMessage(channel.jid)!, new AbortController().signal, io),
    ).rejects.toThrow('Forbidden');
    expect(db.getQueuedMessage(id)).toMatchObject({ status: 'routing', channel_jid: channel.jid });
    expect(db.getChannel('dc:question')).toBeUndefined();
  });
  it('cancels pending work and disables schedules when a thread is deleted', async () => {
    db.registerChannel({ ...channel, jid: 'dc:child', folder: 'child', parentJid: channel.jid });
    const id = enqueue({ channelJid: 'dc:child' });
    db.addScheduledTask({
      name: 'report',
      type: 'recurring',
      schedule: '0 * * * *',
      channelJid: 'dc:child',
      prompt: 'report',
      nextRunAt: new Date().toISOString(),
    });
    const { handleThreadDeleted } = await import('../src/discord/threads.js');
    handleThreadDeleted('child');
    expect(db.getQueuedMessage(id)?.status).toBe('cancelled');
    expect(db.getChannel('dc:child')?.deletedAt).toBeTruthy();
    expect(db.listScheduledTasks()[0].enabled).toBe(0);
  });
});
