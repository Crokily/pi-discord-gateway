import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ script: '', send: vi.fn(), find: vi.fn() }));
vi.mock('../src/agent/pi-spawn.js', () => ({
  resolvePiSpawn: async (_bin: string, args: string[]) => ({
    bin: process.execPath,
    args: [state.script, ...args],
  }),
}));
vi.mock('../src/agent/model-catalog.js', async (original) => ({
  ...(await original<typeof import('../src/agent/model-catalog.js')>()),
  scheduleCatalogRefresh: () => {},
}));
vi.mock('../src/discord/client.js', () => ({
  setTyping: async () => {},
  sendResponse: async () => true,
  sendDurableResponse: async (id: number, signal: AbortSignal) => {
    const { deliverResponse } = await import('../src/discord/delivery.js');
    return deliverResponse(id, { send: state.send, find: state.find }, signal);
  },
}));
let directory: string;
let db: typeof import('../src/db.js');
let queue: typeof import('../src/agent/queue.js');
beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), 'piscord-lifecycle-'));
  state.script = join(directory, 'fake-pi.cjs');
  writeFileSync(
    state.script,
    `
const fs = require('node:fs');
const prompt = process.argv.at(-1);
fs.appendFileSync('calls', prompt + '\\n');
if (prompt.includes('BLOCK')) {
  fs.writeFileSync('child-pid', String(process.pid));
  process.on('SIGTERM', () => {});
  setInterval(() => {}, 1000);
} else { console.log(prompt.includes('LONG') ? 'a'.repeat(4200) : 'answer'); }
`,
  );
  for (const [key, value] of Object.entries({
    DB_PATH: join(directory, 'gateway.db'),
    SESSIONS_DIR: join(directory, 'sessions'),
    PI_CWD: directory,
    POLL_INTERVAL_MS: '5',
    MAX_CONCURRENCY: '2',
    LOG_LEVEL: 'silent',
    AGENT_TIMEOUT_MS: '0',
    PI_MODEL: '',
    PI_THINKING: '',
    PI_EXTRA_FLAGS: '',
  }))
    vi.stubEnv(key, value);
  vi.resetModules();
  state.send.mockReset().mockResolvedValue('discord-id');
  state.find.mockReset().mockResolvedValue(undefined);
  db = await import('../src/db.js');
  db.initDb();
  queue = await import('../src/agent/queue.js');
  for (const jid of ['dc:a', 'dc:b'])
    db.registerChannel({
      jid,
      name: jid,
      folder: jid.slice(3),
      requiresTrigger: false,
      isMain: false,
      modelOverride: '',
      thinkingOverride: '',
      cwdOverride: '',
    });
});
afterEach(async () => {
  await queue.stopProcessingLoop({ timeoutMs: 0 });
  db.closeDb();
  vi.unstubAllEnvs();
  rmSync(directory, { recursive: true, force: true });
});
function enqueue(content: string, channelJid = 'dc:a') {
  return db.enqueueMessage({
    channelJid,
    content,
    sender: 'test',
    senderName: 'Test',
    timestamp: new Date().toISOString(),
  });
}
async function started() {
  await vi.waitFor(() =>
    expect(Number(readFileSync(join(directory, 'child-pid'), 'utf8'))).toBeGreaterThan(0),
  );
  return Number(readFileSync(join(directory, 'child-pid'), 'utf8'));
}
async function status(id: number, expected: string) {
  await vi.waitFor(() => expect(db.getQueuedMessage(id)?.status).toBe(expected), { timeout: 5000 });
}
describe('queue with real supervised processes and durable SQLite', () => {
  it('enforces the configured timeout on a real process that ignores termination', async () => {
    vi.stubEnv('AGENT_TIMEOUT_MS', '700');
    vi.resetModules();
    const { invokeAgent } = await import('../src/agent/invoke.js');
    const result = await invokeAgent('timeout', 'BLOCK');
    expect(result).toMatchObject({ ok: false, reason: 'timeout' });
    const pid = Number(readFileSync(join(directory, 'child-pid'), 'utf8'));
    expect(() => process.kill(pid, 0)).toThrow();
  });

  it('cancels active and queued work without affecting another conversation', async () => {
    const active = enqueue('BLOCK');
    const pending = enqueue('SHOULD-NOT-RUN');
    const other = enqueue('OTHER', 'dc:b');
    queue.startProcessingLoop();
    const pid = await started();
    expect(queue.abortChannelTask('dc:a')).toEqual({ aborted: true, cleared: 1 });
    await status(other, 'done');
    await queue.stopProcessingLoop({ timeoutMs: 0 });
    expect(() => process.kill(pid, 0)).toThrow();
    expect(db.getQueuedMessage(active)?.status).toBe('cancelled');
    expect(db.getQueuedMessage(pending)?.status).toBe('cancelled');
    expect(readFileSync(join(directory, 'calls'), 'utf8')).not.toContain('SHOULD-NOT-RUN');
  });
  it('interrupts execution on shutdown and runs only pending work after restart', async () => {
    const active = enqueue('BLOCK');
    const pending = enqueue('NEXT');
    queue.startProcessingLoop();
    const pid = await started();
    await queue.stopProcessingLoop({ timeoutMs: 0 });
    expect(() => process.kill(pid, 0)).toThrow();
    expect(db.getQueuedMessage(active)?.status).toBe('interrupted');
    db.closeDb();
    db.initDb();
    queue.startProcessingLoop();
    await status(pending, 'done');
    expect(readFileSync(join(directory, 'calls'), 'utf8').match(/BLOCK/g)).toHaveLength(1);
  });
  it('persists long responses and resumes delivery without another invocation', async () => {
    const id = enqueue('LONG');
    state.send
      .mockResolvedValueOnce('first')
      .mockRejectedValueOnce(new Error('network timeout'))
      .mockResolvedValue('rest');
    queue.startProcessingLoop();
    await vi.waitFor(() => expect(db.getQueuedMessage(id)?.delivery_attempts).toBe(1));
    await queue.stopProcessingLoop({ timeoutMs: 0 });
    db.closeDb();
    db.initDb();
    db.retryDelivery(id, 0);
    queue.startProcessingLoop();
    await status(id, 'done');
    expect(state.send.mock.calls.map((call) => call[1].length)).toEqual([2000, 2000, 2000, 200]);
    expect(db.getResponseChunks(id).every((chunk) => chunk.status === 'sent')).toBe(true);
    expect(readFileSync(join(directory, 'calls'), 'utf8').match(/LONG/g)).toHaveLength(1);
  });
});
