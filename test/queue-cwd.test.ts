import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { invokeAgentMock, sendResponseMock, setTypingMock } = vi.hoisted(() => ({
  invokeAgentMock: vi.fn(),
  sendResponseMock: vi.fn(),
  setTypingMock: vi.fn(),
}));

vi.mock('../src/agent/invoke.js', () => ({
  invokeAgent: invokeAgentMock,
}));

vi.mock('../src/discord/client.js', () => ({
  sendResponse: sendResponseMock,
  setTyping: setTypingMock,
}));

const originalEnv = { ...process.env };
const tempDirs: string[] = [];
const CONFIG_ENV_KEYS = [
  'DB_PATH',
  'MAX_CONCURRENCY',
  'PI_CWD',
  'POLL_INTERVAL_MS',
  'SESSIONS_DIR',
];

afterEach(() => {
  vi.clearAllMocks();
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

describe('queue cwd selection', () => {
  it('passes a channel-specific cwd override to invokeAgent', async () => {
    const call = await runQueuedMessage('/workspace/project');
    expect(call?.cwd).toBe('/workspace/project');
  });

  it('falls back to the global PI_CWD when no channel override is configured', async () => {
    const call = await runQueuedMessage('');
    expect(call?.cwd).toBe('/global/project');
  });
});

async function runQueuedMessage(cwdOverride: string): Promise<{ cwd?: string } | undefined> {
  const tempDir = mkdtempSync(join(tmpdir(), 'pidg-queue-cwd-'));
  tempDirs.push(tempDir);

  process.env.DB_PATH = ':memory:';
  process.env.SESSIONS_DIR = resolve(tempDir, 'sessions');
  process.env.POLL_INTERVAL_MS = '1';
  process.env.MAX_CONCURRENCY = '1';
  process.env.PI_CWD = '/global/project';

  invokeAgentMock.mockResolvedValue({ ok: true, text: 'done' });
  sendResponseMock.mockResolvedValue(true);
  setTypingMock.mockResolvedValue(undefined);

  vi.resetModules();
  const db = await import('../src/db.js');
  const queue = await import('../src/agent/queue.js');

  db.initDb();

  try {
    db.registerChannel({
      jid: 'dc:123',
      name: 'queue test',
      folder: 'ch_123',
      requiresTrigger: false,
      isMain: false,
      modelOverride: '',
      thinkingOverride: '',
      cwdOverride,
    });
    db.enqueueMessage({
      channelJid: 'dc:123',
      sender: 'u_1',
      senderName: 'Alice',
      content: 'hello',
      timestamp: new Date().toISOString(),
    });

    queue.startProcessingLoop();
    await vi.waitFor(
      () => {
        expect(invokeAgentMock).toHaveBeenCalledTimes(1);
        expect(sendResponseMock).toHaveBeenCalledTimes(1);
      },
      { timeout: 2000, interval: 10 },
    );

    return invokeAgentMock.mock.calls[0]?.[2] as { cwd?: string } | undefined;
  } finally {
    await queue.stopProcessingLoop({ timeoutMs: 1000 });
    db.closeDb();
  }
}
