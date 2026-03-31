#!/usr/bin/env node

import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { RegisteredChannel } from './types.js';

type DbModule = typeof import('./db.js');

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const [command, ...args] = argv;

  switch (command) {
    case undefined:
      printHelp();
      return 0;
    case 'setup': {
      const { runSetup } = await import('./setup.js');
      await runSetup(args);
      return 0;
    }
    case 'start': {
      const { startGateway } = await import('./index.js');
      await startGateway();
      return 0;
    }
    case 'status': {
      const { runStatus } = await import('./status.js');
      runStatus();
      return 0;
    }
    case 'archive':
      await cliArchive(args);
      return 0;
    case 'channels':
      await cliListChannels();
      return 0;
    case 'register':
      await cliRegister(args);
      return 0;
    case 'unregister':
      await cliUnregister(args);
      return 0;
    case 'daemon': {
      if (!args[0]) {
        throw new Error('Usage: piscord daemon <install|uninstall|start|stop|status|logs>');
      }

      const { runDaemon } = await import('./daemon.js');
      runDaemon(args[0]);
      return 0;
    }
    case 'help':
    case '--help':
    case '-h':
      printHelp();
      return 0;
    default:
      console.error(`Unknown command: ${command}\n`);
      printHelp();
      return 1;
  }
}

export async function runCli(argv: string[] = process.argv.slice(2)): Promise<void> {
  const command = argv[0];

  try {
    process.exitCode = await main(argv);
  } catch (err) {
    await reportError(command, err);
    process.exitCode = 1;
  }
}

export function formatHelpText(): string {
  return [
    'piscord - Lightweight Discord gateway for pi coding agent',
    '',
    'USAGE:',
    '  piscord setup [token]                         Interactive setup wizard',
    '  piscord start                                 Start the gateway in the foreground',
    '  piscord status                                Show local diagnostics',
    '  piscord archive list                          List archived sessions',
    '  piscord archive cleanup [--dry-run]           Clean up archived sessions now',
    '  piscord channels                              List registered channels',
    '  piscord register <id> <name> [opts]          Register a Discord channel',
    '  piscord unregister <id>                       Unregister a channel',
    '  piscord daemon install                        Install systemd user service',
    '  piscord daemon uninstall                      Remove systemd user service',
    '  piscord daemon start                          Start systemd service',
    '  piscord daemon stop                           Stop systemd service',
    '  piscord daemon status                         Show systemd service status',
    '  piscord daemon logs                           Tail systemd journal logs',
    '  piscord archive list                           List archived sessions',
    '  piscord archive cleanup [--dry-run]            Clean up expired archives',
    '  piscord help                                  Show this help',
    '',
    'REGISTER OPTIONS:',
    '  --folder <name>    Relative session folder name (default: ch_<id>)',
    '  --no-trigger       Respond to all messages (not just @mentions)',
    '  --main             Mark as main channel (implies --no-trigger)',
  ].join('\n');
}

function printHelp(): void {
  console.log(formatHelpText());
}

async function cliRegister(args: string[]): Promise<void> {
  if (args.length < 2) {
    throw new Error('Usage: piscord register <channel-id> <name> [--folder <name>] [--no-trigger] [--main]');
  }

  const { validateSessionFolder } = await import('./session-path.js');
  const [channelId, name, ...optionArgs] = args;
  const options = parseRegisterOptions(channelId, optionArgs, validateSessionFolder);
  const channel: RegisteredChannel = {
    jid: toDiscordChannelJid(channelId),
    name,
    modelOverride: '',
    thinkingOverride: '',
    ...options,
  };

  await withDb(({ registerChannel }) => {
    registerChannel(channel);
    console.log(`Registered channel: ${name} (${channel.jid})`);
    console.log(`  Folder: ${channel.folder}`);
    console.log(`  Trigger required: ${channel.requiresTrigger}`);
    console.log(`  Main channel: ${channel.isMain}`);
  });
}

async function cliUnregister(args: string[]): Promise<void> {
  if (args.length < 1) {
    throw new Error('Usage: piscord unregister <channel-id>');
  }

  await withDb(({ unregisterChannel }) => {
    const jid = toDiscordChannelJid(args[0]);
    const ok = unregisterChannel(jid);
    if (ok) {
      console.log(`Unregistered channel: ${jid}`);
    } else {
      console.log(`Channel not found: ${jid}`);
    }
  });
}

