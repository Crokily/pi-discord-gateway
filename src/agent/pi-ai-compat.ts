import * as PiAI from '@earendil-works/pi-ai';
import type { Model } from '@earendil-works/pi-ai';

type PiAiThinkingExports = {
  getSupportedThinkingLevels?: (model: Model<any>) => readonly string[];
  supportsXhigh?: (model: Model<any>) => boolean;
};

const piAiThinking = PiAI as unknown as PiAiThinkingExports;

export function supportsModelXhigh(
  model: Model<any>,
  piAi: PiAiThinkingExports = piAiThinking,
): boolean {
  if (typeof piAi.getSupportedThinkingLevels === 'function') {
    return piAi.getSupportedThinkingLevels(model).includes('xhigh');
  }

  if (typeof piAi.supportsXhigh === 'function') {
    return piAi.supportsXhigh(model);
  }

  return false;
}
