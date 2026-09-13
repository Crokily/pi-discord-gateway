import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { minimatch } from 'minimatch';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { THINKING_LEVELS, type ThinkingLevel } from '../types.js';
import { resolvePiSpawn } from './pi-spawn.js';
import { runProcess } from './subprocess.js';

const CACHE_TTL_MS = 30_000;
const LIST_MODELS_TIMEOUT_MS = 15_000;

export interface AvailableModelInfo {
  ref: string;
  provider: string;
  id: string;
  name: string;
  reasoning: boolean;
  supportsXhigh: boolean;
}
interface ModelCache {
  models?: AvailableModelInfo[];
  loadedAt: number;
  nextRetryAt: number;
  patterns?: string[];
  settingsReady?: Promise<void>;
  error?: string;
}
export interface CatalogSources {
  cli(cwd: string, signal: AbortSignal): Promise<AvailableModelInfo[] | undefined>;
  sdk(
    cwd: string,
    signal: AbortSignal,
    settings: (patterns: string[]) => void,
  ): Promise<AvailableModelInfo[]>;
}

/** Cache reads never start synchronous discovery or wait for a subprocess. */
export class ModelCatalog {
  private cache = new Map<string, ModelCache>();
  private refreshes = new Map<string, Promise<AvailableModelInfo[]>>();
  private probes = new Map<string, Promise<AvailableModelInfo[]>>();
  private controller = new AbortController();
  private active = 0;
  private waiting: Array<() => void> = [];
  constructor(
    private sources: CatalogSources,
    private now = Date.now,
  ) {}
  private state(cwd: string): ModelCache {
    const key = resolve(cwd);
    let state = this.cache.get(key);
    if (!state) {
      state = { loadedAt: 0, nextRetryAt: 0 };
      this.cache.set(key, state);
    }
    return state;
  }
  has(cwd: string): boolean {
    return this.state(cwd).models !== undefined;
  }
  stale(cwd: string): boolean {
    const state = this.state(cwd);
    return !state.models || this.now() - state.loadedAt >= CACHE_TTL_MS;
  }
  status(cwd: string): 'loading' | 'unavailable' | 'ready' | 'stale' {
    const state = this.state(cwd);
    if (state.models !== undefined) return this.stale(cwd) ? 'stale' : 'ready';
    return state.error ? 'unavailable' : 'loading';
  }
  read(cwd: string): AvailableModelInfo[] {
    return this.state(cwd).models ?? [];
  }
  selectable(cwd: string): AvailableModelInfo[] {
    const state = this.state(cwd);
    // Do not expose unscoped choices before project settings have been read.
    if (!state.patterns) return [];
    return state.patterns.length
      ? resolveEnabledModelScope(state.patterns, state.models ?? [])
      : (state.models ?? []);
  }
  async waitForSettings(cwd: string): Promise<void> {
    const state = this.state(cwd);
    if (!state.patterns) await state.settingsReady;
    if (!state.patterns)
      throw new Error('Model selection settings are temporarily unavailable. Try again.');
  }
  schedule(cwd: string): void {
    const state = this.state(cwd);
    if (this.stale(cwd) && this.now() >= state.nextRetryAt) void this.refresh(cwd).catch(() => {});
  }
  refresh(cwd: string): Promise<AvailableModelInfo[]> {
    cwd = resolve(cwd);
    const existing = this.refreshes.get(cwd);
    if (existing) return existing;
    const state = this.state(cwd);
    const work = this.load(cwd, state).finally(() => this.refreshes.delete(cwd));
    this.refreshes.set(cwd, work);
    return work;
  }
  private async load(cwd: string, state: ModelCache): Promise<AvailableModelInfo[]> {
    if (this.active >= 2) await new Promise<void>((resolve) => this.waiting.push(resolve));
    else this.active++;
    let pendingProbe: Promise<AvailableModelInfo[]> | undefined;
    try {
      this.controller.signal.throwIfAborted();
      let sdkModels: AvailableModelInfo[] | undefined;
      let probe = this.probes.get(cwd);
      if (!probe) {
        let ready!: () => void;
        state.settingsReady = new Promise<void>((resolve) => {
          ready = resolve;
        });
        probe = this.sources.sdk(cwd, this.controller.signal, (patterns) => {
          state.patterns = patterns;
          ready();
        });
        this.probes.set(cwd, probe);
        void probe
          .finally(() => {
            ready();
            this.probes.delete(cwd);
          })
          .catch(() => {});
      }
      void probe
        .then((models) => {
          sdkModels = models;
          if (state.models) state.models = mergeModelMetadata(state.models, models);
        })
        .catch(() => {});
      pendingProbe = probe;
      const cli = await this.sources.cli(cwd, this.controller.signal).catch(() => undefined);
      if (cli === undefined && state.models !== undefined)
        throw new Error('CLI discovery failed; preserving the last successful catalog');
      // Await the actual SDK fallback on a cold CLI failure; never cache a stub.
      const models = cli ?? (await probe);
      this.controller.signal.throwIfAborted();
      state.models = mergeModelMetadata(models, sdkModels ?? []).sort((a, b) =>
        a.ref.localeCompare(b.ref),
      );
      state.loadedAt = this.now();
      state.error = undefined;
      return state.models;
    } catch (error) {
      state.error = error instanceof Error ? error.message : String(error);
      throw new Error(
        'Model discovery is temporarily unavailable. Try again after checking pi configuration.',
        { cause: error },
      );
    } finally {
      state.nextRetryAt = this.now() + CACHE_TTL_MS;
      const release = () => {
        const next = this.waiting.shift();
        if (next) next();
        else this.active--;
      };
      // CLI results may return early, but their SDK probe still consumes capacity.
      if (pendingProbe) void pendingProbe.finally(release).catch(() => {});
      else release();
    }
  }
  async stop(): Promise<void> {
    this.controller.abort();
    await Promise.allSettled([...this.refreshes.values(), ...this.probes.values()]);
  }
}

