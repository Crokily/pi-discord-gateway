/**
 * Discord channel adapter.
 *
 * Architecture borrowed from NanoClaw (https://github.com/qwibitai/nanoclaw).
 * Handles all Discord I/O: receiving messages, sending responses, typing indicators.
 * Contains zero business logic — that lives in the pi agent.
 */

import {
  Client,
  ChannelType,
  Events,
  GatewayIntentBits,
  Partials,
  REST,
  Routes,
  type Interaction,
  type Message,
  type TextChannel,
} from 'discord.js';
import { handleThreadDeleted, registerIncomingThread, setThreadTransport } from './threads.js';
import { type RegisteredChannel } from '../types.js';
import { config } from '../config.js';
import { logger } from '../logger.js';
import {
  createDmChannel,
  getChannel,
  registerChannel as dbRegisterChannel,
  enqueueMessage,
  isRoutingThread,
} from '../db.js';
import {
  buildAttachmentOnlyPrompt,
  selectAttachmentsWithinLimits,
  type AttachmentMeta,
} from './attachments.js';
import { handleAutocomplete, handleChatCommand, registerGlobalCommands } from './slash-commands.js';
import { deliverResponse, splitResponse, type DeliveryTransport } from './delivery.js';

let client: Client | null = null;
let triggerPattern: RegExp;
let botId: string;
let deliveryRest: REST | undefined;

export async function startDiscord(): Promise<void> {
  // The persisted delivery queue owns the retry budget for outbound answers.
  deliveryRest = new REST({
    version: '10',
    retries: 0,
    timeout: 10_000,
    rejectOnRateLimit: () => true,
  }).setToken(config.discordToken);
  client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.DirectMessages,
    ],
    // Required for DM message events in discord.js.
    partials: [Partials.Channel],
  });

  client.on(Events.MessageCreate, (message) => {
    void handleMessage(message).catch((err) => logger.error({ err }, 'Message reception failed'));
  });
  client.on(Events.ThreadDelete, (thread) => handleThreadDeleted(thread.id));
  setThreadTransport({
    get: getThreadInfo,
    create: async (parentId, anchorId, name) => {
      const parent = (await deliveryRest!.get(Routes.channel(parentId))) as {
        default_auto_archive_duration?: number;
      };
      const thread = (await deliveryRest!.post(Routes.threads(parentId, anchorId), {
        body: { name, auto_archive_duration: parent.default_auto_archive_duration ?? 1440 },
      })) as RawThread;
      return threadInfo(thread);
    },
    sendAnchor: deliveryTransport.send,
    findAnchor: deliveryTransport.find,
  });
  client.on(Events.InteractionCreate, handleInteraction);
  client.on(Events.Error, (err) => logger.error({ err: err.message }, 'Discord client error'));

  return new Promise<void>((resolve, reject) => {
    const onReady = async (ready: Client<true>) => {
      cleanup();
      botId = ready.user.id;
      triggerPattern = new RegExp(`^@${escapeRegExp(config.triggerName)}\\b`, 'i');
      logger.info({ tag: ready.user.tag, id: botId }, 'Discord bot connected');

      try {
        await registerGlobalCommands(ready);
      } catch (err: any) {
        logger.error({ err: err.message }, 'Failed to register global slash commands');
      }

      resolve();
    };

    const onStartupError = (err: Error) => {
      cleanup();
      reject(err);
    };

    const cleanup = () => {
      client?.off(Events.ClientReady, onReady);
      client?.off(Events.Error, onStartupError);
    };

    client!.once(Events.ClientReady, onReady);
    client!.once(Events.Error, onStartupError);
    client!.login(config.discordToken).catch(onStartupError);
  });
}

async function handleInteraction(interaction: Interaction): Promise<void> {
  try {
    if (interaction.isAutocomplete()) {
      await handleAutocomplete(interaction);
      return;
    }

    if (interaction.isChatInputCommand()) {
      await handleChatCommand(interaction);
    }
  } catch (err: any) {
    logger.error({ err: err.message, id: interaction.id }, 'Interaction handler failed');
  }
}

