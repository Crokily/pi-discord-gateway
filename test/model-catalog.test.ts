import { ModelRuntime, SettingsManager } from '@earendil-works/pi-coding-agent';
import type { Model } from '@earendil-works/pi-ai';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  __setCachedModelRuntimeForTests,
  isModelCatalogStale,
  listSelectableModels,
  parsePiModelList,
} from '../src/agent/model-catalog.js';
import { config } from '../src/config.js';

const { spawnSyncMock } = vi.hoisted(() => ({ spawnSyncMock: vi.fn() }));

vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  spawnSync: spawnSyncMock,
}));

const models = [
  {
    provider: 'test',
    id: 'alpha',
    name: 'Alpha',
    reasoning: false,
  },
  {
    provider: 'test',
    id: 'beta',
    name: 'Beta',
    reasoning: true,
  },
  {
    provider: 'other',
    id: 'gamma',
    name: 'Gamma',
    reasoning: true,
  },
] as Model<any>[];

// `ModelRegistry` is a thin facade that delegates `getAvailable()` to
// `runtime.getAvailableSnapshot()`, so a runtime stub returning `models` is
// enough to drive the SDK catalog path.
const runtimeStub = {
  getAvailableSnapshot: () => models,
} as unknown as ModelRuntime;

const defaultCliOutput = `provider  model  context  max-out  thinking  images
other    gamma  128K     16K      yes       no
test     alpha  128K     16K      no        no
test     beta   128K     16K      yes       no
`;

function mockPiCatalog(enabledModels?: string[], cliOutput = defaultCliOutput): void {
  spawnSyncMock.mockReturnValue({ status: 0, stdout: cliOutput, stderr: '' });
  vi.spyOn(SettingsManager, 'create').mockReturnValue(SettingsManager.inMemory({ enabledModels }));
  __setCachedModelRuntimeForTests(runtimeStub);
}

afterEach(() => {
  vi.restoreAllMocks();
  spawnSyncMock.mockReset();
  __setCachedModelRuntimeForTests(null);
});

describe('listSelectableModels', () => {
  it('returns every available model when enabledModels is not configured', async () => {
    mockPiCatalog();

    const result = await listSelectableModels({ forceRefresh: true, cwd: '/tmp/project' });

    expect(result.map((model) => model.ref)).toEqual(['other/gamma', 'test/alpha', 'test/beta']);
    expect(SettingsManager.create).toHaveBeenCalledWith('/tmp/project');
  });

  it('uses pi enabledModels semantics and preserves configured order', async () => {
    mockPiCatalog(['other/gamma', 'test/alpha']);

    const result = await listSelectableModels({ forceRefresh: true });

    expect(result.map((model) => model.ref)).toEqual(['other/gamma', 'test/alpha']);
  });

  it('supports the same glob patterns as pi scoped models', async () => {
    mockPiCatalog(['test/*']);

    const result = await listSelectableModels({ forceRefresh: true });

    expect(result.map((model) => model.ref)).toEqual(['test/alpha', 'test/beta']);
  });

  it('uses the configured pi binary as the authoritative model source', async () => {
    mockPiCatalog(
      ['test/delta'],
      `${defaultCliOutput}test     delta  256K     32K      yes       yes\n`,
    );

    const result = await listSelectableModels({ forceRefresh: true });

    expect(result.map((model) => model.ref)).toEqual(['test/delta']);
  });

  it('falls back to the SDK catalog when pi --list-models fails', async () => {
    mockPiCatalog(['test/beta']);
    spawnSyncMock.mockReturnValue({ status: 1, stdout: '', stderr: 'failed' });

    const result = await listSelectableModels({ forceRefresh: true });

    expect(result.map((model) => model.ref)).toEqual(['test/beta']);
  });

  it('keeps a successful empty pi catalog empty instead of falling back', async () => {
    mockPiCatalog(undefined, 'provider  model  context  max-out  thinking  images\n');

    const result = await listSelectableModels({ forceRefresh: true });

    expect(result).toEqual([]);
  });

  it('falls back to the SDK catalog when pi --list-models errors out', async () => {
    mockPiCatalog(['test/beta']);
    spawnSyncMock.mockReturnValue({
      error: new Error('spawnSync pi ETIMEDOUT'),
      status: null,
      stdout: '',
      stderr: '',
    });

    const result = await listSelectableModels({ forceRefresh: true });

    expect(result.map((model) => model.ref)).toEqual(['test/beta']);
  });

  it('bounds the pi --list-models subprocess with a timeout', async () => {
    mockPiCatalog();

    await listSelectableModels({ forceRefresh: true });

    expect(spawnSyncMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ timeout: expect.any(Number) }),
    );
  });

  it('passes PI_EXTRA_FLAGS to model discovery like the agent invocation', async () => {
    mockPiCatalog();
    const mutableConfig = config as { piExtraFlags: string };
    const previousFlags = mutableConfig.piExtraFlags;
    mutableConfig.piExtraFlags = '-e ./provider.ts --approve';

    try {
      await listSelectableModels({ forceRefresh: true });
    } finally {
      mutableConfig.piExtraFlags = previousFlags;
    }

    expect(spawnSyncMock).toHaveBeenCalledWith(
      expect.anything(),
      ['--list-models', '-e', './provider.ts', '--approve'],
      expect.anything(),
    );
  });
});

