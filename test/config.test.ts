import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const originalCwd = process.cwd();
const originalEnv = { ...process.env };
const tempDirs: string[] = [];
const CONFIG_ENV_KEYS = [
  'AUTO_REGISTER_DMS',
  'DB_PATH',
  'DISCORD_BOT_TOKEN',
  'HOME',
  'LOG_LEVEL',
  'MAX_ATTACHMENT_BYTES',
  'MAX_CONCURRENCY',
  'MAX_TOTAL_ATTACHMENT_BYTES',
  'PIDG_CONFIG',
  'PI_BIN',
  'PI_CWD',
  'PI_EXTRA_FLAGS',
  'PI_MODEL',
  'PI_THINKING',
  'POLL_INTERVAL_MS',
  'SESSIONS_DIR',
  'SHUTDOWN_TIMEOUT_MS',
  'TRIGGER_NAME',
];

afterEach(() => {
  vi.resetModules();
  process.chdir(originalCwd);

  for (const key of CONFIG_ENV_KEYS) {
    const value = originalEnv[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('resolveConfigPath', () => {
  it('uses PIDG_CONFIG when set', async () => {
    process.env.PIDG_CONFIG = '~/custom/pi-discord/config.env';

    const { resolveConfigPath } = await loadConfigModule();

    expect(resolveConfigPath()).toBe(resolve(homedir(), 'custom/pi-discord/config.env'));
  });

  it('falls back to the XDG-style default config path', async () => {
    delete process.env.PIDG_CONFIG;

    const { resolveConfigPath } = await loadConfigModule();

    expect(resolveConfigPath().endsWith(join('.config', 'pi-discord-gateway', 'config.env'))).toBe(
      true,
    );
  });
});

describe('config loading', () => {
  it('merges process env over config file over cwd .env fallback', async () => {
    const homeDir = createTempDir();
    const workDir = createTempDir();
    const configPath = resolve(homeDir, 'custom/config.env');

    writeEnvFile(resolve(workDir, '.env'), {
      DB_PATH: '/legacy/gateway.db',
      SESSIONS_DIR: '/legacy/sessions',
      PI_CWD: '/legacy/project',
    });
    writeEnvFile(configPath, {
      DB_PATH: '/config/gateway.db',
      SESSIONS_DIR: '/config/sessions',
      PI_CWD: '/config/project',
    });

    process.chdir(workDir);
    process.env.HOME = homeDir;
    process.env.PIDG_CONFIG = configPath;
    process.env.PI_CWD = '/env/project';
    delete process.env.DB_PATH;
    delete process.env.SESSIONS_DIR;

    const { config, resolveConfigPath } = await loadConfigModule();

    expect(resolveConfigPath()).toBe(configPath);
    expect(config.dbPath).toBe('/config/gateway.db');
    expect(config.sessionsDir).toBe('/config/sessions');
    expect(config.piCwd).toBe('/env/project');
  });

  it('uses the default config file before the cwd .env fallback', async () => {
    const homeDir = createTempDir();
    const workDir = createTempDir();
    const defaultConfigPath = resolve(homeDir, '.config/pi-discord-gateway/config.env');

    writeEnvFile(resolve(workDir, '.env'), {
      DB_PATH: '/legacy/gateway.db',
      SESSIONS_DIR: '/legacy/sessions',
    });
    writeEnvFile(defaultConfigPath, {
      DB_PATH: '/default/gateway.db',
      SESSIONS_DIR: '/default/sessions',
    });

    process.chdir(workDir);
    process.env.HOME = homeDir;
    delete process.env.PIDG_CONFIG;
    delete process.env.DB_PATH;
    delete process.env.SESSIONS_DIR;

    const { config, resolveConfigPath } = await loadConfigModule();

    expect(resolveConfigPath()).toBe(defaultConfigPath);
    expect(config.dbPath).toBe('/default/gateway.db');
    expect(config.sessionsDir).toBe('/default/sessions');
  });

  it('uses the piscord XDG data directory defaults when storage paths are unset', async () => {
    const homeDir = createTempDir();
    const workDir = createTempDir();

    process.chdir(workDir);
    process.env.HOME = homeDir;
    delete process.env.PIDG_CONFIG;
    delete process.env.DB_PATH;
    delete process.env.SESSIONS_DIR;

    const { config } = await loadConfigModule();

    expect(config.dbPath).toBe(resolve(homeDir, '.local/share/piscord-gateway/gateway.db'));
    expect(config.sessionsDir).toBe(resolve(homeDir, '.local/share/piscord-gateway/sessions'));
  });
});

function createTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'pidg-config-'));
  tempDirs.push(dir);
  return dir;
}

function writeEnvFile(filePath: string, values: Record<string, string>): void {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(
    filePath,
    `${Object.entries(values)
      .map(([key, value]) => `${key}=${value}`)
      .join('\n')}\n`,
  );
}

async function loadConfigModule() {
  vi.resetModules();
  return import('../src/config.js');
}
