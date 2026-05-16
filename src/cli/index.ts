#!/usr/bin/env node

import { existsSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { RegisteredChannel } from '../types.js';
import { config, resolveConfigPath } from '../config.js';

type DbModule = typeof import('../db.js');

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
      if (await maybeRunFirstTimeSetup()) return 0;
      await checkPiDependencies();
      const { startGateway } = await import('../index.js');
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
    case 'task':
      await cliTask(args);
      return 0;
    case 'channels':
      await cliListChannels();
      return 0;
    case 'send':
      await cliSend(args);
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
    '  piscord task add --name <n> --schedule <expr> --channel <jid> --prompt <text> [--once]',
    '  piscord task list                             List scheduled tasks',
    '  piscord task remove <id>                      Remove a scheduled task',
    '  piscord task enable <id>                      Enable a scheduled task',
    '  piscord task disable <id>                     Disable a scheduled task',
    '  piscord channels                              List registered channels',
    '  piscord send --channel <jid> [--text <message>] [--file <path> ...]',
    '  piscord register <id> <name> [opts]          Register a Discord channel',
    '  piscord unregister <id>                       Unregister a channel',
    '  piscord daemon install                        Install background service (systemd/launchd)',
    '  piscord daemon uninstall                      Remove background service',
    '  piscord daemon start                          Start background service',
    '  piscord daemon stop                           Stop background service',
    '  piscord daemon status                         Show background service status',
    '  piscord daemon logs                           Tail service logs',
    '  piscord help                                  Show this help',
    '',
    'REGISTER OPTIONS:',
    '  --folder <name>    Relative session folder name (default: ch_<id>)',
    '  --cwd <path>       Override PI_CWD for this channel only',
    '  --no-trigger       Respond to all messages (not just @mentions)',
    '  --main             Mark as main channel (implies --no-trigger)',
    '',
    'TASK OPTIONS:',
    '  --once             Treat --schedule as a one-time ISO datetime',
  ].join('\n');
}

function printHelp(): void {
  console.log(formatHelpText());
}

