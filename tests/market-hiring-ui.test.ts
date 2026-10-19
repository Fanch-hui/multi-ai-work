import { createElement, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { Snapshot } from '../src/domain/types.js';
import type {
  AgentPreset,
  PresetInstallation,
  PresetMemberConfiguration,
} from '../src/domain/market.js';
import {
  defaultToolNames,
  fullToolNames,
  permissionPreset,
} from '../src/domain/tool-permissions.js';
import { BotTools } from '../apps/ui/src/BotTools.js';
import { ReasoningField } from '../apps/ui/src/ReasoningField.js';
import { MemberConfiguration } from '../apps/ui/src/market/MemberConfiguration.js';
import { PresetCard } from '../apps/ui/src/market/PresetCard.js';
import { shareMemberSettings } from '../apps/ui/src/market/memberSettings.js';
import {
  initialMemberSettings,
  memberRequestConfiguration,
  type PresetMemberDraft,
} from '../apps/ui/src/market/memberSettings.js';
import type { Mutate } from '../apps/ui/src/store.js';

const data = { connections: [], toolConnections: [], skills: [] } as unknown as Snapshot;
const mutate: Mutate = async () => undefined as never;
const preset: AgentPreset = {
  id: 'reviewer',
  version: '1',
  name: 'UI设计评审员',
  role: '评审',
  description: '',
  professions: [],
  rank: 1,
  instructions: '',
  examples: [],
  outputs: [],
  skills: [],
  dependencies: [],
  platforms: ['darwin'],
  license: 'MIT',
  releaseNotes: '',
};
const installation: PresetInstallation = {
  id: 'installed',
  preset,
  source: 'official',
  status: 'installed',
  progress: 100,
  skillIds: [],
  createdAt: '',
};
const config: PresetMemberConfiguration = {
  name: '我的评审员',
  connectionId: 'connection',
  model: 'model',
  toolNames: defaultToolNames(false),
  approvalMode: 'ask',
  toolConnectionIds: [],
  personalInstructions: '优先检查中文排版',
};

function findElement(
  node: unknown,
  type: unknown,
): ReactElement<Record<string, unknown>> | undefined {
  if (!node || typeof node !== 'object') return;
  const element = node as ReactElement<{ children?: unknown }>;
  if (element.type === type) return element as ReactElement<Record<string, unknown>>;
  for (const child of [element.props?.children].flat()) {
    const match = findElement(child, type);
    if (match) return match;
  }
}

describe('market hiring configuration', () => {
  it('saves a custom service reasoning value through the member form without assigning a default', () => {
    let value: PresetMemberDraft = config;
    const customData = {
      ...data,
      connections: [
        { id: 'connection', name: 'custom', status: 'ready', provider: 'custom', models: [] },
      ],
    } as unknown as Snapshot;
    const tree = MemberConfiguration({
      data: customData,
      value,
      change: (fields) => {
        value = { ...value, ...fields };
      },
      mutate,
    });
    const field = findElement(tree, ReasoningField)!;
    expect(field.props.value).toBe('');
    expect(value.reasoning).toBeUndefined();
    const change = field.props.onChange as (effort: string) => void;
    change('vendor-intensive');
    expect(memberRequestConfiguration(value).reasoning).toBe('vendor-intensive');
    change('');
    expect(memberRequestConfiguration(value).reasoning).toBeUndefined();
  });

  it('applies a permission scheme and its execution mode atomically without losing personal settings', () => {
    let value: PresetMemberDraft = config;
    const tree = MemberConfiguration({
      data,
      value,
      change: (fields) => {
        value = { ...value, ...fields };
      },
      includeName: true,
      mutate,
    });
    const permissions = findElement(tree, BotTools)!;
    const change = permissions.props.onPermissionsChange as (fields: {
      toolNames: string[];
      approvalMode: 'ask' | 'auto';
    }) => void;
    change({ toolNames: fullToolNames(false), approvalMode: 'auto' });
    expect(permissionPreset(value.toolNames, value.approvalMode, false)).toBe('full');
    expect(value).toMatchObject({
      name: config.name,
      connectionId: config.connectionId,
      model: config.model,
      personalInstructions: config.personalInstructions,
    });
    expect(value.toolConnectionIds).toEqual([]);
  });

  it('shares only model and permission settings while retaining each member name and personal requirements', () => {
    const target = {
      ...config,
      name: '第二位成员',
      role: '表格评审',
      avatar: 'owl',
      color: '#047857',
      contextWindow: '64000',
      compactionThreshold: '70',
      memoryMode: 'off' as const,
      skillIds: ['own-skill'],
      personalInstructions: '优先检查表格',
      toolConnectionIds: ['old'],
    };
    const source = {
      ...config,
      model: 'new-model',
      toolNames: fullToolNames(false),
      approvalMode: 'auto' as const,
      toolConnectionIds: ['approved'],
    };
    const shared = shareMemberSettings(target, source);
    expect(shared).toMatchObject({
      name: target.name,
      role: target.role,
      avatar: target.avatar,
      color: target.color,
      contextWindow: '64000',
      compactionThreshold: '70',
      memoryMode: 'off',
      skillIds: ['own-skill'],
      personalInstructions: target.personalInstructions,
      model: source.model,
      approvalMode: 'auto',
      toolConnectionIds: ['approved'],
    });
    shared.toolNames.pop();
    shared.toolConnectionIds.pop();
    expect(source.toolNames).toEqual(fullToolNames(false));
    expect(source.toolConnectionIds).toEqual(['approved']);
  });

  it('renders a single member configuration with personal requirements immediately available', () => {
    const form = renderToStaticMarkup(
      createElement(MemberConfiguration, {
        data,
        value: config,
        change: () => {},
        includeName: true,
        mutate,
        preset,
      }),
    );
    expect(form.match(/成员名称/g)).toHaveLength(1);
    expect(form.match(/个人补充要求/g)).toHaveLength(1);
    expect(form).toContain(config.personalInstructions);
    for (const label of [
      '头像',
      '职责',
      '预设工作指令',
      '上下文窗口',
      '压缩阈值',
      '记忆',
      '成员颜色',
      'Skills',
    ])
      expect(form).toContain(label);
    expect(form).not.toContain('单独配置');
  });

  it('starts with full autonomous permissions and serializes context inputs as numbers', () => {
    const value = initialMemberSettings(preset);
    expect(permissionPreset(value.toolNames, value.approvalMode, false)).toBe('full');
    expect(value).toMatchObject({
      memoryMode: 'propose',
      compactionThreshold: 85,
      role: preset.role,
    });
    expect(
      memberRequestConfiguration({ ...value, contextWindow: '64000', compactionThreshold: '75' }),
    ).toMatchObject({ contextWindow: 64000, compactionThreshold: 75 });
  });

  it('keeps memory configurable while native runtimes manage context', () => {
    const nativeData = {
      ...data,
      connections: [
        { id: 'connection', name: 'native', status: 'ready', provider: 'qoder', models: [] },
      ],
    } as unknown as Snapshot;
    const form = renderToStaticMarkup(
      createElement(MemberConfiguration, {
        data: nativeData,
        value: config,
        change: () => {},
        includeName: true,
        mutate,
      }),
    );
    expect(form).toContain('记忆');
    expect(form).not.toContain('压缩阈值');
    expect(form).not.toContain('上下文窗口（tokens）');
  });

  it('offers hiring for both fresh and downloaded presets without a separate configure action', () => {
    const props = {
      preset,
      memberCount: 0,
      selected: false,
      toggle: () => {},
      details: () => {},
      hire: () => {},
      hiring: false,
    };
    for (const item of [undefined, installation]) {
      const html = renderToStaticMarkup(
        createElement(PresetCard, { ...props, installation: item }),
      );
      expect(html).toContain('雇佣');
      expect(html).not.toContain('配置成员');
    }
  });
});
