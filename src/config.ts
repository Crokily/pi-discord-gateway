import { parse } from 'dotenv';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, resolve } from 'node:path';

const DEFAULT_CONFIG_PATH = defaultConfigPath();
const DEFAULT_DATA_DIR = defaultDataDir();
const LEGACY_ENV_PATH = resolve(process.cwd(), '.env');
const CONFIG_SOURCE = buildConfigSource();

function defaultConfigPath(): string {
  switch (process.platform) {
    case 'win32':
      return resolve(
        process.env.APPDATA || resolve(homedir(), 'AppData/Roaming'),
        'piscord-gateway/config.env',
      );
    case 'darwin':
      return resolve(homedir(), 'Library/Application Support/piscord-gateway/config.env');
    default:
      return resolve(homedir(), '.config', 'pi-discord-gateway', 'config.env');
  }
}

export function defaultDataDir(): string {
  switch (process.platform) {
    case 'win32':
      return resolve(
        process.env.LOCALAPPDATA || resolve(homedir(), 'AppData/Local'),
        'piscord-gateway',
      );
    case 'darwin':
      return resolve(homedir(), 'Library/Application Support/piscord-gateway');
    default:
      return resolve(homedir(), '.local/share', 'piscord-gateway');
  }
}

export function resolveConfigPath(): string {
  const configuredPath = process.env.PIDG_CONFIG?.trim() ?? '';
  if (configuredPath) {
    return resolveUserPath(configuredPath);
  }

  return DEFAULT_CONFIG_PATH;
}

function resolveUserPath(inputPath: string): string {
  const expanded = expandHome(inputPath.trim());
  return isAbsolute(expanded) ? expanded : resolve(expanded);
}

function expandHome(inputPath: string): string {
  if (inputPath === '~') {
    return homedir();
  }

  if (inputPath.startsWith('~/')) {
    return resolve(homedir(), inputPath.slice(2));
  }

  return inputPath;
}

function readEnvValue(key: string): string | undefined {
  return CONFIG_SOURCE[key];
}

function buildConfigSource(): Record<string, string> {
  return {
    ...loadEnvFile(LEGACY_ENV_PATH),
    ...loadEnvFile(resolveConfigPath()),
    ...readProcessEnv(),
  };
}

function loadEnvFile(filePath: string): Record<string, string> {
  try {
    return parse(readFileSync(filePath, 'utf8'));
  } catch (error) {
    if (isMissingFileError(error)) {
      return {};
    }

    throw error;
  }
}

function readProcessEnv(): Record<string, string> {
  const values: Record<string, string> = {};

  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) {
      values[key] = value;
    }
  }

  return values;
}

function isMissingFileError(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

function env(key: string, fallback = ''): string {
  return (readEnvValue(key) ?? '').trim() || fallback;
}

function envInt(key: string, fallback: number, opts: { min?: number } = {}): number {
  const raw = env(key);
  if (!raw) return fallback;

  const v = Number.parseInt(raw, 10);
  if (Number.isNaN(v)) return fallback;
  if (opts.min !== undefined && v < opts.min) return fallback;
  return v;
}

function envBool(key: string, fallback: boolean): boolean {
  const v = env(key).toLowerCase();
  if (!v) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(v);
}

const VALID_CHANNEL_POLICIES = ['open', 'open-trigger', 'allowlist'] as const;
type ChannelPolicy = (typeof VALID_CHANNEL_POLICIES)[number];

function parseChannelPolicy(value: string): ChannelPolicy {
  if ((VALID_CHANNEL_POLICIES as readonly string[]).includes(value)) {
    return value as ChannelPolicy;
  }
  return 'allowlist';
}

export const config = {
  /** Discord bot token (required) */
  discordToken: env('DISCORD_BOT_TOKEN'),

  /** Pi binary path */
  piBin: env('PI_BIN', 'pi'),

  /** Default model for pi */
  piModel: env('PI_MODEL'),

  /** Thinking level for pi */
  piThinking: env('PI_THINKING'),

  /** Base directory for per-channel session folders */
  sessionsDir: env('SESSIONS_DIR', resolve(DEFAULT_DATA_DIR, 'sessions')),

  /** Days to retain archived sessions (0 = never clean) */
  archiveRetentionDays: envInt('ARCHIVE_RETENTION_DAYS', 30, { min: 0 }),

  /** SQLite database path */
  dbPath: env('DB_PATH', resolve(DEFAULT_DATA_DIR, 'gateway.db')),

  /** Bot trigger name (default: bot's own display name) */
  triggerName: env('TRIGGER_NAME', 'pi'),

  /** Max concurrent agent invocations */
  maxConcurrency: envInt('MAX_CONCURRENCY', 3, { min: 1 }),

  /** Max scheduled tasks enqueued per scheduler tick */
  maxScheduledConcurrency: envInt('MAX_SCHEDULED_CONCURRENCY', 1, { min: 1 }),

  /** Poll interval for message queue (ms) */
  pollInterval: envInt('POLL_INTERVAL_MS', 1000, { min: 1 }),

  /** Graceful shutdown timeout before aborting in-flight tasks (ms) */
  shutdownTimeoutMs: envInt('SHUTDOWN_TIMEOUT_MS', 15_000, { min: 0 }),

  /** Log level */
  logLevel: env('LOG_LEVEL', 'info'),

  /** Working directory for pi agent */
  piCwd: env('PI_CWD', homedir()),

  /** Extra pi flags (space-separated) */
  piExtraFlags: env('PI_EXTRA_FLAGS'),

  /** Auto-register DM channels */
  autoRegisterDMs: envBool('AUTO_REGISTER_DMS', true),

  /** Channel access policy: open, open-trigger, or allowlist */
  channelPolicy: parseChannelPolicy(env('CHANNEL_POLICY', 'allowlist')),

  /** Comma-separated channel IDs to exclude from auto-registration */
  excludedChannels: new Set(
    env('EXCLUDED_CHANNELS')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  ),

  /** Max size for a single Discord attachment in bytes (0 disables the limit) */
  maxAttachmentBytes: envInt('MAX_ATTACHMENT_BYTES', 25 * 1024 * 1024, { min: 0 }),

  /** Max combined attachment size per Discord message in bytes (0 disables the limit) */
  maxTotalAttachmentBytes: envInt('MAX_TOTAL_ATTACHMENT_BYTES', 50 * 1024 * 1024, { min: 0 }),

  /**
   * When true, the first @-mention in a registered parent text channel
   * spawns a Discord thread on that message; subsequent replies are
   * routed into the thread.  The thread inherits its parent's workspace
   * (cwd), model, and thinking overrides; it gets its own session-dir so
   * each thread is an isolated Pi conversation history.
   */
  autoThread: envBool('AUTO_THREAD', false),

  /**
   * Thread auto-archive duration in minutes.  Discord accepts 60, 1440,
   * 4320, or 10080 — values outside that set may be downgraded by the
   * server to the closest allowed option.
   */
  autoThreadArchiveMinutes: envInt('AUTO_THREAD_ARCHIVE_MIN', 1440, { min: 1 }),
} as const;

export type Config = typeof config;