async function cliArchive(args: string[]): Promise<void> {
  const subcommand = args[0];

  if (subcommand === 'list') {
    const { listArchivedSessions } = await import('./archive-cleanup.js');
    const { config } = await import('./config.js');
    const sessions = listArchivedSessions(config.sessionsDir);

    if (sessions.length === 0) {
      console.log('No archived sessions.');
      return;
    }

    console.log(`Archived sessions (${sessions.length}):\n`);
    const now = Date.now();
    for (const s of sessions) {
      const ageDays = Math.floor((now - s.archivedAt.getTime()) / (24 * 60 * 60 * 1000));
      console.log(`  ${s.name}  (${ageDays}d ago)`);
    }
    return;
  }

  if (subcommand === 'cleanup') {
    const { cleanupArchivedSessions } = await import('./archive-cleanup.js');
    const { config } = await import('./config.js');
    const dryRun = args.includes('--dry-run');
    const retention = config.archiveRetentionDays;

    if (retention === 0) {
      console.log('Archive cleanup is disabled (ARCHIVE_RETENTION_DAYS=0).');
      return;
    }

    const result = cleanupArchivedSessions(config.sessionsDir, retention, { dryRun });

    if (result.deleted.length === 0) {
      console.log('No expired archives to clean up.');
    } else {
      const verb = dryRun ? 'Would delete' : 'Deleted';
      console.log(`${verb} ${result.deleted.length} archived session(s):`);
      for (const name of result.deleted) {
        console.log(`  ${name}`);
      }
    }
    return;
  }

  throw new Error('Usage: piscord archive <list|cleanup> [--dry-run]');
}

async function cliListChannels(): Promise<void> {
  await withDb(({ getAllChannels }) => {
    const channels = getAllChannels();
    if (channels.length === 0) {
      console.log('No registered channels.');
      return;
    }

    console.log(`Registered channels (${channels.length}):\n`);
    for (const channel of channels) {
      console.log(formatChannelSummary(channel));
    }
  });
}

async function reportError(command: string | undefined, err: unknown): Promise<void> {
  const message = errorMessage(err);

  if (command === 'start') {
    const [{ closeDb }, { stopDiscord }, { logger }] = await Promise.all([
      import('./db.js'),
      import('./discord.js'),
      import('./logger.js'),
    ]);

    logger.fatal({ err: message }, 'Gateway exited with error');
    stopDiscord();
    closeDb();
    return;
  }

  console.error(`Error: ${message}`);
}

function isDirectExecution(): boolean {
  const entry = process.argv[1];
  if (!entry) {
    return false;
  }

  // resolve() keeps symlinks intact, but import.meta.url resolves to the
  // real file.  npm/pnpm bin shims are symlinks, so we must compare the
  // realpath of argv[1] against import.meta.url.
  try {
    return import.meta.url === pathToFileURL(realpathSync(resolve(entry))).href;
  } catch {
    // realpathSync can throw if the entry doesn't exist (e.g. piped stdin).
    return import.meta.url === pathToFileURL(resolve(entry)).href;
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function withDb<T>(operation: (db: DbModule) => T | Promise<T>): Promise<T> {
  const db = await import('./db.js');
  db.initDb();

  try {
    return await operation(db);
  } finally {
    db.closeDb();
  }
}

function parseRegisterOptions(
  channelId: string,
  args: string[],
  validateSessionFolder: (folder: string) => string,
): Pick<RegisteredChannel, 'folder' | 'requiresTrigger' | 'isMain'> {
  const options = {
    folder: validateSessionFolder(`ch_${channelId}`),
    requiresTrigger: true,
    isMain: false,
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--folder':
        if (args[i + 1]) {
          options.folder = validateSessionFolder(args[++i]);
        }
        break;
      case '--no-trigger':
        options.requiresTrigger = false;
        break;
      case '--main':
        options.isMain = true;
        options.requiresTrigger = false;
        break;
    }
  }

  return options;
}

function formatChannelSummary(channel: RegisteredChannel): string {
  const flags = [
    channel.isMain ? 'main' : '',
    channel.requiresTrigger ? 'trigger' : 'all-messages',
  ].filter(Boolean).join(', ');
  const overrides = [
    channel.modelOverride ? `model=${channel.modelOverride}` : '',
    channel.thinkingOverride ? `thinking=${channel.thinkingOverride}` : '',
  ].filter(Boolean).join(' ');

  return `  ${channel.jid}  ${channel.name}  [${flags}]  folder=${channel.folder}${overrides ? ` ${overrides}` : ''}`;
}

function toDiscordChannelJid(channelId: string): string {
  return channelId.startsWith('dc:') ? channelId : `dc:${channelId}`;
}

if (isDirectExecution()) {
  void runCli();
}