async function discoverCli(
  cwd: string,
  signal: AbortSignal,
): Promise<AvailableModelInfo[] | undefined> {
  const cliArgs = ['--list-models', ...config.piExtraFlags.split(/\s+/).filter(Boolean)];
  const { bin, args } = await resolvePiSpawn(config.piBin, cliArgs);
  const result = await runProcess(bin, args, { cwd, signal, timeoutMs: LIST_MODELS_TIMEOUT_MS });
  return result.code === 0 && !result.error && !result.timedOut && !result.aborted
    ? parsePiModelList(result.stdout)
    : undefined;
}
async function discoverSdk(
  cwd: string,
  signal: AbortSignal,
  settings: (patterns: string[]) => void,
): Promise<AvailableModelInfo[]> {
  const suffix = import.meta.url.endsWith('.ts') ? '.ts' : '.js';
  const decoder = new StringDecoder('utf8');
  let pending = '';
  let models: AvailableModelInfo[] | undefined;
  const result = await runProcess(
    process.execPath,
    [fileURLToPath(new URL(`./model-probe${suffix}`, import.meta.url))],
    {
      cwd,
      signal,
      timeoutMs: LIST_MODELS_TIMEOUT_MS,
      onStdout: (chunk) => {
        pending += decoder.write(chunk);
        let newline: number;
        while ((newline = pending.indexOf('\n')) >= 0) {
          const line = pending.slice(0, newline);
          pending = pending.slice(newline + 1);
          try {
            const event = JSON.parse(line);
            if (event.type === 'settings' && Array.isArray(event.patterns))
              settings(event.patterns);
            if (event.type === 'models' && Array.isArray(event.models)) models = event.models;
          } catch {
            /* Ignore unrelated library output. */
          }
        }
      },
    },
  );
  if (result.code !== 0 || result.timedOut || result.aborted || result.error || !models) {
    throw new Error(result.error || result.stderr.slice(0, 1000) || 'SDK model discovery failed');
  }
  return models;
}

