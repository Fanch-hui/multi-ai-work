import type { PresetMemberConfiguration } from '../../../../src/domain/market.js';

export function shareMemberSettings(target: PresetMemberConfiguration, source: PresetMemberConfiguration): PresetMemberConfiguration {
  return { ...target, connectionId: source.connectionId, model: source.model, reasoning: source.reasoning,
    toolNames: [...source.toolNames], approvalMode: source.approvalMode, toolConnectionIds: [...source.toolConnectionIds],
    qoderServices: source.qoderServices && [...source.qoderServices] };
}
