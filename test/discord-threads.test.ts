import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ client: undefined as any }));
vi.mock('discord.js', async (original) => {
  const actual = await original<typeof import('discord.js')>();
  const { EventEmitter } = await import('node:events');
  class Client extends EventEmitter {
    user = { id: 'bot', tag: 'Pi#1' };
    constructor() {
      super();
      state.client = this;
    }
    async login() {
      queueMicrotask(() => this.emit(actual.Events.ClientReady, this));
    }
    destroy() {}
  }
  class REST {
    setToken() {
      return this;
    }
  }
  return { ...actual, Client, REST };
});
vi.mock('../src/discord/slash-commands.js', () => ({
  registerGlobalCommands: async () => {},
  handleAutocomplete: async () => {},
  handleChatCommand: async () => {},
}));
let db: typeof import('../src/db.js');
let discord: typeof import('../src/discord/client.js');
beforeEach(() => {
  vi.stubEnv('DB_PATH', ':memory:');
  vi.stubEnv('LOG_LEVEL', 'silent');
  vi.stubEnv('TRIGGER_NAME', 'pi');
  vi.stubEnv('EXCLUDED_CHANNELS', '');
  vi.resetModules();
});
afterEach(() => {
  discord?.stopDiscord();
  db?.closeDb();
  vi.unstubAllEnvs();
});
async function boot(policy: string) {
  vi.stubEnv('CHANNEL_POLICY', policy);
  db = await import('../src/db.js');
  db.initDb();
  discord = await import('../src/discord/client.js');
  await discord.startDiscord();
}
function message(id: string, content: string, thread = false) {
  return {
    id,
    content,
    channelId: thread ? 'thread' : 'parent',
    channel: {
      name: 'Conversation',
      parentId: thread ? 'parent' : null,
      isThread: () => thread,
      messages: { fetch: async () => ({ author: { displayName: 'Pi' } }) },
    },
    guild: { name: 'Guild' },
    author: { id: 'alice', username: 'Alice', bot: false },
    mentions: { users: new Map() },
    attachments: new Map(),
    createdAt: new Date(),
  };
}
async function receive(value: ReturnType<typeof message> & { reference?: { messageId: string } }) {
  state.client.emit('messageCreate', value);
  await new Promise((resolve) => setImmediate(resolve));
}
function parent() {
  db.registerChannel({
    jid: 'dc:parent',
    name: 'Parent',
    folder: 'parent',
    requiresTrigger: true,
    isMain: false,
    modelOverride: 'test/parent',
    thinkingOverride: 'high',
    cwdOverride: '/project',
  });
}
describe('Discord thread reception', () => {
  it('ignores Discord system notices instead of adopting a manually created thread', async () => {
    await boot('allowlist');
    parent();
    db.registerChannel({ ...db.getChannel('dc:parent')!, requiresTrigger: false });
    db.setChannelThreadMode('dc:parent', 'auto');
    await receive({ ...message('thread', 'manual-thread-name'), system: true } as ReturnType<
      typeof message
    >);
    expect(db.channelsWithPending()).toEqual([]);
    await receive(message('manual-question', 'hello', true));
    expect(db.getChannel('dc:thread')).toBeUndefined();
  });

  it('keeps automatic threads off and preserves the existing open-channel behavior', async () => {
    await boot('open');
    await receive(message('first', 'hello'));
    expect(db.getChannel('dc:parent')?.threadMode).toBe('off');
    expect(db.claimNextMessage('dc:parent')).toMatchObject({
      status: 'processing',
      route_thread: 0,
      content: 'hello',
    });
  });
  it('accepts manual threads in open mode and records their parent for settings inheritance', async () => {
    await boot('open');
    parent();
    await receive(message('first', 'hello', true));
    expect(db.getChannel('dc:thread')).toMatchObject({
      parentJid: 'dc:parent',
      requiresTrigger: false,
      modelOverride: '',
    });
    expect(db.claimNextMessage('dc:thread')?.status).toBe('processing');
  });
  it('keeps manual threads separately allowlisted while accepting managed-thread follow-ups', async () => {
    await boot('allowlist');
    parent();
    await receive(message('manual', 'hello', true));
    expect(db.getChannel('dc:thread')).toBeUndefined();
    db.setChannelThreadMode('dc:parent', 'auto');
    await receive(message('thread', '@pi question'));
    db.claimNextMessage('dc:parent');
    await receive(message('followup', 'more detail', true));
    expect(db.getChannel('dc:thread')?.requiresTrigger).toBe(false);
    expect(db.claimNextMessage('dc:thread')).toBeUndefined();
  });
  it('requires mentions in ordinary open-trigger threads and accepts explicitly mentioned replies', async () => {
    await boot('open-trigger');
    await receive(message('ignored', 'hello', true));
    expect(db.channelsWithPending()).toEqual([]);
    await receive({
      ...message('accepted', '<@bot> hello', true),
      reference: { messageId: 'old' },
    });
    expect(db.claimNextMessage('dc:thread')?.content).toBe('[Reply to Pi] hello');
  });
  it('does not auto-register a thread under an excluded parent', async () => {
    vi.stubEnv('EXCLUDED_CHANNELS', 'parent');
    await boot('open');
    await receive(message('ignored', 'hello', true));
    expect(db.getChannel('dc:thread')).toBeUndefined();
  });
});
