import { afterEach, describe, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({
  stopQueue: vi.fn(),
  stopThreads: vi.fn(),
  closeDb: vi.fn(),
  started: vi.fn(),
  release: vi.fn(),
}));
vi.mock('../src/config.js', () => ({
  config: {
    discordToken: 'fixture',
    dbPath: ':fixture:',
    shutdownTimeoutMs: 1234,
    piCwd: '/fixture',
  },
}));
vi.mock('../src/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));
vi.mock('../src/db.js', () => ({
  initDb: vi.fn(),
  closeDb: state.closeDb,
  getAllChannels: () => [],
}));
vi.mock('../src/instance-lock.js', () => ({ acquireInstanceLock: async () => state.release }));
vi.mock('../src/discord/client.js', () => ({
  startDiscord: async () => {},
  stopDiscord: vi.fn(),
  getBotTag: () => 'fixture',
}));
vi.mock('../src/agent/model-catalog.js', () => ({
  refreshModelCatalog: async () => [],
  stopModelCatalog: async () => {},
}));
vi.mock('../src/agent/queue.js', () => ({
  startProcessingLoop: state.started,
  stopProcessingLoop: state.stopQueue,
}));
vi.mock('../src/agent/scheduler.js', () => ({ startScheduler: () => () => {} }));
vi.mock('../src/discord/threads.js', () => ({ startThreadMaintenance: () => state.stopThreads }));
vi.mock('../src/session/archive-cleanup.js', () => ({ startArchiveCleanup: () => () => {} }));
vi.mock('../src/session/media.js', () => ({ startMediaCleanup: () => () => {} }));
afterEach(() => vi.clearAllMocks());
describe('gateway shutdown ordering', () => {
  it('stops dispatch and starts its grace period before waiting for maintenance', async () => {
    let finishMaintenance!: () => void;
    const maintenance = new Promise<void>((resolve) => {
      finishMaintenance = resolve;
    });
    state.stopThreads.mockReturnValue(maintenance);
    state.stopQueue.mockResolvedValue(undefined);
    const { startGateway } = await import('../src/index.js');
    const gateway = startGateway();
    try {
      await vi.waitFor(() => expect(state.started).toHaveBeenCalledOnce());
      process.emit('SIGTERM', 'SIGTERM');
      await vi.waitFor(() => expect(state.stopThreads).toHaveBeenCalledOnce());
      expect(state.stopQueue).toHaveBeenCalledWith({ timeoutMs: 1234 });
      expect(state.stopQueue.mock.invocationCallOrder[0]).toBeLessThan(
        state.stopThreads.mock.invocationCallOrder[0],
      );
      expect(state.closeDb).not.toHaveBeenCalled();
    } finally {
      finishMaintenance();
      await gateway;
    }
    expect(state.closeDb).toHaveBeenCalledOnce();
    expect(state.release).toHaveBeenCalledOnce();
  });
});
