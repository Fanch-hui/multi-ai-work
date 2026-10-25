import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { VoiceStatus } from '../src/domain/voice.js';

const hooks = vi.hoisted(() => ({
  cursor: 0,
  values: [] as unknown[],
  dependencies: new Map<number, unknown[]>(),
  effects: [] as (() => unknown)[],
  cleanups: new Map<number, () => void>(),
}));
const api = vi.hoisted(() => ({ request: vi.fn() }));
const recorder = vi.hoisted(() => ({
  deferred: false,
  complete: [] as ((result: unknown) => void)[],
  close: vi.fn(),
  stop: vi.fn(),
  start: vi.fn(),
}));
const native = vi.hoisted(() => ({
  deferred: false,
  error: '',
  cancelDeferred: false,
  cancelComplete: [] as (() => void)[],
  complete: [] as ((result: { text: string }) => void)[],
}));
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
      hooks.effects.push(() => {
        hooks.cleanups.get(index)?.();
        const cleanup = effect();
        if (typeof cleanup === 'function') hooks.cleanups.set(index, cleanup as () => void);
      });
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
    async start(autoSegment: boolean) {
      recorder.start(autoSegment);
      if (recorder.deferred) return new Promise((resolve) => recorder.complete.push(resolve));
      return { blob: new Blob(['recording'], { type: 'audio/webm' }), durationMs: 500 };
    }
    stop = recorder.stop;
    close = recorder.close;
  },
  recordingBase64: async () => 'cmVjb3JkaW5n',
}));
import { useVoiceSession } from '../apps/ui/src/voice/useVoiceSession.js';

type Props = Parameters<typeof useVoiceSession>[0];
const status: VoiceStatus = {
  configuration: {
    baseUrl: 'https://api.openai.com/v1',
    transcriptionModel: '',
    speechModel: '',
    voice: 'alloy',
    language: 'en',
    dictationLanguage: 'zh-CN',
  },
  recognition: { available: true, locale: 'zh-CN', authorization: 'not_determined' },
  hasApiKey: false,
  transcriptionAvailable: true,
  speechAvailable: false,
  mode: 'segmented',
  maxRecordingMs: 45_000,
};
function render(props: Props) {
  hooks.cursor = 0;
  const result = useVoiceSession(props);
  for (const effect of hooks.effects.splice(0)) effect();
  return result;
}
async function flush() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}
async function mount(props: Props) {
  render(props);
  await flush();
  return render(props);
}
beforeEach(() => {
  hooks.cursor = 0;
  hooks.values = [];
  hooks.dependencies.clear();
  hooks.effects = [];
  hooks.cleanups.clear();
  recorder.deferred = false;
  recorder.complete = [];
  recorder.start.mockClear();
  recorder.stop.mockClear();
  recorder.close.mockClear();
  native.deferred = false;
  native.error = '';
  native.cancelDeferred = false;
  native.cancelComplete = [];
  native.complete = [];
  api.request.mockReset().mockImplementation(async (method: string) => {
    if (method === 'voice.status') return structuredClone(status);
    if (method === 'voice.transcribe') return { text: '连续对话要求' };
    if (method === 'voice.recognition.cancel' && native.cancelDeferred)
      return new Promise<void>((resolve) => native.cancelComplete.push(resolve));
    if (method === 'voice.recognition.start') {
      if (native.error) throw new Error(native.error);
      if (native.deferred) return new Promise((resolve) => native.complete.push(resolve));
      return { text: '整理今天的资料' };
    }
    return { ok: true };
  });
});