describe('isModelCatalogStale', () => {
  it('treats never-loaded catalogs as stale', () => {
    expect(isModelCatalogStale('/tmp/never-loaded')).toBe(true);
  });

  it('reports stale once the cache TTL elapses', async () => {
    vi.useFakeTimers();
    try {
      mockPiCatalog();
      await listSelectableModels({ forceRefresh: true, cwd: '/tmp/stale-check' });

      expect(isModelCatalogStale('/tmp/stale-check')).toBe(false);

      vi.advanceTimersByTime(31_000);
      expect(isModelCatalogStale('/tmp/stale-check')).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('ModelRuntime bootstrap', () => {
  it('does not crash when the runtime is not ready yet (CLI catalog still serves)', async () => {
    // No cached runtime -> createModelRegistry() returns the stub (empty SDK
    // list). The CLI catalog must still produce models.
    __setCachedModelRuntimeForTests(null);
    spawnSyncMock.mockReturnValue({ status: 0, stdout: defaultCliOutput, stderr: '' });
    vi.spyOn(SettingsManager, 'create').mockReturnValue(SettingsManager.inMemory({}));

    const result = await listSelectableModels({ forceRefresh: true, cwd: '/tmp/no-runtime' });

    expect(result.map((model) => model.ref)).toEqual([
      'other/gamma',
      'test/alpha',
      'test/beta',
    ]);
  });

  it('boots ModelRuntime.create() lazily and caches it for later reads', async () => {
    __setCachedModelRuntimeForTests(null);
    const freshRuntime = {
      getAvailableSnapshot: () => models,
    } as unknown as ModelRuntime;
    const createSpy = vi.spyOn(ModelRuntime, 'create').mockResolvedValue(freshRuntime);
    spawnSyncMock.mockReturnValue({ status: 0, stdout: defaultCliOutput, stderr: '' });
    vi.spyOn(SettingsManager, 'create').mockReturnValue(SettingsManager.inMemory({}));

    // First read triggers bootstrap; SDK models are unavailable this tick.
    await listSelectableModels({ forceRefresh: true, cwd: '/tmp/bootstrap' });
    expect(createSpy).toHaveBeenCalledTimes(1);

    // Let the resolved runtime (and its .then cache-population) settle.
    await new Promise((resolve) => setImmediate(resolve));

    // Subsequent reads reuse the cached runtime without re-invoking create().
    const second = await listSelectableModels({ forceRefresh: true, cwd: '/tmp/bootstrap' });
    expect(createSpy).toHaveBeenCalledTimes(1);
    // CLI catalog is still authoritative when present, so refs are unchanged;
    // the point is that no exception is thrown and the runtime is reused.
    expect(second.length).toBeGreaterThan(0);
  });

  it('survives a failing ModelRuntime.create() without throwing', async () => {
    __setCachedModelRuntimeForTests(null);
    vi.spyOn(ModelRuntime, 'create').mockRejectedValue(new Error('boom'));
    spawnSyncMock.mockReturnValue({ status: 0, stdout: defaultCliOutput, stderr: '' });
    vi.spyOn(SettingsManager, 'create').mockReturnValue(SettingsManager.inMemory({}));

    const result = await listSelectableModels({ forceRefresh: true, cwd: '/tmp/failed-runtime' });

    expect(result.map((model) => model.ref)).toEqual([
      'other/gamma',
      'test/alpha',
      'test/beta',
    ]);
  });
});

describe('parsePiModelList', () => {
  it('parses pi --list-models table output', () => {
    expect(parsePiModelList(defaultCliOutput)).toEqual([
      expect.objectContaining({ ref: 'other/gamma', reasoning: true }),
      expect.objectContaining({ ref: 'test/alpha', reasoning: false }),
      expect.objectContaining({ ref: 'test/beta', reasoning: true }),
    ]);
  });

  it('skips banner output written before the table header', () => {
    const output = `Loaded extension ./provider.ts\nwarning: model cache rebuilt\n${defaultCliOutput}`;

    expect(parsePiModelList(output)).toEqual([
      expect.objectContaining({ ref: 'other/gamma', reasoning: true }),
      expect.objectContaining({ ref: 'test/alpha', reasoning: false }),
      expect.objectContaining({ ref: 'test/beta', reasoning: true }),
    ]);
  });

  it('returns an empty catalog when no table header is present', () => {
    expect(parsePiModelList('no models available\n')).toEqual([]);
  });
});
