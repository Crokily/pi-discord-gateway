import { statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { AttachmentBuilder, Client, GatewayIntentBits } from 'discord.js';
import { config } from '../config.js';

export interface SendRequest {
  channelJid: string;
  text?: string;
  files: string[];
}

export function normalizeChannelJid(input: string): string {
  const value = input.trim();
  return value.startsWith('dc:') ? value : `dc:${value}`;
}

export function validateSendRequest(
  request: SendRequest,
  options: { maxAttachmentBytes: number; fileStat: (path: string) => { size: number } },
): void {
  const hasText = Boolean(request.text?.trim());

  if (!hasText && request.files.length === 0) {
    throw new Error('Either text or at least one file is required.');
  }

  if (request.files.length > 10) {
    throw new Error('At most 10 files can be sent in a single message.');
  }

  for (const filePath of request.files) {
    let file;

    try {
      file = options.fileStat(filePath);
    } catch {
      throw new Error(`File not found: ${filePath}`);
    }

    if (options.maxAttachmentBytes > 0 && file.size > options.maxAttachmentBytes) {
      throw new Error(`File exceeds max attachment size (${options.maxAttachmentBytes} bytes): ${filePath}`);
    }
  }
}

export async function sendFilesToDiscord(request: SendRequest): Promise<{ sentFiles: number }> {
  validateSendRequest(request, {
    maxAttachmentBytes: config.maxAttachmentBytes,
    fileStat: (filePath) => statSync(filePath),
  });

  const channelJid = normalizeChannelJid(request.channelJid);
  const channelId = channelJid.slice(3);
  const attachments = await Promise.all(
    request.files.map(async (filePath) => (
      new AttachmentBuilder(await readFile(filePath), { name: basename(filePath) })
    )),
  );

  const client = new Client({
    intents: [GatewayIntentBits.Guilds],
  });

  try {
    await client.login(config.discordToken);
    const channel = await client.channels.fetch(channelId);

    if (!channel || !channel.isTextBased() || !('send' in channel)) {
      throw new Error(`Channel not found or not text-based: ${channelJid}`);
    }

    await channel.send({
      content: request.text || undefined,
      ...(attachments.length > 0 ? { files: attachments } : {}),
    });
    return { sentFiles: attachments.length };
  } finally {
    client.destroy();
  }
}
