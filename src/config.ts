import { config as loadDotenv } from 'dotenv';
import { resolve } from 'node:path';
import { homedir } from 'node:os';

loadDotenv();

function env(key: string, fallback = ''): string {
  return (process.env[key] ?? '').trim() || fallback;
}

function envInt(key: string, fallback: number): number {
  const v = parseInt(env(key), 10);
  return Number.isNaN(v) ? fallback : v;
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
  maxConcurrency: envInt('MAX_CONCURRENCY', 3),

  /** Poll interval for message queue (ms) */
  pollInterval: envInt('POLL_INTERVAL_MS', 1000),

  /** Log level */
  logLevel: env('LOG_LEVEL', 'info'),

  /** Working directory for pi agent */
  piCwd: env('PI_CWD', homedir()),

  /** Extra pi flags (space-separated) */
  piExtraFlags: env('PI_EXTRA_FLAGS'),

  /** Auto-register DM channels */
  autoRegisterDMs: envBool('AUTO_REGISTER_DMS', true),
} as const;

export type Config = typeof config;