describe('系统语音输入与连续对话', () => {
  it('没有 API Key 或语音模型时仍能系统识别，只将文字写入草稿', async () => {
    api.request.mockImplementationOnce(async () => ({
      ...structuredClone(status),
      transcriptionAvailable: false,
      speechAvailable: false,
    }));
    const props = { conversationId: 'room', onSubmit: vi.fn(), onDictation: vi.fn() };
    const session = await mount(props);
    expect(session.supported).toBe(true);
    session.start(false);
    await flush();
    expect(props.onDictation).toHaveBeenCalledExactlyOnceWith('整理今天的资料');
    expect(props.onSubmit).not.toHaveBeenCalled();
    expect(render(props).phase).toBe('idle');
    expect(api.request.mock.calls.map(([method]) => method)).toEqual([
      'voice.status',
      'voice.recognition.start',
    ]);
    expect(api.request.mock.calls[1][1]).toEqual({
      requestId: expect.any(String),
      language: 'zh-CN',
    });
  });

  it('听写中切换连续对话取消原请求，同阶段更新模式，旧文字不混入新对话', async () => {
    native.deferred = true;
    const props = { conversationId: 'room', onSubmit: vi.fn(), onDictation: vi.fn() };
    (await mount(props)).start(false);
    expect(render(props)).toMatchObject({ phase: 'recording', continuous: false });
    recorder.deferred = true;
    render(props).start(true);
    expect(render(props)).toMatchObject({ phase: 'recording', continuous: true });
    expect(recorder.start).not.toHaveBeenCalled();
    const calls = api.request.mock.calls;
    const first = calls.find(([method]) => method === 'voice.recognition.start')![1];
    expect(calls.find(([method]) => method === 'voice.recognition.cancel')?.[1]).toEqual({
      requestId: first.requestId,
    });
    native.complete[0]!({ text: '旧听写文字' });
    await flush();
    recorder.complete[0]!({
      blob: new Blob(['recording'], { type: 'audio/webm' }),
      durationMs: 500,
    });
    await flush();
    expect(props.onSubmit).toHaveBeenCalledExactlyOnceWith('连续对话要求');
    expect(recorder.start).toHaveBeenCalledWith(true);
    expect(api.request).toHaveBeenCalledWith('voice.transcribe', {
      requestId: expect.any(String),
      audioBase64: 'cmVjb3JkaW5n',
      mimeType: 'audio/webm',
      durationMs: 500,
    });
    expect(calls.filter(([method]) => method === 'voice.recognition.start')).toHaveLength(1);
    expect(props.onDictation).not.toHaveBeenCalled();
    expect(render(props)).toMatchObject({ phase: 'waiting', continuous: true });
    render(props).end();
    expect(render(props)).toMatchObject({ phase: 'idle', continuous: false });
  });

  it('系统取消尚未完成时连续两次开启对话，共用释放等待且只启动最后一次录音', async () => {
    native.deferred = true;
    native.cancelDeferred = true;
    recorder.deferred = true;
    const props = { conversationId: 'room', onSubmit: vi.fn(), onDictation: vi.fn() };
    (await mount(props)).start(false);
    render(props).start(true);
    render(props).start(true);
    await flush();
    expect(recorder.start).not.toHaveBeenCalled();
    expect(
      api.request.mock.calls.filter(([method]) => method === 'voice.recognition.cancel'),
    ).toHaveLength(1);
    native.complete[0]!({ text: '先前的听写文字' });
    native.cancelComplete[0]!();
    await flush();
    expect(recorder.start).toHaveBeenCalledExactlyOnceWith(true);
    expect(props.onSubmit).not.toHaveBeenCalled();
    expect(props.onDictation).not.toHaveBeenCalled();
    recorder.complete[0]!({
      blob: new Blob(['recording'], { type: 'audio/webm' }),
      durationMs: 500,
    });
    await flush();
    expect(props.onSubmit).toHaveBeenCalledExactlyOnceWith('连续对话要求');
    expect(render(props)).toMatchObject({ phase: 'waiting', continuous: true });
    render(props).end();
  });

  it('点击说完了结束当前原生请求，识别完成才交付草稿', async () => {
    native.deferred = true;
    const props = { conversationId: 'room', onSubmit: vi.fn(), onDictation: vi.fn() };
    (await mount(props)).start(false);
    render(props).finish();
    expect(render(props).phase).toBe('transcribing');
    expect(props.onDictation).not.toHaveBeenCalled();
    const requestId = api.request.mock.calls.find(
      ([method]) => method === 'voice.recognition.start',
    )![1].requestId;
    expect(api.request).toHaveBeenCalledWith('voice.recognition.stop', { requestId });
    native.complete[0]!({ text: '完整识别文字' });
    await flush();
    expect(props.onDictation).toHaveBeenCalledExactlyOnceWith('完整识别文字');
    expect(render(props).phase).toBe('idle');
  });

  it('切换会话时取消旧请求，晚返回的识别结果不写入新草稿', async () => {
    native.deferred = true;
    const props = { conversationId: 'room', onSubmit: vi.fn(), onDictation: vi.fn() };
    (await mount(props)).start(false);
    render({ ...props, conversationId: 'other' });
    native.complete[0]!({ text: '旧会话的文字' });
    await flush();
    expect(props.onDictation).not.toHaveBeenCalled();
    expect(props.onSubmit).not.toHaveBeenCalled();
    expect(
      api.request.mock.calls.filter(([method]) => method === 'voice.recognition.cancel'),
    ).toHaveLength(1);
  });

  it('系统拒绝识别权限时结束等待并显示原始原因', async () => {
    native.error = '系统语音识别权限未开启';
    const props = { conversationId: 'room', onSubmit: vi.fn(), onDictation: vi.fn() };
    (await mount(props)).start(false);
    await flush();
    expect(render(props)).toMatchObject({ phase: 'idle', error: '系统语音识别权限未开启' });
    expect(props.onDictation).not.toHaveBeenCalled();
    expect(props.onSubmit).not.toHaveBeenCalled();
  });

  it('缺少桌面系统接口时不启动外部语音服务', async () => {
    api.request.mockResolvedValue({ ...status, recognition: undefined });
    const props = { conversationId: 'room', onSubmit: vi.fn() };
    const session = await mount(props);
    expect(session.supported).toBe(false);
    session.start(false);
    expect(render(props).error).toContain('系统听写快捷键');
    expect(api.request).toHaveBeenCalledExactlyOnceWith('voice.status');
  });

  it('听写结果始终由草稿入口接收，连续对话失败结束等待并展示原因', async () => {
    const props = { conversationId: 'room', onSubmit: vi.fn() };
    (await mount(props)).start(false);
    await flush();
    expect(props.onSubmit).not.toHaveBeenCalled();
    render(props).start(true);
    await flush();
    render({ ...props, taskError: '模型连接失败，请重试' });
    expect(render({ ...props, taskError: '模型连接失败，请重试' })).toMatchObject({
      phase: 'idle',
      error: '模型连接失败，请重试',
    });
  });

  it('旧任务错误不打断新对话，清除后同原因的新失败正常结束', async () => {
    const props = { conversationId: 'room', onSubmit: vi.fn(), taskError: '模型连接失败' };
    (await mount(props)).start(true);
    await flush();
    expect(render(props).phase).toBe('waiting');
    render({ ...props, taskError: undefined });
    render(props);
    expect(render(props).phase).toBe('idle');
  });
});
