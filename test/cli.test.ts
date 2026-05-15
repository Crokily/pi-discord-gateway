import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { sendFilesToDiscordMock } = vi.hoisted(() => ({
  sendFilesToDiscordMock: vi.fn(),
}));

vi.mock('../src/discord/send.js', () => ({
  sendFilesToDiscord: sendFilesToDiscordMock,
}));

const originalEnv = { ...process.env };
const tempDirs: string[] = [];
const CONFIG_ENV_KEYS = ['DB_PATH', 'HOME', 'PI_CWD', 'PIDG_CONFIG', 'SESSIONS_DIR'];

afterEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
  vi.resetModules();

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

describe('formatHelpText', () => {
  it('mentions the primary distribution commands, send usage, and cwd registration option', async () => {
    vi.resetModules();
    const { formatHelpText } = await import('../src/cli/index.js');
    const help = formatHelpText();

    expect(help).toContain('piscord setup');
    expect(help).toContain('piscord start');
    expect(help).toContain('piscord status');
    expect(help).toContain('piscord register');
    expect(help).toContain('piscord daemon install');
    expect(help).toContain('piscord send --channel <jid> [--text <message>] [--file <path> ...]');
    expect(help).toContain('--cwd <path>');
  });
});

describe('send command', () => {
  it('allows text-only sends and normalizes the channel id', async () => {
    sendFilesToDiscordMock.mockResolvedValue({ sentFiles: 0 });

    vi.resetModules();
    const { main } = await import('../src/cli/index.js');
    const logged: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args) => {
      logged.push(args.join(' '));
    });

    await expect(main(['send', '--channel', '123', '--text', 'hello'])).resolves.toBe(0);
    expect(sendFilesToDiscordMock).toHaveBeenCalledWith({
      channelJid: 'dc:123',
      text: 'hello',
      files: [],
    });
    expect(logged.join('\n')).toContain('Sent message to dc:123');
  });

  it('rejects send requests with neither text nor files', async () => {
    vi.resetModules();
    const { main } = await import('../src/cli/index.js');

    await expect(main(['send', '--channel', '123'])).rejects.toThrow(
      'At least one of --text or --file is required.',
    );
    expect(sendFilesToDiscordMock).not.toHaveBeenCalled();
  });
});

describe('register command cwd support', () => {
  it('stores a per-channel cwd override and shows it in channel listings', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'pidg-cli-'));
    tempDirs.push(tempDir);

    process.env.DB_PATH = resolve(tempDir, 'gateway.db');
    process.env.SESSIONS_DIR = resolve(tempDir, 'sessions');
    process.env.PI_CWD = '/global/project';

    vi.resetModules();
    const { main } = await import('../src/cli/index.js');
    const logged: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args) => {
      logged.push(args.join(' '));
    });

    await expect(
      main(['register', '123', 'my-server #general', '--cwd', '/workspace/project']),
    ).resolves.toBe(0);
    expect(logged.join('\n')).toContain('Working directory: /workspace/project (channel override)');

    const db = await import('../src/db.js');
    db.initDb();
    try {
      expect(db.getChannel('dc:123')).toMatchObject({
        jid: 'dc:123',
        cwdOverride: '/workspace/project',
      });
    } finally {
      db.closeDb();
    }

    logged.length = 0;
    await expect(main(['channels'])).resolves.toBe(0);
    expect(logged.join('\n')).toContain('cwd=/workspace/project (channel)');
  });
});
