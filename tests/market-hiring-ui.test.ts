import { createElement, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { Snapshot } from '../src/domain/types.js';
import type { AgentPreset, PresetInstallation, PresetMemberConfiguration } from '../src/domain/market.js';
import { defaultToolNames, fullToolNames, permissionPreset } from '../src/domain/tool-permissions.js';
import { BotTools } from '../apps/ui/src/BotTools.js';
import { MemberConfiguration } from '../apps/ui/src/market/MemberConfiguration.js';
import { PresetCard } from '../apps/ui/src/market/PresetCard.js';
import { shareMemberSettings } from '../apps/ui/src/market/memberSettings.js';

const data = { connections: [], toolConnections: [] } as unknown as Snapshot;
const preset: AgentPreset = { id: 'reviewer', version: '1', name: 'UI设计评审员', role: '评审', description: '', professions: [],
  rank: 1, instructions: '', examples: [], outputs: [], skills: [], dependencies: [], platforms: ['darwin'], license: 'MIT', releaseNotes: '' };
const installation: PresetInstallation = { id: 'installed', preset, source: 'official', status: 'installed', progress: 100, skillIds: [], createdAt: '' };
const config: PresetMemberConfiguration = { name: '我的评审员', connectionId: 'connection', model: 'model',
  toolNames: defaultToolNames(false), approvalMode: 'ask', toolConnectionIds: [], personalInstructions: '优先检查中文排版' };

function findElement(node: unknown, type: unknown): ReactElement<Record<string, unknown>> | undefined {
  if (!node || typeof node !== 'object') return;
  const element = node as ReactElement<{ children?: unknown }>;
  if (element.type === type) return element as ReactElement<Record<string, unknown>>;
  for (const child of [element.props?.children].flat()) {
    const match = findElement(child, type);
    if (match) return match;
  }
}

describe('market hiring configuration', () => {
  it('applies a permission scheme and its execution mode atomically without losing personal settings', () => {
    let value = config;
    const tree = MemberConfiguration({ data, value, change: next => { value = next; }, includeName: true });
    const permissions = findElement(tree, BotTools)!;
    const change = permissions.props.onPermissionsChange as (fields: { toolNames: string[]; approvalMode: 'ask' | 'auto' }) => void;
    change({ toolNames: fullToolNames(false), approvalMode: 'auto' });
    expect(permissionPreset(value.toolNames, value.approvalMode, false)).toBe('full');
    expect(value).toMatchObject({ name: config.name, connectionId: config.connectionId, model: config.model, personalInstructions: config.personalInstructions });
    expect(value.toolConnectionIds).toEqual([]);
  });

  it('shares only model and permission settings while retaining each member name and personal requirements', () => {
    const target = { ...config, name: '第二位成员', personalInstructions: '优先检查表格', toolConnectionIds: ['old'] };
    const source = { ...config, model: 'new-model', toolNames: fullToolNames(false), approvalMode: 'auto' as const, toolConnectionIds: ['approved'] };
    const shared = shareMemberSettings(target, source);
    expect(shared).toMatchObject({ name: target.name, personalInstructions: target.personalInstructions,
      model: source.model, approvalMode: 'auto', toolConnectionIds: ['approved'] });
    shared.toolNames.pop(); shared.toolConnectionIds.pop();
    expect(source.toolNames).toEqual(fullToolNames(false));
    expect(source.toolConnectionIds).toEqual(['approved']);
  });

  it('renders a single member configuration with personal requirements immediately available', () => {
    const form = renderToStaticMarkup(createElement(MemberConfiguration, { data, value: config, change: () => {}, includeName: true }));
    expect(form.match(/成员名称/g)).toHaveLength(1);
    expect(form.match(/个人补充要求/g)).toHaveLength(1);
    expect(form).toContain(config.personalInstructions);
    expect(form).not.toContain('单独配置');
  });

  it('offers hiring for both fresh and downloaded presets without a separate configure action', () => {
    const props = { preset, memberCount: 0, selected: false, toggle: () => {}, details: () => {}, hire: () => {}, hiring: false };
    for (const item of [undefined, installation]) {
      const html = renderToStaticMarkup(createElement(PresetCard, { ...props, installation: item }));
      expect(html).toContain('雇佣');
      expect(html).not.toContain('配置成员');
    }
  });
});
