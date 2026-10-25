import { Children, isValidElement, type ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const hooks = vi.hoisted(() => ({
  cursor: 0,
  values: [] as unknown[],
  dependencies: new Map<number, unknown[]>(),
  effects: [] as (() => unknown)[],
}));
const voice = vi.hoisted(() => ({
  statusLoaded: true,
  status: {
    recognition: { available: true, reason: '' },
    transcriptionAvailable: true,
    speechAvailable: true,
    transcriptionUnavailableReason: '',
    speechUnavailableReason: '',
  },
  phase: 'idle',
  continuous: false,
  supported: true,
  conversationSupported: true,
  error: '',
  start: vi.fn(),
  reportError: vi.fn(),
  finish: vi.fn(),
  interrupt: vi.fn(),
  end: vi.fn(),
}));
vi.mock('react', async (original) => ({
  ...(await original<typeof import('react')>()),
  useRef(initial: unknown) {
    const index = hooks.cursor++;
    hooks.values[index] ??= { current: initial };
    return hooks.values[index];
  },
  useEffect(effect: () => unknown, dependencies: unknown[]) {
    const index = hooks.cursor++;
    const previous = hooks.dependencies.get(index);
    if (!previous || dependencies.some((value, key) => value !== previous[key])) {
      hooks.dependencies.set(index, dependencies);
      hooks.effects.push(effect);
    }
  },
}));
vi.mock('../apps/ui/src/voice/useVoiceSession.js', () => ({ useVoiceSession: () => voice }));
import { VoiceControls } from '../apps/ui/src/voice/VoiceControls.js';

type Props = Parameters<typeof VoiceControls>[0];
function render(props: Partial<Props> = {}) {
  hooks.cursor = 0;
  const result = VoiceControls({ conversationId: 'main', onSubmit: vi.fn(), ...props });
  for (const effect of hooks.effects.splice(0)) effect();
  return result;
}
function elements(node: ReactNode): { [key: string]: unknown }[] {
  return Children.toArray(node).flatMap((child) => {
    if (!isValidElement<{ children?: ReactNode }>(child)) return [];
    return [child.props, ...elements(child.props.children)];
  });
}
beforeEach(() => {
  hooks.cursor = 0;
  hooks.values = [];
  hooks.dependencies.clear();
  hooks.effects = [];
  vi.clearAllMocks();
  voice.statusLoaded = true;
  voice.phase = 'idle';
  voice.continuous = false;
  voice.supported = true;
  voice.conversationSupported = true;
  voice.status.recognition.available = true;
  voice.status.recognition.reason = '';
  voice.status.speechUnavailableReason = '';
  voice.status.transcriptionAvailable = true;
  voice.status.speechAvailable = true;
  voice.status.transcriptionUnavailableReason = '';
});

describe('语音入口', () => {
  it('听写录音保持侧栏可启动对话，同阶段切换连续模式才上报对话活动', () => {
    const onConversationStateChange = vi.fn();
    const props = { onConversationStateChange };
    voice.phase = 'recording';
    render(props);
    expect(onConversationStateChange).toHaveBeenLastCalledWith(false);
    voice.continuous = true;
    render(props);
    expect(onConversationStateChange).toHaveBeenLastCalledWith(true);
    voice.phase = 'idle';
    render(props);
    expect(onConversationStateChange).toHaveBeenLastCalledWith(false);
  });
  it('输入入口使用带无障碍名称的图标并提示确切缺项', () => {
    voice.status.recognition.available = false;
    voice.status.recognition.reason = '请在系统设置中允许语音识别';
    const nodes = elements(render());
    const input = nodes.find((node) => node['aria-label'] === '语音输入');
    expect(input).toMatchObject({
      disabled: true,
      title: '请在系统设置中允许语音识别',
    });
    expect(typeof input?.children).toBe('object');
    expect(nodes.filter((node) => typeof node.onClick === 'function')).toHaveLength(1);
  });
  it('系统听写独立于语音对话的 Key 和模型设置', () => {
    voice.status.transcriptionAvailable = false;
    voice.status.speechAvailable = false;
    const input = elements(render()).find((node) => node['aria-label'] === '语音输入');
    expect(input?.disabled).toBeFalsy();
    (input?.onClick as () => void)();
    expect(voice.start).toHaveBeenCalledExactlyOnceWith(false);
  });
  it('系统听写不可用时仍可启动已配置的语音对话', () => {
    voice.status.recognition.available = false;
    render({ conversationStartToken: 12 });
    expect(voice.start).toHaveBeenCalledExactlyOnceWith(true);
    expect(voice.reportError).not.toHaveBeenCalled();
  });
  it('外部对话请求等设置加载后开始一次并确认消费', () => {
    const onConversationStartHandled = vi.fn();
    const props = { conversationStartToken: 10, onConversationStartHandled };
    voice.statusLoaded = false;
    render(props);
    expect(voice.start).not.toHaveBeenCalled();
    expect(onConversationStartHandled).not.toHaveBeenCalled();
    voice.statusLoaded = true;
    render(props);
    render(props);
    expect(voice.start).toHaveBeenCalledExactlyOnceWith(true);
    expect(onConversationStartHandled).toHaveBeenCalledExactlyOnceWith(10);
  });
  it('录音和回复期间的操作保持图标并保留用途提示', () => {
    for (const [phase, action] of [
      ['recording', '说完了'],
      ['waiting', '打断并说话'],
      ['speaking', '打断并说话'],
    ]) {
      voice.phase = phase;
      const buttons = elements(render()).filter((node) => typeof node.onClick === 'function');
      expect(buttons.map((button) => button['aria-label'])).toEqual([action, '结束语音']);
      for (const button of buttons) {
        expect(button.title).toBe(button['aria-label']);
        expect(typeof button.children).toBe('object');
      }
    }
  });
  it('缺少识别设置时显示原因并消费外部请求，补齐后保持空闲', () => {
    voice.status.transcriptionAvailable = false;
    voice.status.transcriptionUnavailableReason = '请在语音设置中填写语音识别模型';
    const onConversationStartHandled = vi.fn();
    const props = { conversationStartToken: 11, onConversationStartHandled };
    render(props);
    expect(voice.reportError).toHaveBeenCalledWith('请在语音设置中填写语音识别模型');
    expect(onConversationStartHandled).toHaveBeenCalledExactlyOnceWith(11);
    voice.status.transcriptionAvailable = true;
    render(props);
    expect(voice.start).not.toHaveBeenCalled();
  });
});