async function handleMessage(message: Message): Promise<void> {
  // Ignore bot messages
  if (message.author.bot) return;

  const isDM = !message.guild;
  const channelId = message.channelId;
  const jid = `dc:${channelId}`;

  // ── Build content ──
  let content = message.content;
  const senderName =
    message.member?.displayName || message.author.displayName || message.author.username;
  const sender = message.author.id;
  const timestamp = message.createdAt.toISOString();

  // Translate @bot mentions → trigger format
  if (client?.user) {
    const isMentioned =
      message.mentions.users.has(botId) ||
      content.includes(`<@${botId}>`) ||
      content.includes(`<@!${botId}>`);

    if (isMentioned) {
      content = content.replace(new RegExp(`<@!?${botId}>`, 'g'), '').trim();
      if (!triggerPattern.test(content)) {
        content = `@${config.triggerName} ${content}`;
      }
    }
  }

  // Attachments → extract metadata for downstream download
  let acceptedAttachments: AttachmentMeta[] = [];
  let attachmentsJson: string | null = null;
  if (message.attachments.size > 0) {
    const metas: AttachmentMeta[] = [...message.attachments.values()].map((att) => ({
      url: att.url,
      name: att.name || 'file',
      contentType: att.contentType || '',
      size: att.size || 0,
    }));

    const selection = selectAttachmentsWithinLimits(metas, {
      maxFileBytes: config.maxAttachmentBytes,
      maxTotalBytes: config.maxTotalAttachmentBytes,
    });

    acceptedAttachments = selection.accepted;
    if (selection.rejected.length > 0) {
      logger.info(
        {
          jid,
          skipped: selection.rejected.map(({ attachment, reason, limitBytes }) => ({
            name: attachment.name,
            size: attachment.size,
            reason,
            limitBytes,
          })),
        },
        'Skipped oversized Discord attachments before enqueue',
      );
    }

    if (acceptedAttachments.length > 0) {
      attachmentsJson = JSON.stringify(acceptedAttachments);
    }
  }

  // ── Channel registration check ──
  let channel = getChannel(jid);
  if (channel?.deletedAt) return;
  if (message.channel.isThread() && message.channel.parentId) {
    const parentId = message.channel.parentId;
    if (
      !channel &&
      (config.excludedChannels.has(channelId) || config.excludedChannels.has(parentId))
    )
      return;
    const managed = isRoutingThread(channelId);
    if (!channel && config.channelPolicy === 'allowlist' && !managed) return;
    channel = registerIncomingThread(
      jid,
      message.channel.name,
      parentId,
      channel,
      managed ? false : config.channelPolicy !== 'open',
    );
  }

  // Auto-register DMs
  if (!channel && isDM && config.autoRegisterDMs) {
    const reg = createDmChannel(jid, sender, senderName);
    dbRegisterChannel(reg);
    channel = reg;
    logger.info({ jid, senderName }, 'Auto-registered DM channel');
  }

  // Auto-register guild channels based on policy
  if (!channel && !isDM && config.channelPolicy !== 'allowlist') {
    if (config.excludedChannels.has(channelId)) {
      return;
    }

    const guildName = message.guild?.name || 'Unknown';
    const channelName = (message.channel as TextChannel).name || 'unknown';
    const name = `${guildName} #${channelName}`;
    const reg: RegisteredChannel = {
      jid,
      name,
      folder: `ch_${channelId}`,
      requiresTrigger: config.channelPolicy === 'open-trigger',
      isMain: false,
      modelOverride: '',
      thinkingOverride: '',
      cwdOverride: '',
    };
    dbRegisterChannel(reg);
    channel = reg;
    logger.info({ jid, name, policy: config.channelPolicy }, 'Auto-registered guild channel');
  }

  if (!channel) {
    logger.debug({ jid }, 'Message from unregistered channel, ignoring');
    return;
  }

  // ── Trigger check ──
  if (channel.requiresTrigger && !triggerPattern.test(content)) {
    logger.debug({ jid }, 'Message does not match trigger, ignoring');
    return;
  }

  // Strip trigger prefix from content sent to agent
  content = content.replace(triggerPattern, '').trim();
  if (!content && acceptedAttachments.length > 0) {
    content = buildAttachmentOnlyPrompt(acceptedAttachments.length);
  }
  if (!content) return;

  // Reply context
  if (message.reference?.messageId) {
    try {
      const ref = await message.channel.messages.fetch(message.reference.messageId);
      const refAuthor = ref.member?.displayName || ref.author.displayName || ref.author.username;
      content = `[Reply to ${refAuthor}] ${content}`;
    } catch {
      // deleted message
    }
  }

  // ── Enqueue ──
  enqueueMessage({
    channelJid: jid,
    sender,
    senderName,
    content,
    timestamp,
    attachments: attachmentsJson,
    sourceMessageId: message.id,
    routeThread: !message.channel.isThread() && channel.threadMode === 'auto',
  });
  logger.info({ jid, sender: senderName, len: content.length }, 'Message enqueued');
}

