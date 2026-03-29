import { config as loadDotenv } from 'dotenv';
import { resolve } from 'node:path';
import { homedir } from 'node:os';

loadDotenv();

function env(key: string, fallback = ''): string {
  return (process.env[key] ?? '').trim() || fallback;
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
  sessionsDir: env('SESSIONS_DIR', resolve(homedir(), 'pi-discord-gateway/sessions')),

  /** SQLite database path */
  dbPath: env('DB_PATH', resolve(homedir(), 'pi-discord-gateway/gateway.db')),

  /** Bot trigger name (default: bot's own display name) */
  triggerName: env('TRIGGER_NAME', 'Andy'),

  /** Max concurrent agent invocations */
  maxConcurrency: envInt('MAX_CONCURRENCY', 3, { min: 1 }),

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

  /** Max size for a single Discord attachment in bytes (0 disables the limit) */
  maxAttachmentBytes: envInt('MAX_ATTACHMENT_BYTES', 25 * 1024 * 1024, { min: 0 }),

  /** Max combined attachment size per Discord message in bytes (0 disables the limit) */
  maxTotalAttachmentBytes: envInt('MAX_TOTAL_ATTACHMENT_BYTES', 50 * 1024 * 1024, { min: 0 }),
} as const;

export type Config = typeof config;
