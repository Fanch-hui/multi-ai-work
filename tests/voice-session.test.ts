import { beforeEach, describe, expect, it, vi } from 'vitest';

const hooks = vi.hoisted(() => ({
  cursor: 0,
  values: [] as unknown[],
  dependencies: new Map<number, unknown[]>(),
  effects: [] as (() => unknown)[],
}));
const api = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('react', () => ({
  useRef(initial: unknown) {
    const index = hooks.cursor++;
    hooks.values[index] ??= { current: initial };
    return hooks.values[index];
  },
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
  useEffect(effect: () => unknown, dependencies: unknown[]) {
    const index = hooks.cursor++;
    const previous = hooks.dependencies.get(index);
    if (!previous || dependencies.some((value, key) => value !== previous[key])) {
      hooks.dependencies.set(index, dependencies);
      hooks.effects.push(effect);
    }
  },
}));
vi.mock('../apps/ui/src/api.js', () => ({
  request: api.request,
  errorMessage: (error: Error) => error.message,
}));
vi.mock('../apps/ui/src/voice/recorder.js', () => ({
  VoiceRecorder: class {
    static supported() {
      return true;
    }
    async start() {
      return { blob: new Blob(['synthetic-audio'], { type: 'audio/webm' }), durationMs: 1000 };
    }
    close() {}
  },
  recordingBase64: async () => 'YWJj',
}));
import { useVoiceSession } from '../apps/ui/src/voice/useVoiceSession.js';

type Props = Parameters<typeof useVoiceSession>[0];
function render(props: Props) {
  hooks.cursor = 0;
  const result = useVoiceSession(props);
  for (const effect of hooks.effects.splice(0)) effect();
  return result;
}
async function flush() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}
beforeEach(() => {
  hooks.cursor = 0;
  hooks.values = [];
  hooks.dependencies.clear();
  hooks.effects = [];
  api.request.mockReset().mockImplementation(async (method: string) => {
    if (method === 'voice.status') return { transcriptionAvailable: true, speechAvailable: true };
    if (method === 'voice.transcribe') return { text: '整理今天的资料' };
    return undefined;
  });
});

describe('语音输入与连续对话', () => {
  it('语音输入只写可编辑草稿，连续对话才发送给成员', async () => {
    const props = { conversationId: 'room', onSubmit: vi.fn(), onDictation: vi.fn() };
    render(props).start(false);
    await flush();
    expect(props.onDictation).toHaveBeenCalledWith('整理今天的资料');
    expect(props.onSubmit).not.toHaveBeenCalled();
    expect(render(props).phase).toBe('idle');
    render(props).start(true);
    await flush();
    expect(props.onSubmit).toHaveBeenCalledOnce();
    expect(render(props).phase).toBe('waiting');
  });
  it('未提供草稿回调时保持提交兼容，任务失败结束等待并展示原因', async () => {
    const props = { conversationId: 'room', onSubmit: vi.fn() };
    render(props).start(false);
    await flush();
    expect(props.onSubmit).toHaveBeenCalledWith('整理今天的资料');
    render(props).start(true);
    await flush();
    render({ ...props, taskError: '模型连接失败，请重试' });
    const stopped = render({ ...props, taskError: '模型连接失败，请重试' });
    expect(stopped.phase).toBe('idle');
    expect(stopped.error).toBe('模型连接失败，请重试');
  });
  it('已结束任务的旧错误不打断新对话，旧错误清除后同原因的新失败正常结束', async () => {
    const props = { conversationId: 'room', onSubmit: vi.fn(), taskError: '模型连接失败' };
    render(props).start(true);
    await flush();
    expect(render(props).phase).toBe('waiting');
    render({ ...props, taskError: undefined });
    render(props);
    expect(render(props).phase).toBe('idle');
  });
});