const catalog = new ModelCatalog({ cli: discoverCli, sdk: discoverSdk });
export interface ModelListOptions {
  forceRefresh?: boolean;
  allowStale?: boolean;
  cwd?: string;
}
export function listAvailableModels(options?: ModelListOptions): AvailableModelInfo[] {
  return catalog.read(options?.cwd ?? config.piCwd);
}
export function hasCachedModelCatalog(cwd: string): boolean {
  return catalog.has(cwd);
}
export function isModelCatalogStale(cwd: string): boolean {
  return catalog.stale(cwd);
}
export function getModelCatalogStatus(cwd: string): string {
  return catalog.status(cwd);
}
export function scheduleCatalogRefresh(cwd: string): void {
  catalog.schedule(cwd);
}
export function stopModelCatalog(): Promise<void> {
  return catalog.stop();
}
export async function refreshModelCatalog(cwd = config.piCwd): Promise<AvailableModelInfo[]> {
  try {
    return await catalog.refresh(cwd);
  } catch (err) {
    logger.warn({ cwd, err }, 'Model catalog refresh failed');
    throw err;
  }
}
export async function listSelectableModels(
  options?: ModelListOptions,
): Promise<AvailableModelInfo[]> {
  const cwd = options?.cwd ?? config.piCwd;
  if (options?.forceRefresh || (!options?.allowStale && !catalog.has(cwd)))
    await refreshModelCatalog(cwd);
  if (!options?.allowStale) await catalog.waitForSettings(cwd);
  return catalog.selectable(cwd);
}

export function resolveModelReference(
  ref: string,
  models = listAvailableModels(),
): AvailableModelInfo | undefined {
  const raw = ref.trim();
  if (!raw) return undefined;

  const lower = raw.toLowerCase();
  const normalized = normalize(raw);

  // 1) Exact canonical ref
  let match = models.find((m) => m.ref.toLowerCase() === lower);
  if (match) return match;

  // 2) Exact id / exact name
  match = models.find((m) => m.id.toLowerCase() === lower || m.name.toLowerCase() === lower);
  if (match) return match;

  // 3) Exact normalized match (handles 4.6 vs 4-6)
  match = models.find(
    (m) =>
      normalize(m.ref) === normalized ||
      normalize(m.id) === normalized ||
      normalize(m.name) === normalized,
  );
  if (match) return match;

  // 4) Partial normalized match
  const partialMatches = models.filter(
    (m) =>
      normalize(m.ref).includes(normalized) ||
      normalize(m.id).includes(normalized) ||
      normalize(m.name).includes(normalized),
  );

  if (partialMatches.length === 0) return undefined;

  // Prefer exact startsWith on canonical ref, otherwise the first sorted match.
  partialMatches.sort(
    (a, b) => scoreModelMatch(b, raw) - scoreModelMatch(a, raw) || a.ref.localeCompare(b.ref),
  );
  return partialMatches[0];
}

export async function autocompleteModels(
  query: string,
  limit = 25,
  options?: ModelListOptions,
): Promise<AvailableModelInfo[]> {
  const models = await listSelectableModels(options);
  const trimmed = query.trim();
  if (!trimmed) {
    return models.slice(0, limit);
  }

  const normalized = normalize(trimmed);
  return models
    .filter(
      (m) =>
        normalize(m.ref).includes(normalized) ||
        normalize(m.id).includes(normalized) ||
        normalize(m.name).includes(normalized),
    )
    .sort(
      (a, b) =>
        scoreModelMatch(b, trimmed) - scoreModelMatch(a, trimmed) || a.ref.localeCompare(b.ref),
    )
    .slice(0, limit);
}

