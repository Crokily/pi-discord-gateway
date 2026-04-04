import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import * as clack from '@clack/prompts';
import { listAvailableModels } from '../agent/model-catalog.js';
import { resolveConfigPath } from '../config.js';

const DEFAULT_TRIGGER_NAME = 'pi';
const DEFAULT_WORKING_DIR = homedir();
const DEFAULT_DATA_DIR = resolve(homedir(), '.local/share/piscord-gateway');
const DEFAULT_SESSIONS_DIR = resolve(DEFAULT_DATA_DIR, 'sessions');
const DEFAULT_DB_PATH = resolve(DEFAULT_DATA_DIR, 'gateway.db');
const AUTH_PATH = resolve(homedir(), '.pi/agent/auth.json');

export async function runSetup(args: string[]): Promise<void> {
  const tokenArg = args[0]?.trim() ?? '';
  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  const configPath = resolveConfigPath();

  if (!interactive && !tokenArg) {
    throw new Error('DISCORD_BOT_TOKEN must be provided as an argument when stdin is not interactive.');
  }

  clack.intro('piscord setup');

  // ── Prerequisites ──
  const prereqs = checkPrerequisites();
  const prereqLines = [
    prereqs.piPath
      ? `  ✓ pi binary: ${prereqs.piPath}${prereqs.piVersion ? ` (${prereqs.piVersion})` : ''}`
      : '  ✗ pi binary: not found in PATH — install pi first',
    prereqs.authFound
      ? `  ✓ pi auth: found`
      : `  ✗ pi auth: missing — run "pi" and log in first`,
    prereqs.modelCount !== undefined
      ? `  ✓ models: ${prereqs.modelCount} available`
      : `  ✗ models: unavailable`,
  ];
  clack.note(prereqLines.join('\n'), 'Prerequisites');

  if (!prereqs.piPath || !prereqs.authFound) {
    clack.log.warn('Some prerequisites are missing. The gateway needs pi installed and logged in to work.');
  }

  // ── Token ──
  let token = tokenArg;
  if (!token && interactive) {
    const result = await clack.text({
      message: 'Discord Bot Token',
      placeholder: 'Paste your bot token here',
      validate: (v) => {
        if (!v.trim()) return 'Token cannot be empty.';
        if (v.trim().length < 50) return 'That doesn\'t look like a valid bot token.';
      },
    });
    if (clack.isCancel(result)) { clack.cancel('Setup cancelled.'); process.exit(0); }
    token = result;
  }

  if (!token) {
    throw new Error('Discord Bot Token cannot be empty.');
  }

  // ── Trigger name ──
  let triggerName = DEFAULT_TRIGGER_NAME;
  if (interactive) {
    const result = await clack.text({
      message: 'Trigger Name',
      placeholder: DEFAULT_TRIGGER_NAME,
      defaultValue: DEFAULT_TRIGGER_NAME,
      initialValue: DEFAULT_TRIGGER_NAME,
    });
    if (clack.isCancel(result)) { clack.cancel('Setup cancelled.'); process.exit(0); }
    triggerName = result || DEFAULT_TRIGGER_NAME;
  }

  // ── Channel policy ──
  let channelPolicy: 'open' | 'open-trigger' | 'allowlist' = 'open';
  if (interactive) {
    const result = await clack.select({
      message: 'Channel Policy — how should the bot handle server channels?',
      options: [
        {
          value: 'open' as const,
          label: 'open',
          hint: 'Respond to all messages in all channels automatically',
        },
        {
          value: 'open-trigger' as const,
          label: 'open-trigger',
          hint: `Listen in all channels, but only respond when @${triggerName} is mentioned`,
        },
        {
          value: 'allowlist' as const,
          label: 'allowlist',
          hint: 'Only respond in manually registered channels (piscord register ...)',
        },
      ],
      initialValue: 'open' as const,
    });
    if (clack.isCancel(result)) { clack.cancel('Setup cancelled.'); process.exit(0); }
    channelPolicy = result;
  }

  // ── Working directory ──
  let workingDir = DEFAULT_WORKING_DIR;
  if (interactive) {
    const result = await clack.text({
      message: 'Working Directory — base directory pi uses when executing commands',
      placeholder: DEFAULT_WORKING_DIR,
      defaultValue: DEFAULT_WORKING_DIR,
      initialValue: DEFAULT_WORKING_DIR,
    });
    if (clack.isCancel(result)) { clack.cancel('Setup cancelled.'); process.exit(0); }
    workingDir = result || DEFAULT_WORKING_DIR;
  }

  // ── Write config ──
  mkdirSync(dirname(configPath), { recursive: true });
  mkdirSync(DEFAULT_DATA_DIR, { recursive: true });
  mkdirSync(DEFAULT_SESSIONS_DIR, { recursive: true });

  writeFileSync(configPath, buildConfigFile({
    token,
    triggerName,
    workingDir,
    channelPolicy,
    sessionsDir: DEFAULT_SESSIONS_DIR,
    dbPath: DEFAULT_DB_PATH,
  }));

  clack.log.success(`Config written to: ${configPath}`);

  // ── Daemon install + start ──
  if (interactive && isLinux()) {
    const installDaemon = await clack.confirm({
      message: 'Install as systemd service and start now?',
      initialValue: true,
    });
    if (clack.isCancel(installDaemon)) { clack.cancel('Setup cancelled.'); process.exit(0); }

    if (installDaemon) {
      const s = clack.spinner();
      s.start('Installing systemd service...');
      try {
        const { runDaemon } = await import('./daemon.js');
        runDaemon('install');
        s.message('Starting service...');
        runDaemon('start');
        s.stop('Service installed and started.');
        clack.log.success('pi-discord-gateway.service is active');
      } catch (err) {
        s.stop('Service installation failed.');
        clack.log.error(errorMessage(err));
        clack.log.info('You can install manually later: piscord daemon install && piscord daemon start');
      }
    }
  }

  // ── Summary ──
  const summaryLines = [
    `Config:    ${configPath}`,
    `Policy:    ${channelPolicy}`,
    `Trigger:   ${triggerName}`,
    `Sessions:  ${DEFAULT_SESSIONS_DIR}`,
  ];
  clack.note(summaryLines.join('\n'), 'Configuration');

  clack.outro('Setup complete! Send a message in any Discord channel to test.');
}

