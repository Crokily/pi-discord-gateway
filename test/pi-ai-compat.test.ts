import type { Model } from '@mariozechner/pi-ai';
import { describe, expect, it, vi } from 'vitest';
import { supportsModelXhigh } from '../src/agent/pi-ai-compat.js';

const model = { id: 'test-model', provider: 'test-provider', reasoning: true } as Model<any>;

describe('supportsModelXhigh', () => {
  it('prefers getSupportedThinkingLevels from newer pi-ai versions', () => {
    const getSupportedThinkingLevels = vi.fn(() => ['low', 'xhigh'] as const);
    const legacySupportsXhigh = vi.fn(() => false);

    expect(supportsModelXhigh(model, { getSupportedThinkingLevels, supportsXhigh: legacySupportsXhigh })).toBe(true);
    expect(getSupportedThinkingLevels).toHaveBeenCalledWith(model);
    expect(legacySupportsXhigh).not.toHaveBeenCalled();
  });

  it('falls back to legacy supportsXhigh when getSupportedThinkingLevels is unavailable', () => {
    const legacySupportsXhigh = vi.fn(() => true);

    expect(supportsModelXhigh(model, { supportsXhigh: legacySupportsXhigh })).toBe(true);
    expect(legacySupportsXhigh).toHaveBeenCalledWith(model);
  });

  it('treats xhigh as unsupported when neither pi-ai helper is available', () => {
    expect(supportsModelXhigh(model, {})).toBe(false);
  });
});