async function cliRegister(args: string[]): Promise<void> {
  if (args.length < 2) {
    throw new Error(
      'Usage: piscord register <channel-id> <name> [--folder <name>] [--cwd <path>] [--no-trigger] [--main]',
    );
  }

  const { validateSessionFolder } = await import('../session/path.js');
  const [channelId, name, ...optionArgs] = args;
  const options = parseRegisterOptions(channelId, optionArgs, validateSessionFolder);

  await withDb(({ getChannel, registerChannel }) => {
    const jid = toDiscordChannelJid(channelId);
    const existing = getChannel(jid);
    const channel: RegisteredChannel = {
      jid,
      name,
      folder: options.folder,
      requiresTrigger: options.requiresTrigger,
      isMain: options.isMain,
      modelOverride: existing?.modelOverride ?? '',
      thinkingOverride: existing?.thinkingOverride ?? '',
      cwdOverride: options.cwdOverride ?? existing?.cwdOverride ?? '',
    };

    registerChannel(channel);
    console.log(`Registered channel: ${name} (${channel.jid})`);
    console.log(`  Folder: ${channel.folder}`);
    console.log(
      `  Working directory: ${channel.cwdOverride || config.piCwd}${channel.cwdOverride ? ' (channel override)' : ' (gateway default)'}`,
    );
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
  const [subcommand, ...subArgs] = args;

  switch (subcommand) {
    case 'list':
      await cliArchiveList();
      return;
    case 'cleanup':
      await cliArchiveCleanup(subArgs);
      return;
    default:
      throw new Error('Usage: piscord archive <list|cleanup [--dry-run]>');
  }
}

async function cliTask(args: string[]): Promise<void> {
  const [subcommand, ...subArgs] = args;

  switch (subcommand) {
    case 'add':
      await cliAddTask(subArgs);
      return;
    case 'list':
      await cliListTasks();
      return;
    case 'remove':
      await cliRemoveTask(subArgs);
      return;
    case 'enable':
      await cliEnableTask(subArgs);
      return;
    case 'disable':
      await cliDisableTask(subArgs);
      return;
    default:
      throw new Error('Usage: piscord task <add|list|remove|enable|disable> [options]');
  }
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

async function cliSend(args: string[]): Promise<void> {
  const usage = 'Usage: piscord send --channel <jid> [--text <message>] [--file <path> ...]';
  let channel: string | undefined;
  let text: string | undefined;
  const files: string[] = [];

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--channel':
        if (!args[i + 1]) {
          throw new Error(usage);
        }
        channel = args[++i];
        break;
      case '--file':
        if (!args[i + 1]) {
          throw new Error(usage);
        }
        files.push(args[++i]);
        break;
      case '--text':
        if (!args[i + 1]) {
          throw new Error(usage);
        }
        text = args[++i];
        break;
      default:
        throw new Error(usage);
    }
  }

  if (!channel) {
    throw new Error(usage);
  }

  if (!text && files.length === 0) {
    throw new Error(`${usage}\nAt least one of --text or --file is required.`);
  }

  const { sendFilesToDiscord } = await import('../discord/send.js');
  const channelJid = toDiscordChannelJid(channel);
  const result = await sendFilesToDiscord({ channelJid, text, files });
  if (result.sentFiles === 0) {
    console.log(`Sent message to ${channelJid}`);
    return;
  }

  console.log(`Sent ${result.sentFiles} file(s) to ${channelJid}`);
}

async function cliAddTask(args: string[]): Promise<void> {
  const options = parseTaskAddOptions(args);
  const { computeNextRun } = await import('../agent/scheduler.js');
  const nextRunAt = computeNextRun(options.schedule, options.type);

  if (!nextRunAt) {
    throw new Error('Schedule does not produce a future run time.');
  }

  await withDb(({ addScheduledTask }) => {
    const id = addScheduledTask({
      name: options.name,
      type: options.type,
      schedule: options.schedule,
      channelJid: toDiscordChannelJid(options.channel),
      prompt: options.prompt,
      createdBy: 'cli',
      nextRunAt,
    });

    console.log(`Scheduled task added: ${id}`);
  });
}

async function cliListTasks(): Promise<void> {
  await withDb(({ listScheduledTasks }) => {
    const tasks = listScheduledTasks();
    if (tasks.length === 0) {
      console.log('No scheduled tasks.');
      return;
    }

    console.table(
      tasks.map((task) => ({
        id: task.id,
        name: task.name,
        type: task.type,
        schedule: task.schedule,
        channel: task.channel_jid,
        enabled: task.enabled,
        next_run_at: task.next_run_at ?? '',
      })),
    );
  });
}

async function cliRemoveTask(args: string[]): Promise<void> {
  const id = parseTaskId(args[0], 'Usage: piscord task remove <id>');

  await withDb(({ removeScheduledTask }) => {
    const removed = removeScheduledTask(id);
    console.log(removed ? `Removed scheduled task: ${id}` : `Scheduled task not found: ${id}`);
  });
}

async function cliEnableTask(args: string[]): Promise<void> {
  const id = parseTaskId(args[0], 'Usage: piscord task enable <id>');

  await withDb(({ enableScheduledTask }) => {
    const enabled = enableScheduledTask(id);
    console.log(enabled ? `Enabled scheduled task: ${id}` : `Scheduled task not found: ${id}`);
  });
}

async function cliDisableTask(args: string[]): Promise<void> {
  const id = parseTaskId(args[0], 'Usage: piscord task disable <id>');

  await withDb(({ disableScheduledTask }) => {
    const disabled = disableScheduledTask(id);
    console.log(disabled ? `Disabled scheduled task: ${id}` : `Scheduled task not found: ${id}`);
  });
}

async function cliArchiveList(): Promise<void> {
  const [{ listArchivedSessions }, { config }] = await Promise.all([
    import('../session/archive-cleanup.js'),
    import('../config.js'),
  ]);

  const archivedSessions = listArchivedSessions(config.sessionsDir);
  if (archivedSessions.length === 0) {
    console.log(`No archived sessions found in ${config.sessionsDir}.`);
    return;
  }

  const now = Date.now();
  console.log(`Archived sessions (${archivedSessions.length}) in ${config.sessionsDir}:\n`);

  for (const archived of archivedSessions) {
    console.log(
      `  ${archived.name}  archived=${archived.archivedAt.toISOString()}  age=${formatAge(archived.archivedAt, now)}`,
    );
  }
}

async function cliArchiveCleanup(args: string[]): Promise<void> {
  const dryRun = args.includes('--dry-run');
  const unknownArgs = args.filter((arg) => arg !== '--dry-run');
  if (unknownArgs.length > 0) {
    throw new Error('Usage: piscord archive cleanup [--dry-run]');
  }

  const [{ cleanupArchivedSessions }, { config }] = await Promise.all([
    import('../session/archive-cleanup.js'),
    import('../config.js'),
  ]);

  if (config.archiveRetentionDays === 0) {
    console.log('Archive cleanup is disabled (ARCHIVE_RETENTION_DAYS=0).');
    return;
  }

  const result = cleanupArchivedSessions(config.sessionsDir, config.archiveRetentionDays, {
    dryRun,
  });
  if (result.deleted.length === 0) {
    console.log(`No archived sessions ${dryRun ? 'would be deleted' : 'were deleted'}.`);
  } else {
    console.log(
      `${dryRun ? 'Would delete' : 'Deleted'} ${result.deleted.length} archived session directories:`,
    );
    for (const deleted of result.deleted) {
      console.log(`  ${deleted}`);
    }
  }

  console.log(
    `Skipped ${result.skipped} archived ${result.skipped === 1 ? 'session' : 'sessions'}.`,
  );
}

async function reportError(command: string | undefined, err: unknown): Promise<void> {
  const message = errorMessage(err);

  if (command === 'start') {
    const [{ closeDb }, { stopDiscord }, { logger }] = await Promise.all([
      import('../db.js'),
      import('../discord/client.js'),
      import('../logger.js'),
    ]);

    logger.fatal({ err: message }, 'Gateway exited with error');
    stopDiscord();
    closeDb();
    return;
  }

  console.error(`Error: ${message}`);
}

async function checkPiDependencies(): Promise<void> {
  // Use dynamic import() rather than CJS require.resolve so this works
  // when the peer (e.g. @earendil-works/pi-ai) is an ESM-only package
  // whose package.json "exports" only declares the "import" condition.
  // require.resolve cannot resolve such packages and produces a false
  // negative even when they're installed.
  try {
    await import('@earendil-works/pi-ai');
    return;
  } catch {
    // not found — check if the legacy package is installed instead
  }

  let hint = '';
  // Use an indirect specifier so TypeScript doesn't statically resolve the
  // legacy package (it may not be installed in this devDependencies set,
  // and we only care whether it's present at runtime).
  const legacyPkg = '@mariozechner/pi-ai';
  try {
    await import(legacyPkg);
    hint =
      '\n\nDetected legacy @mariozechner/pi-ai. This package has moved to @earendil-works/pi-ai.' +
      '\nUpgrade pi to v0.74.0+ to get the new packages.';
  } catch {
    // neither installed
  }

  throw new Error(`Required peer dependency @earendil-works/pi-ai is not installed.${hint}`);
}

async function maybeRunFirstTimeSetup(): Promise<boolean> {
  const configPath = resolveConfigPath();
  if (existsSync(configPath)) return false;

  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  if (!interactive) {
    throw new Error(
      `No config found at ${configPath}. Run "piscord setup" first, or set PIDG_CONFIG to point to your config file.`,
    );
  }

  console.log(`No config found at ${configPath}. Starting first-time setup...\n`);
  const { runSetup } = await import('./setup.js');
  await runSetup([]);
  return true;
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

function formatAge(date: Date, now = Date.now()): string {
  const diff = Math.max(0, now - date.getTime());
  const days = Math.floor(diff / (24 * 60 * 60 * 1000));
  const hours = Math.floor((diff % (24 * 60 * 60 * 1000)) / (60 * 60 * 1000));
  const minutes = Math.floor((diff % (60 * 60 * 1000)) / (60 * 1000));

  if (days > 0) {
    return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
  }

  if (hours > 0) {
    return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  }

  return `${minutes}m`;
}

async function withDb<T>(operation: (db: DbModule) => T | Promise<T>): Promise<T> {
  const db = await import('../db.js');
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
): { folder: string; requiresTrigger: boolean; isMain: boolean; cwdOverride?: string } {
  const options: {
    folder: string;
    requiresTrigger: boolean;
    isMain: boolean;
    cwdOverride?: string;
  } = {
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
      case '--cwd':
        if (args[i + 1]) {
          const cwdOverride = args[++i].trim();
          if (cwdOverride) {
            options.cwdOverride = cwdOverride;
          }
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

function parseTaskAddOptions(args: string[]): {
  name: string;
  type: 'once' | 'recurring';
  schedule: string;
  channel: string;
  prompt: string;
} {
  const options: {
    name?: string;
    type: 'once' | 'recurring';
    schedule?: string;
    channel?: string;
    prompt?: string;
  } = {
    type: 'recurring',
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--name':
        options.name = args[++i];
        break;
      case '--schedule':
        options.schedule = args[++i];
        break;
      case '--channel':
        options.channel = args[++i];
        break;
      case '--prompt':
        options.prompt = args[++i];
        break;
      case '--once':
        options.type = 'once';
        break;
      default:
        throw new Error(
          'Usage: piscord task add --name <n> --schedule <cron|iso> --channel <jid> --prompt <text> [--once]',
        );
    }
  }

  if (!options.name || !options.schedule || !options.channel || !options.prompt) {
    throw new Error(
      'Usage: piscord task add --name <n> --schedule <cron|iso> --channel <jid> --prompt <text> [--once]',
    );
  }

  return {
    name: options.name,
    type: options.type,
    schedule: options.schedule,
    channel: options.channel,
    prompt: options.prompt,
  };
}

function parseTaskId(raw: string | undefined, usage: string): number {
  if (!raw) {
    throw new Error(usage);
  }

  const id = Number.parseInt(raw, 10);
  if (Number.isNaN(id)) {
    throw new Error(usage);
  }

  return id;
}

function formatChannelSummary(channel: RegisteredChannel): string {
  const flags = [channel.isMain ? 'main' : '', channel.requiresTrigger ? 'trigger' : 'all-messages']
    .filter(Boolean)
    .join(', ');
  const overrides = [
    `cwd=${channel.cwdOverride || config.piCwd}${channel.cwdOverride ? ' (channel)' : ''}`,
    channel.modelOverride ? `model=${channel.modelOverride}` : '',
    channel.thinkingOverride ? `thinking=${channel.thinkingOverride}` : '',
  ]
    .filter(Boolean)
    .join(' ');

  return `  ${channel.jid}  ${channel.name}  [${flags}]  folder=${channel.folder}${overrides ? ` ${overrides}` : ''}`;
}

function toDiscordChannelJid(channelId: string): string {
  return channelId.startsWith('dc:') ? channelId : `dc:${channelId}`;
}

if (isDirectExecution()) {
  void runCli();
}
