import { AuthStorage, ModelRegistry } from '@mariozechner/pi-coding-agent';
import type { Model } from '@mariozechner/pi-ai';
import { THINKING_LEVELS, type ThinkingLevel } from '../types.js';
import { supportsModelXhigh } from './pi-ai-compat.js';

const CACHE_TTL_MS = 30_000;

export interface AvailableModelInfo {
  ref: string;
  provider: string;
  id: string;
  name: string;
  reasoning: boolean;
  supportsXhigh: boolean;
}

interface ModelCache {
  loadedAt: number;
  models: AvailableModelInfo[];
}

let cache: ModelCache | undefined;

export function listAvailableModels(options?: { forceRefresh?: boolean }): AvailableModelInfo[] {
  const forceRefresh = options?.forceRefresh ?? false;
  const now = Date.now();

  if (!forceRefresh && cache && now - cache.loadedAt < CACHE_TTL_MS) {
    return cache.models;
  }

  const authStorage = AuthStorage.create();
  authStorage.reload();

  const registry = createModelRegistry(authStorage);
  registry.refresh();

  const models = registry.getAvailable()
    .map(toAvailableModelInfo)
    .sort((a, b) => a.ref.localeCompare(b.ref));

  cache = { loadedAt: now, models };
  return models;
}

export function resolveModelReference(ref: string, models = listAvailableModels()): AvailableModelInfo | undefined {
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
    (m) => normalize(m.ref) === normalized || normalize(m.id) === normalized || normalize(m.name) === normalized,
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
  partialMatches.sort((a, b) => scoreModelMatch(b, raw) - scoreModelMatch(a, raw) || a.ref.localeCompare(b.ref));
  return partialMatches[0];
}

export function autocompleteModels(query: string, limit = 25): AvailableModelInfo[] {
  const models = listAvailableModels();
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
    .sort((a, b) => scoreModelMatch(b, trimmed) - scoreModelMatch(a, trimmed) || a.ref.localeCompare(b.ref))
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

export function resolveThinkingForModel(model: AvailableModelInfo | undefined, desired: ThinkingLevel): ThinkingResolution {
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

function createModelRegistry(authStorage: AuthStorage): ModelRegistry {
  const registryClass = ModelRegistry as unknown as {
    create?: (authStorage: AuthStorage) => ModelRegistry;
    new (authStorage: AuthStorage): ModelRegistry;
  };

  if (typeof registryClass.create === 'function') {
    return registryClass.create(authStorage);
  }

  return new registryClass(authStorage);
}

function toAvailableModelInfo(model: Model<any>): AvailableModelInfo {
  return {
    ref: `${model.provider}/${model.id}`,
    provider: model.provider,
    id: model.id,
    name: model.name || model.id,
    reasoning: Boolean(model.reasoning),
    supportsXhigh: supportsModelXhigh(model),
  };
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