function checkPrerequisites(): {
  piPath: string | undefined;
  piVersion: string | undefined;
  authFound: boolean;
  modelCount: number | undefined;
} {
  const piPath = readCommandOutput('which pi');
  const piVersion = piPath ? readCommandOutput('pi --version') : undefined;
  const authFound = existsSync(AUTH_PATH);
  let modelCount: number | undefined;

  try {
    modelCount = listAvailableModels().length;
  } catch {
    modelCount = undefined;
  }

  return { piPath, piVersion, authFound, modelCount };
}

function isLinux(): boolean {
  return process.platform === 'linux';
}

export function buildConfigFile(options: {
  token: string;
  triggerName: string;
  workingDir: string;
  channelPolicy?: 'open' | 'open-trigger' | 'allowlist';
  sessionsDir: string;
  dbPath: string;
}): string {
  return [
    '# Generated by: piscord setup',
    '# Or edit manually. See: piscord help',
    '',
    `DISCORD_BOT_TOKEN=${options.token}`,
    '',
    '# Pi agent configuration',
    'PI_BIN=pi',
    'PI_MODEL=',
    'PI_THINKING=',
    `PI_CWD=${options.workingDir}`,
    'PI_EXTRA_FLAGS=',
    '',
    '# Gateway behavior',
    `TRIGGER_NAME=${options.triggerName}`,
    'MAX_CONCURRENCY=3',
    'MAX_SCHEDULED_CONCURRENCY=1',
    'POLL_INTERVAL_MS=1000',
    'SHUTDOWN_TIMEOUT_MS=15000',
    'AUTO_REGISTER_DMS=true',
    `CHANNEL_POLICY=${options.channelPolicy ?? 'open'}`,
    'EXCLUDED_CHANNELS=',
    'MAX_ATTACHMENT_BYTES=26214400',
    'MAX_TOTAL_ATTACHMENT_BYTES=52428800',
    '',
    '# Archive',
    'ARCHIVE_RETENTION_DAYS=30',
    '',
    '# Storage',
    `SESSIONS_DIR=${options.sessionsDir}`,
    `DB_PATH=${options.dbPath}`,
    '',
    '# Logging',
    'LOG_LEVEL=info',
    '',
  ].join('\n');
}

function readCommandOutput(command: string): string | undefined {
  try {
    return execSync(command, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim() || undefined;
  } catch {
    return undefined;
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
