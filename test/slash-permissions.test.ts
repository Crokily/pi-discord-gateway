import {
  ChannelType,
  PermissionFlagsBits,
  PermissionsBitField,
  type ChatInputCommandInteraction,
} from 'discord.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../src/agent/model-catalog.js', async (original) => ({
  ...(await original<typeof import('../src/agent/model-catalog.js')>()),
  scheduleCatalogRefresh: () => {},
}));
let db: typeof import('../src/db.js');
let handle: (typeof import('../src/discord/slash-commands.js'))['handleChatCommand'];
beforeEach(async () => {
  vi.stubEnv('DB_PATH', ':memory:');
  vi.stubEnv('LOG_LEVEL', 'silent');
  vi.resetModules();
  db = await import('../src/db.js');
  db.initDb();
  ({ handleChatCommand: handle } = await import('../src/discord/slash-commands.js'));
  db.registerChannel({
    jid: 'dc:parent',
    name: 'Parent',
    folder: 'parent',
    requiresTrigger: true,
    isMain: false,
    modelOverride: 'provider/parent',
    thinkingOverride: 'high',
    cwdOverride: '',
  });
});
afterEach(() => {
  db.closeDb();
  vi.unstubAllEnvs();
});
function interaction(command = 'threads') {
  return {
    commandName: 'pi',
    channelId: 'parent',
    channel: { type: ChannelType.GuildText },
    guild: {},
    inGuild: () => true,
    memberPermissions: new PermissionsBitField(PermissionFlagsBits.ManageChannels),
    appPermissions: new PermissionsBitField([
      PermissionFlagsBits.CreatePublicThreads,
      PermissionFlagsBits.SendMessagesInThreads,
    ]),
    options: { getSubcommand: () => command, getBoolean: () => true },
    reply: vi.fn().mockResolvedValue(undefined),
    deferReply: vi.fn().mockResolvedValue(undefined),
    editReply: vi.fn().mockResolvedValue(undefined),
  };
}
async function invoke(value: ReturnType<typeof interaction>) {
  await handle(value as unknown as ChatInputCommandInteraction);
}
describe('slash command boundaries', () => {
  it('requires Manage Channels to enable automatic threads', async () => {
    const value = interaction();
    value.memberPermissions = new PermissionsBitField();
    await invoke(value);
    expect(db.getChannel('dc:parent')?.threadMode).toBe('off');
    expect(value.reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('Manage Channels') }),
    );
  });
  it.each([PermissionFlagsBits.CreatePublicThreads, PermissionFlagsBits.SendMessagesInThreads])(
    'requires both bot thread permissions (%s)',
    async (permission) => {
      const value = interaction();
      value.appPermissions = new PermissionsBitField(permission);
      await invoke(value);
      expect(db.getChannel('dc:parent')?.threadMode).toBe('off');
      expect(value.reply).toHaveBeenCalledWith(
        expect.objectContaining({ content: expect.stringContaining('The bot needs') }),
      );
    },
  );
  it('rejects configuration inside a thread', async () => {
    const value = interaction();
    value.channel.type = ChannelType.PublicThread;
    await invoke(value);
    expect(db.getChannel('dc:parent')?.threadMode).toBe('off');
    expect(value.reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('regular server text channel') }),
    );
  });
  it('can disable threads even after bot creation permissions are removed', async () => {
    const value = interaction();
    await invoke(value);
    expect(db.getChannel('dc:parent')?.threadMode).toBe('auto');
    value.options.getBoolean = () => false;
    value.appPermissions = new PermissionsBitField();
    await invoke(value);
    expect(db.getChannel('dc:parent')?.threadMode).toBe('off');
  });
  it('resets only the thread overrides and retains the parent defaults', async () => {
    db.registerChannel({
      ...db.getChannel('dc:parent')!,
      jid: 'dc:child',
      folder: 'child',
      parentJid: 'dc:parent',
      modelOverride: 'provider/child',
      thinkingOverride: 'low',
    });
    const model = interaction('reset-model');
    model.channelId = 'child';
    await invoke(model);
    expect(db.getChannel('dc:child')?.modelOverride).toBe('');
    const thinking = interaction('reset-thinking');
    thinking.channelId = 'child';
    await invoke(thinking);
    expect(db.getChannel('dc:child')?.thinkingOverride).toBe('');
    expect(db.getChannel('dc:parent')).toMatchObject({
      modelOverride: 'provider/parent',
      thinkingOverride: 'high',
    });
  });
});
