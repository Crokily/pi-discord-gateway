import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  ModelCatalog,
  parsePiModelList,
  resolveEnabledModelScope,
  type AvailableModelInfo,
} from '../src/agent/model-catalog.js';
const defaultCliOutput = `provider  model  context  max-out  thinking  images
other    gamma  128K     16K      yes       no
test     alpha  128K     16K      no        no
test     beta   128K     16K      yes       no
`;
const models = parsePiModelList(defaultCliOutput)!;
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};

describe('asynchronous model discovery', () => {
  it('waits for refreshed scope settings without waiting for all SDK metadata', async () => {
    const metadata = deferred<AvailableModelInfo[]>();
    let report!: (patterns: string[]) => void;
    let generation = 0;
    const catalog = new ModelCatalog({
      cli: async () => models,
      sdk: async (_cwd, _signal, settings) => {
        if (++generation === 1) {
          settings(['test/alpha']);
          return models;
        }
        report = settings;
        return metadata.promise;
      },
    });
    await catalog.refresh('/a');
    await catalog.refresh('/a');
    let settled = false;
    const ready = catalog.waitForSettings('/a').then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    report(['test/beta']);
    await ready;
    expect(catalog.selectable('/a').map((model) => model.id)).toEqual(['beta']);
    metadata.resolve(models);
    await catalog.stop();
  });
  it('does not accept old settings when the current settings probe fails', async () => {
    let generation = 0;
    const catalog = new ModelCatalog({
      cli: async () => models,
      sdk: async (_cwd, _signal, settings) => {
        if (++generation > 1) throw new Error('settings unavailable');
        settings(['test/alpha']);
        return models;
      },
    });
    await catalog.refresh('/a');
    await catalog.refresh('/a');
    await expect(catalog.waitForSettings('/a')).rejects.toThrow(
      'settings are temporarily unavailable',
    );
    await catalog.stop();
  });
  it('starts a fresh settings probe when earlier metadata is still running', async () => {
    const metadata = deferred<AvailableModelInfo[]>();
    let generation = 0;
    const catalog = new ModelCatalog({
      cli: async () => models,
      sdk: async (_cwd, _signal, settings) => {
        settings([++generation === 1 ? 'test/alpha' : 'test/beta']);
        return generation === 1 ? metadata.promise : models;
      },
    });
    await catalog.refresh('/a');
    const refresh = catalog.refresh('/a');
    metadata.resolve(models);
    await refresh;
    await catalog.waitForSettings('/a');
    expect(generation).toBe(2);
    expect(catalog.selectable('/a').map((model) => model.id)).toEqual(['beta']);
    await catalog.stop();
  });

  it('counts slow SDK probes against the warm-up concurrency limit after CLI results arrive', async () => {
    const probes = [
      deferred<AvailableModelInfo[]>(),
      deferred<AvailableModelInfo[]>(),
      deferred<AvailableModelInfo[]>(),
    ];
    let started = 0;
    const catalog = new ModelCatalog({
      cli: async () => models,
      sdk: () => probes[started++].promise,
    });
    const first = catalog.refresh('/one');
    const second = catalog.refresh('/two');
    const third = catalog.refresh('/three');
    await Promise.all([first, second]);
    expect(started).toBe(2);
    probes[0].resolve(models);
    await third;
    expect(started).toBe(3);
    probes[1].resolve(models);
    probes[2].resolve(models);
    await catalog.stop();
  });
  it('serves cold reads immediately and coalesces concurrent refreshes', async () => {
    const pending = deferred<AvailableModelInfo[]>();
    const cli = vi.fn(() => pending.promise);
    const catalog = new ModelCatalog({
      cli,
      sdk: async (_cwd, _signal, settings) => {
        settings([]);
        return models;
      },
    });
    expect(catalog.read('/a')).toEqual([]);
    expect(cli).not.toHaveBeenCalled();
    const first = catalog.refresh('/a');
    const second = catalog.refresh('/a');
    expect(first).toBe(second);
    expect(catalog.read('/a')).toEqual([]);
    pending.resolve(models);
    await first;
    expect(cli).toHaveBeenCalledTimes(1);
    expect(catalog.read('/a')).toHaveLength(3);
  });
  it('returns CLI models without waiting for SDK metadata and enriches them later', async () => {
    const pending = deferred<AvailableModelInfo[]>();
    const catalog = new ModelCatalog({
      cli: async () => models,
      sdk: (_cwd, _signal, settings) => {
        settings([]);
        return pending.promise;
      },
    });
    await catalog.refresh('/a');
    expect(catalog.read('/a')).toHaveLength(3);
    pending.resolve([{ ...models[1], name: 'Alpha display name' }]);
    await pending.promise;
    expect(catalog.read('/a').find((m) => m.id === 'alpha')?.name).toBe('Alpha display name');
  });
  it('waits for the real cold SDK fallback rather than caching an empty bootstrap', async () => {
    const pending = deferred<AvailableModelInfo[]>();
    const catalog = new ModelCatalog({ cli: async () => undefined, sdk: () => pending.promise });
    const refresh = catalog.refresh('/a');
    await Promise.resolve();
    expect(catalog.has('/a')).toBe(false);
    pending.resolve(models);
    await refresh;
    expect(catalog.read('/a')).toHaveLength(3);
  });
  it('keeps stale data on failure, backs off, and accepts an authoritative empty result', async () => {
    let now = 100;
    const cli = vi.fn<() => Promise<AvailableModelInfo[] | undefined>>().mockResolvedValue(models);
    const catalog = new ModelCatalog({ cli, sdk: async () => models }, () => now);
    await catalog.refresh('/a');
    now += 31_000;
    cli.mockResolvedValue(undefined);
    await expect(catalog.refresh('/a')).rejects.toThrow('temporarily unavailable');
    expect(catalog.status('/a')).toBe('stale');
    expect(catalog.read('/a')).toHaveLength(3);
    catalog.schedule('/a');
    expect(cli).toHaveBeenCalledTimes(2);
    cli.mockResolvedValue([]);
    await catalog.refresh('/a');
    expect(catalog.read('/a')).toEqual([]);
    expect(catalog.status('/a')).toBe('ready');
  });
  it('keeps project scopes and catalogs isolated and reloads changed settings', async () => {
    let scope = ['test/alpha'];
    const catalog = new ModelCatalog({
      cli: async () => models,
      sdk: async (cwd, _signal, settings) => {
        settings(cwd === resolve('/a') ? scope : ['other/*']);
        return models;
      },
    });
    await Promise.all([catalog.refresh('/a'), catalog.refresh('/b')]);
    expect(catalog.selectable('/a').map((m) => m.id)).toEqual(['alpha']);
    expect(catalog.selectable('/b').map((m) => m.id)).toEqual(['gamma']);
    scope = ['test/beta'];
    await catalog.refresh('/a');
    expect(catalog.selectable('/a').map((m) => m.id)).toEqual(['beta']);
    expect(resolveEnabledModelScope(['other/gamma', 'test/*'], models).map((m) => m.id)).toEqual([
      'gamma',
      'alpha',
      'beta',
    ]);
  });
  it('does not interpret malformed output as an empty directory', () => {
    expect(parsePiModelList('extension failed to load')).toBeUndefined();
    expect(parsePiModelList('provider model thinking\n')).toEqual([]);
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

  it('recognizes the explicit no-models response', () => {
    expect(parsePiModelList('no models available\n')).toEqual([]);
  });
});