export function isThinkingLevel(value: string): value is ThinkingLevel {
  return (THINKING_LEVELS as readonly string[]).includes(value);
}

export interface ThinkingResolution {
  requested: ThinkingLevel;
  effective: ThinkingLevel;
  adjusted: boolean;
  reason?: 'non_reasoning' | 'xhigh_to_high';
}

export function resolveThinkingForModel(
  model: AvailableModelInfo | undefined,
  desired: ThinkingLevel,
): ThinkingResolution {
  if (!model) {
    return { requested: desired, effective: desired, adjusted: false };
  }

  if (!model.reasoning && desired !== 'off') {
    return {
      requested: desired,
      effective: 'off',
      adjusted: true,
      reason: 'non_reasoning',
    };
  }

  if (desired === 'xhigh' && !model.supportsXhigh) {
    return {
      requested: desired,
      effective: 'high',
      adjusted: true,
      reason: 'xhigh_to_high',
    };
  }

  return { requested: desired, effective: desired, adjusted: false };
}

export function toModelChoiceName(model: AvailableModelInfo): string {
  const label = model.name && model.name !== model.id ? `${model.ref} — ${model.name}` : model.ref;
  return label.length > 100 ? `${label.slice(0, 97)}...` : label;
}

export function resolveEnabledModelScope(
  patterns: string[],
  models: AvailableModelInfo[],
): AvailableModelInfo[] {
  const scopedModels: AvailableModelInfo[] = [];

  for (const pattern of patterns) {
    if (hasGlobCharacters(pattern)) {
      const globPattern = stripThinkingLevel(pattern);
      const matches = models.filter((model) =>
        [`${model.provider}/${model.id}`, model.id].some((ref) =>
          minimatch(ref, globPattern, { nocase: true }),
        ),
      );

      for (const model of matches) {
        addUniqueModel(scopedModels, model);
      }
      continue;
    }

    const model = resolveScopePattern(pattern, models);
    if (model) {
      addUniqueModel(scopedModels, model);
    }
  }

  return scopedModels;
}

function resolveScopePattern(
  pattern: string,
  models: AvailableModelInfo[],
): AvailableModelInfo | undefined {
  const exact = findExactScopeMatch(pattern, models);
  if (exact) return exact;

  const partialMatches = models.filter(
    (model) =>
      model.id.toLowerCase().includes(pattern.toLowerCase()) ||
      model.name?.toLowerCase().includes(pattern.toLowerCase()),
  );
  if (partialMatches.length > 0) {
    const aliases = partialMatches.filter((model) => !/-\d{8}$/.test(model.id));
    return (aliases.length > 0 ? aliases : partialMatches).sort((a, b) =>
      b.id.localeCompare(a.id),
    )[0];
  }

  const colonIndex = pattern.lastIndexOf(':');
  if (colonIndex !== -1) {
    return resolveScopePattern(pattern.slice(0, colonIndex), models);
  }

  return undefined;
}

function findExactScopeMatch(
  pattern: string,
  models: AvailableModelInfo[],
): AvailableModelInfo | undefined {
  const normalized = pattern.trim().toLowerCase();
  const canonicalMatches = models.filter(
    (model) => `${model.provider}/${model.id}`.toLowerCase() === normalized,
  );
  if (canonicalMatches.length === 1) return canonicalMatches[0];
  if (canonicalMatches.length > 1) return undefined;

  const idMatches = models.filter((model) => model.id.toLowerCase() === normalized);
  return idMatches.length === 1 ? idMatches[0] : undefined;
}

function stripThinkingLevel(pattern: string): string {
  const colonIndex = pattern.lastIndexOf(':');
  if (colonIndex === -1) return pattern;

  const suffix = pattern.slice(colonIndex + 1);
  return [...THINKING_LEVELS, 'max'].includes(suffix as ThinkingLevel | 'max')
    ? pattern.slice(0, colonIndex)
    : pattern;
}

