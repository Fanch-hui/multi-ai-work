import { Children, isValidElement, type ReactNode } from 'react';
import { beforeEach, expect, it, vi } from 'vitest';
import type { VoiceStatus } from '../src/domain/voice.js';

const hooks = vi.hoisted(() => ({
  cursor: 0,
  values: [] as unknown[],
  mounted: false,
  effects: [] as (() => void)[],
}));
const api = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('react', async (original) => ({
  ...(await original<typeof import('react')>()),
  useState(initial: unknown) {
    const index = hooks.cursor++;
    if (!(index in hooks.values)) hooks.values[index] = initial;
    return [
      hooks.values[index],
      (value: unknown) => {
        hooks.values[index] = value;
      },
    ];
  },
  useEffect(effect: () => void) {
    if (!hooks.mounted) hooks.effects.push(effect);
  },
}));
vi.mock('../apps/ui/src/api.js', () => ({ request: api.request, errorMessage: String }));
import { VoiceSettings } from '../apps/ui/src/voice/VoiceSettings.js';

const status: VoiceStatus = {
  configuration: {
    baseUrl: 'http://localhost:9000/v1',
    transcriptionModel: 'existing-recognition',
    speechModel: 'existing-speech',
    voice: 'alloy',
    language: 'en',
    dictationLanguage: '',
  },
  recognition: { available: true, locale: 'zh-CN', authorization: 'authorized' },
  hasApiKey: false,
  transcriptionAvailable: true,
  speechAvailable: true,
  mode: 'segmented',
  maxRecordingMs: 45_000,
};
function render() {
  hooks.cursor = 0;
  const result = VoiceSettings();
  hooks.mounted = true;
  for (const effect of hooks.effects.splice(0)) effect();
  return result;
}
function nodes(node: ReactNode): Record<string, unknown>[] {
  return Children.toArray(node).flatMap((child) => {
    if (!isValidElement<{ children?: ReactNode }>(child)) return [];
    return [child.props, ...nodes(child.props.children)];
  });
}
beforeEach(() => {
  hooks.cursor = 0;
  hooks.values = [];
  hooks.mounted = false;
  hooks.effects = [];
  api.request.mockReset().mockResolvedValue(structuredClone(status));
});
it('输入语言与对话识别语言独立保存，并保留已配置的识别模型与朗读服务', async () => {
  render();
  await new Promise((resolve) => setTimeout(resolve, 0));
  const fields = nodes(render());
  const dictation = fields.find((field) => field.label === '输入语言')!;
  const input = nodes(dictation.children as ReactNode)[0];
  (input.onChange as (event: unknown) => void)({ target: { value: 'zh-CN' } });
  const form = render();
  await form.props.onSubmit({ preventDefault: vi.fn() });
  expect(api.request).toHaveBeenLastCalledWith('voice.save', {
    input: { ...status.configuration, dictationLanguage: 'zh-CN', clearApiKey: false },
  });
  const labels = fields.map((field) => field.label).filter(Boolean);
  expect(labels).toContain('识别语言');
  expect(labels).toContain('识别模型');
  expect(labels).toContain('合成模型');
});
