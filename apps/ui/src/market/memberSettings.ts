import type { AgentPreset, PresetMemberConfiguration } from '../../../../src/domain/market.js';
import { fullToolNames } from '../../../../src/domain/tool-permissions.js';
import { DEFAULT_COMPACTION_THRESHOLD } from '../../../../src/domain/context-settings.js';

export type PresetMemberDraft = Omit<
  PresetMemberConfiguration,
  'contextWindow' | 'compactionThreshold'
> & {
  contextWindow?: string | number;
  compactionThreshold?: string | number;
};

export function initialMemberSettings(preset: AgentPreset): PresetMemberDraft {
  return {
    name: preset.name,
    role: preset.role,
    avatar: 'cat',
    color: '#2563eb',
    connectionId: '',
    model: '',
    compactionThreshold: DEFAULT_COMPACTION_THRESHOLD,
    memoryMode: 'propose',
    toolNames: fullToolNames(false),
    approvalMode: 'auto',
    toolConnectionIds: [],
    skillIds: [],
    personalInstructions: '',
  };
}

export function memberRequestConfiguration(value: PresetMemberDraft): PresetMemberConfiguration {
  return {
    ...value,
    contextWindow: value.contextWindow ? Number(value.contextWindow) : undefined,
    compactionThreshold:
      value.compactionThreshold === undefined ? undefined : Number(value.compactionThreshold),
  };
}

export function shareMemberSettings(
  target: PresetMemberDraft,
  source: PresetMemberDraft,
): PresetMemberDraft {
  return {
    ...target,
    connectionId: source.connectionId,
    model: source.model,
    reasoning: source.reasoning,
    toolNames: [...source.toolNames],
    approvalMode: source.approvalMode,
    toolConnectionIds: [...source.toolConnectionIds],
    qoderServices: source.qoderServices && [...source.qoderServices],
  };
}