function hasGlobCharacters(pattern: string): boolean {
  return pattern.includes('*') || pattern.includes('?') || pattern.includes('[');
}

function addUniqueModel(models: AvailableModelInfo[], candidate: AvailableModelInfo): void {
  if (!models.some((model) => model.provider === candidate.provider && model.id === candidate.id)) {
    models.push(candidate);
  }
}

interface ModelTableHeader {
  providerIndex: number;
  modelIndex: number;
  thinkingIndex: number;
  rowsStart: number;
}

// Extensions or hooks loaded by --list-models can write banners to stdout
// before the table, so scan for the header row instead of assuming it is the
// first line.
function findModelTableHeader(lines: string[]): ModelTableHeader | undefined {
  for (const [index, line] of lines.entries()) {
    const headers = line.split(/\s+/);
    const providerIndex = headers.indexOf('provider');
    const modelIndex = headers.indexOf('model');
    const thinkingIndex = headers.indexOf('thinking');
    if (providerIndex !== -1 && modelIndex !== -1 && thinkingIndex !== -1) {
      return { providerIndex, modelIndex, thinkingIndex, rowsStart: index + 1 };
    }
  }
  return undefined;
}

export function parsePiModelList(output: string): AvailableModelInfo[] | undefined {
  const lines = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const header = findModelTableHeader(lines);
  if (!header) {
    return lines.some((line) => /^no (available )?models( available)?[.!]?(?:\s|$)/i.test(line))
      ? []
      : undefined;
  }

  return lines.slice(header.rowsStart).flatMap((line) => {
    const columns = line.split(/\s+/);
    const provider = columns[header.providerIndex];
    const id = columns[header.modelIndex];
    if (!provider || !id || !['yes', 'no'].includes(columns[header.thinkingIndex]?.toLowerCase()))
      return [];

    const reasoning = columns[header.thinkingIndex]?.toLowerCase() === 'yes';
    return [
      {
        ref: `${provider}/${id}`,
        provider,
        id,
        name: id,
        reasoning,
        // The text table exposes only yes/no thinking support. Let pi perform
        // model-specific clamping for CLI-only models unknown to the bundled SDK.
        supportsXhigh: reasoning,
      },
    ];
  });
}

function mergeModelMetadata(
  sourceModels: AvailableModelInfo[],
  sdkModels: AvailableModelInfo[],
): AvailableModelInfo[] {
  const sdkByRef = new Map(sdkModels.map((model) => [model.ref.toLowerCase(), model]));
  return sourceModels.map((model) => {
    const sdkModel = sdkByRef.get(model.ref.toLowerCase());
    return sdkModel
      ? {
          ...model,
          name: sdkModel.name,
          supportsXhigh: sdkModel.supportsXhigh,
        }
      : model;
  });
}

function normalize(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function scoreModelMatch(model: AvailableModelInfo, rawQuery: string): number {
  const query = rawQuery.trim().toLowerCase();
  const normalizedQuery = normalize(rawQuery);
  if (!query) return 0;

  let score = 0;
  if (model.ref.toLowerCase() === query) score += 1000;
  if (model.id.toLowerCase() === query) score += 900;
  if (model.name.toLowerCase() === query) score += 800;
  if (normalize(model.ref) === normalizedQuery) score += 700;
  if (normalize(model.id) === normalizedQuery) score += 650;
  if (normalize(model.name) === normalizedQuery) score += 600;
  if (model.ref.toLowerCase().startsWith(query)) score += 500;
  if (model.id.toLowerCase().startsWith(query)) score += 450;
  if (model.name.toLowerCase().startsWith(query)) score += 400;
  if (normalize(model.ref).includes(normalizedQuery)) score += 100;
  if (normalize(model.id).includes(normalizedQuery)) score += 80;
  if (normalize(model.name).includes(normalizedQuery)) score += 60;
  return score;
}