// ── Outbound ──

const DISCORD_MAX_LENGTH = 2000;

export async function sendResponse(jid: string, text: string): Promise<boolean> {
  if (!client) return false;

  try {
    for (const chunk of splitResponse(text, DISCORD_MAX_LENGTH)) {
      await deliveryTransport.send(
        jid,
        chunk,
        crypto.randomUUID().replaceAll('-', '').slice(0, 24),
      );
    }
    logger.info({ jid, length: text.length }, 'Response sent');
    return true;
  } catch (err: any) {
    logger.error({ jid, err: err.message }, 'Failed to send message');
    return false;
  }
}

export const deliveryTransport: DeliveryTransport = {
  async send(jid, content, nonce) {
    if (!deliveryRest) throw new Error('Discord is not connected');
    const message = (await deliveryRest.post(Routes.channelMessages(jid.replace(/^dc:/, '')), {
      body: { content, nonce, enforce_nonce: true },
    })) as { id: string };
    return message.id;
  },
  async find(jid, nonce) {
    if (!deliveryRest) return undefined;
    const messages = (await deliveryRest.get(Routes.channelMessages(jid.replace(/^dc:/, '')), {
      query: new URLSearchParams({ limit: '100' }),
    })) as Array<{ id: string; nonce?: string; author: { id: string } }>;
    return messages.find((message) => message.author.id === botId && message.nonce === nonce)?.id;
  },
};

export function sendDurableResponse(rowid: number, signal: AbortSignal): Promise<boolean> {
  return deliverResponse(rowid, deliveryTransport, signal);
}

export async function setTyping(jid: string): Promise<void> {
  if (!client) return;
  try {
    const channelId = jid.replace(/^dc:/, '');
    const channel = await client.channels.fetch(channelId);
    if (channel && 'sendTyping' in channel) {
      await (channel as TextChannel).sendTyping();
    }
  } catch {
    // best-effort
  }
}

export function stopDiscord(): void {
  if (client) {
    client.destroy();
    client = null;
    logger.info('Discord bot stopped');
  }
}

export function getBotTag(): string | undefined {
  return client?.user?.tag;
}

// ── Helpers ──

interface RawThread {
  id: string;
  name?: string;
  type: number;
  parent_id?: string;
}
function threadInfo(channel: RawThread) {
  return {
    id: channel.id,
    name: channel.name ?? 'Pi conversation',
    parentId: channel.parent_id,
    isThread: [
      ChannelType.PublicThread,
      ChannelType.PrivateThread,
      ChannelType.AnnouncementThread,
    ].includes(channel.type),
    textParent: channel.type === ChannelType.GuildText,
  };
}
async function getThreadInfo(id: string) {
  if (!deliveryRest) throw new Error('Discord is not connected');
  return threadInfo((await deliveryRest.get(Routes.channel(id))) as RawThread);
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
