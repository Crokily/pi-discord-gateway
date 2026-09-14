import { config } from '../config.js';
import { getChannel } from '../db.js';
import {
  isThinkingLevel,
  listAvailableModels,
  scheduleCatalogRefresh,
  resolveModelReference,
  resolveThinkingForModel,
  type AvailableModelInfo,
} from './model-catalog.js';
import type { RegisteredChannel, ThinkingLevel } from '../types.js';

export interface EffectiveChannelSettings {
  rawModelRef: string;
  displayModel: string;
  modelInfo: AvailableModelInfo | undefined;
  modelSource: 'override' | 'parent' | 'default' | 'pi runtime default';
  requestedThinking: ThinkingLevel;
  effectiveThinking: ThinkingLevel;
  hasManagedThinking: boolean;
  thinkingSource: 'override' | 'parent' | 'default' | 'pi runtime default';
  thinkingAdjusted: boolean;
  thinkingAdjustmentMessage?: string;
  effectiveCwd: string;
  cwdSource: 'override' | 'parent' | 'default';
}

export function inheritedOverrides(
  channel: RegisteredChannel,
): Pick<RegisteredChannel, 'modelOverride' | 'thinkingOverride' | 'cwdOverride'> {
  const resolved = {
    modelOverride: channel.modelOverride,
    thinkingOverride: channel.thinkingOverride,
    cwdOverride: channel.cwdOverride,
  };
  const visited = new Set([channel.jid]);
  let parentJid = channel.parentJid;
  while (parentJid && !visited.has(parentJid)) {
    visited.add(parentJid);
    const parent = getChannel(parentJid);
    if (!parent || parent.deletedAt) break;
    resolved.modelOverride ||= parent.modelOverride;
    resolved.thinkingOverride ||= parent.thinkingOverride;
    resolved.cwdOverride ||= parent.cwdOverride;
    parentJid = parent.parentJid;
  }
  return resolved;
}
export function getEffectiveCwd(channel: RegisteredChannel): string {
  return inheritedOverrides(channel).cwdOverride || config.piCwd;
}
export function getDesiredThinkingLevel(channel: RegisteredChannel): ThinkingLevel {
  return (
    inheritedOverrides(channel).thinkingOverride ||
    (isThinkingLevel(config.piThinking) ? config.piThinking : 'off')
  );
}
export function computeEffectiveChannelSettings(
  channel: RegisteredChannel,
): EffectiveChannelSettings {
  const inherited = inheritedOverrides(channel);
  const effectiveCwd = inherited.cwdOverride || config.piCwd;
  scheduleCatalogRefresh(effectiveCwd);
  const models = listAvailableModels({ cwd: effectiveCwd });
  const rawModelRef = inherited.modelOverride || config.piModel || '';
  const modelInfo = rawModelRef ? resolveModelReference(rawModelRef, models) : undefined;
  const hasManagedThinking =
    Boolean(inherited.thinkingOverride) || isThinkingLevel(config.piThinking);
  const desiredThinking = getDesiredThinkingLevel(channel);
  const thinking = resolveThinkingForModel(modelInfo, desiredThinking);
  const source = (
    own: string,
    parent: string,
    global: string,
  ): EffectiveChannelSettings['modelSource'] =>
    own ? 'override' : parent ? 'parent' : global ? 'default' : 'pi runtime default';
  return {
    rawModelRef,
    displayModel: modelInfo?.ref || rawModelRef || '(pi runtime default)',
    modelInfo,
    modelSource: source(channel.modelOverride, inherited.modelOverride, config.piModel),
    thinkingSource: source(
      channel.thinkingOverride,
      inherited.thinkingOverride,
      isThinkingLevel(config.piThinking) ? config.piThinking : '',
    ),
    requestedThinking: thinking.requested,
    effectiveThinking: thinking.effective,
    hasManagedThinking,
    thinkingAdjusted: thinking.adjusted,
    thinkingAdjustmentMessage: thinking.adjusted
      ? buildThinkingAdjustmentMessage(thinking.requested, thinking.effective, modelInfo)
      : undefined,
    effectiveCwd,
    cwdSource: channel.cwdOverride ? 'override' : inherited.cwdOverride ? 'parent' : 'default',
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
