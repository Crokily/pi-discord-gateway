#!/usr/bin/env node

/**
 * pi-discord-gateway — Lightweight Discord gateway for pi coding agent.
 *
 * Architecture inspired by NanoClaw (https://github.com/qwibitai/nanoclaw).
 * Discord messages → SQLite queue → pi subprocess → Discord response.
 */

import { config } from './config.js';
import { logger } from './logger.js';
import { initDb, closeDb, registerChannel, unregisterChannel, getAllChannels } from './db.js';
import { startDiscord, stopDiscord, getBotTag } from './discord.js';
import { startMediaCleanup } from './media.js';
import { startProcessingLoop, stopProcessingLoop } from './queue.js';
import { validateSessionFolder } from './session-path.js';
import type { RegisteredChannel } from './types.js';

// ── CLI commands (run without starting the bot) ──

const [cmd, ...args] = process.argv.slice(2);

if (cmd === 'register') {
  cliRegister(args);
} else if (cmd === 'unregister') {
  cliUnregister(args);
} else if (cmd === 'channels') {
  cliListChannels();
} else if (cmd === 'help' || cmd === '--help' || cmd === '-h') {
  printHelp();
} else {
  // Default: start the gateway
  startGateway();
}

// ── Gateway startup ──

async function startGateway(): Promise<void> {
  if (!config.discordToken) {
    logger.fatal('DISCORD_BOT_TOKEN is required. Set it in .env or environment.');
    process.exit(1);
  }

  initDb();

  logger.info('Starting pi-discord-gateway...');

  await startDiscord();
  startProcessingLoop();
  startMediaCleanup();

  logger.info({
    bot: getBotTag(),
    trigger: `@${config.triggerName}`,
    concurrency: config.maxConcurrency,
    sessionsDir: config.sessionsDir,
  }, 'Gateway running');

  // Graceful shutdown
  const shutdown = () => {
    logger.info('Shutting down...');
    stopProcessingLoop();
    stopDiscord();
    closeDb();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

// ── CLI handlers ──

function cliRegister(args: string[]): void {
  // Usage: register <channel-id> <name> [--folder <name>] [--no-trigger] [--main]
  if (args.length < 2) {
    console.error('Usage: pi-discord-gateway register <channel-id> <name> [--folder <f>] [--no-trigger] [--main]');
    process.exit(1);
  }

  initDb();

  try {
    const channelId = args[0];
    const name = args[1];

    let folder = validateSessionFolder(`ch_${channelId}`);
    let requiresTrigger = true;
    let isMain = false;

    for (let i = 2; i < args.length; i++) {
      if (args[i] === '--folder' && args[i + 1]) {
        folder = validateSessionFolder(args[++i]);
      } else if (args[i] === '--no-trigger') {
        requiresTrigger = false;
      } else if (args[i] === '--main') {
        isMain = true;
        requiresTrigger = false;
      }
    }

    const ch: RegisteredChannel = {
      jid: `dc:${channelId}`,
      name,
      folder,
      requiresTrigger,
      isMain,
      modelOverride: '',
      thinkingOverride: '',
    };

    registerChannel(ch);
    console.log(`✓ Registered channel: ${name} (${ch.jid})`);
    console.log(`  Folder: ${folder}`);
    console.log(`  Trigger required: ${requiresTrigger}`);
    console.log(`  Main channel: ${isMain}`);
    closeDb();
  } catch (err: any) {
    closeDb();
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }
}

function cliUnregister(args: string[]): void {
  if (args.length < 1) {
    console.error('Usage: pi-discord-gateway unregister <channel-id>');
    process.exit(1);
  }

  initDb();

  const jid = args[0].startsWith('dc:') ? args[0] : `dc:${args[0]}`;
  const ok = unregisterChannel(jid);
  if (ok) {
    console.log(`✓ Unregistered channel: ${jid}`);
  } else {
    console.log(`✗ Channel not found: ${jid}`);
  }
  closeDb();
}

function cliListChannels(): void {
  initDb();
  const channels = getAllChannels();
  if (channels.length === 0) {
    console.log('No registered channels.');
  } else {
    console.log(`Registered channels (${channels.length}):\n`);
    for (const ch of channels) {
      const flags = [
        ch.isMain ? 'main' : '',
        ch.requiresTrigger ? 'trigger' : 'all-messages',
      ].filter(Boolean).join(', ');
      const overrides = [
        ch.modelOverride ? `model=${ch.modelOverride}` : '',
        ch.thinkingOverride ? `thinking=${ch.thinkingOverride}` : '',
      ].filter(Boolean).join(' ');
      console.log(`  ${ch.jid}  ${ch.name}  [${flags}]  folder=${ch.folder}${overrides ? ` ${overrides}` : ''}`);
    }
  }
  closeDb();
}

function printHelp(): void {
  console.log(`
pi-discord-gateway — Lightweight Discord gateway for pi coding agent

USAGE:
  npx pi-discord-gateway                         Start the gateway
  npx pi-discord-gateway register <id> <name>     Register a Discord channel
  npx pi-discord-gateway unregister <id>          Unregister a channel
  npx pi-discord-gateway channels                 List registered channels
  npx pi-discord-gateway help                     Show this help

REGISTER OPTIONS:
  --folder <name>    Relative session folder name (default: ch_<id>)
  --no-trigger       Respond to all messages (not just @mentions)
  --main             Mark as main channel (implies --no-trigger)

ENVIRONMENT:
  DISCORD_BOT_TOKEN  Discord bot token (required)
  PI_BIN             Path to pi binary (default: pi)
  PI_MODEL           Default model for pi
  PI_THINKING        Thinking level for pi
  TRIGGER_NAME       Bot trigger name (default: Andy)
  MAX_CONCURRENCY    Max parallel agent invocations (default: 3)
  SESSIONS_DIR       Session storage directory
  DB_PATH            SQLite database path
  AUTO_REGISTER_DMS  Auto-register DM channels (default: true)
  LOG_LEVEL          Log level: debug/info/warn/error (default: info)
  PI_CWD             Working directory for pi agent
  PI_EXTRA_FLAGS     Extra flags to pass to pi
`);
}
