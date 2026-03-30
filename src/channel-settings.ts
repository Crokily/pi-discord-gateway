import { config } from './config.js';
import {
  isThinkingLevel,
  listAvailableModels,
  resolveModelReference,
  resolveThinkingForModel,
  type AvailableModelInfo,
} from './model-catalog.js';
import type { RegisteredChannel, ThinkingLevel } from './types.js';

export interface EffectiveChannelSettings {
  rawModelRef: string;
  displayModel: string;
  modelInfo: AvailableModelInfo | undefined;
  modelSource: 'override' | 'default' | 'pi runtime default';
  requestedThinking: ThinkingLevel;
  effectiveThinking: ThinkingLevel;
  hasManagedThinking: boolean;
  thinkingSource: 'override' | 'default' | 'pi runtime default';
  thinkingAdjusted: boolean;
  thinkingAdjustmentMessage?: string;
}

export function getDesiredThinkingLevel(channel: RegisteredChannel): ThinkingLevel {
  if (channel.thinkingOverride) {
    return channel.thinkingOverride;
  }
  if (config.piThinking && isThinkingLevel(config.piThinking)) {
    return config.piThinking;
  }
  return 'off';
}

export function computeEffectiveChannelSettings(
  channel: RegisteredChannel,
  options?: { forceRefresh?: boolean },
): EffectiveChannelSettings {
  const models = listAvailableModels({ forceRefresh: options?.forceRefresh ?? false });

  const rawModelRef = channel.modelOverride || config.piModel || '';
  const modelInfo = rawModelRef ? resolveModelReference(rawModelRef, models) : undefined;
  const hasManagedThinking = Boolean(channel.thinkingOverride) || Boolean(config.piThinking && isThinkingLevel(config.piThinking));
  const desiredThinking = getDesiredThinkingLevel(channel);
  const thinkingResolution = resolveThinkingForModel(modelInfo, desiredThinking);

  let modelSource: EffectiveChannelSettings['modelSource'];
  if (channel.modelOverride) {
    modelSource = 'override';
  } else if (config.piModel) {
    modelSource = 'default';
  } else {
    modelSource = 'pi runtime default';
  }

  let thinkingSource: EffectiveChannelSettings['thinkingSource'];
  if (channel.thinkingOverride) {
    thinkingSource = 'override';
  } else if (config.piThinking && isThinkingLevel(config.piThinking)) {
    thinkingSource = 'default';
  } else {
    thinkingSource = 'pi runtime default';
  }

  return {
    rawModelRef,
    displayModel: modelInfo?.ref || rawModelRef || '(pi runtime default)',
    modelInfo,
    modelSource,
    requestedThinking: thinkingResolution.requested,
    effectiveThinking: thinkingResolution.effective,
    hasManagedThinking,
    thinkingSource,
    thinkingAdjusted: thinkingResolution.adjusted,
    thinkingAdjustmentMessage: thinkingResolution.adjusted
      ? buildThinkingAdjustmentMessage(thinkingResolution.requested, thinkingResolution.effective, modelInfo)
      : undefined,
  };
}

export function buildThinkingAdjustmentMessage(
  requested: ThinkingLevel,
  effective: ThinkingLevel,
  model: AvailableModelInfo | undefined,
): string {
  if (!model) {
    return `Requested ${requested}, but the current model could not be resolved. Effective level is ${effective}.`;
  }
  if (!model.reasoning && requested !== 'off') {
    return `${model.ref} does not support reasoning, so thinking was reduced from ${requested} to off.`;
  }
  if (requested === 'xhigh' && effective === 'high') {
    return `${model.ref} does not support xhigh, so thinking was reduced from xhigh to high.`;
  }
  return `Thinking was adjusted from ${requested} to ${effective}.`;
}
