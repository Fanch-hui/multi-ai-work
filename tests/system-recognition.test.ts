import { beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('../apps/ui/src/api.js', () => ({ request: api.request }));
import { SystemSpeechRecognition } from '../apps/ui/src/voice/system-recognition.js';

beforeEach(() => {
  api.request.mockReset();
});

describe('系统语音识别请求', () => {
  it('直接获取系统文字，启动不传音频或模型配置', async () => {
    api.request.mockResolvedValue({ text: '整理工作记录' });
    const recognition = new SystemSpeechRecognition();
    expect(await recognition.start('zh')).toEqual({ text: '整理工作记录' });
    expect(api.request).toHaveBeenCalledExactlyOnceWith('voice.recognition.start', {
      requestId: expect.any(String),
      language: 'zh',
    });
    await recognition.close();
    expect(api.request).toHaveBeenCalledOnce();
    await expect(recognition.start()).rejects.toThrow('已开始或结束');
  });

  it('手动结束使用原请求 ID，取消后的晚结果不再交付', async () => {
    let resolve!: (result: { text: string }) => void;
    api.request.mockImplementation((method: string) => {
      if (method === 'voice.recognition.start')
        return new Promise((done) => {
          resolve = done;
        });
      return Promise.resolve({ ok: true });
    });
    const recognition = new SystemSpeechRecognition();
    const pending = recognition.start('zh-CN');
    const params = api.request.mock.calls[0][1];
    await recognition.stop();
    await recognition.close();
    await recognition.close();
    resolve({ text: '取消后才到达的文字' });
    expect(await pending).toBeUndefined();
    expect(api.request.mock.calls.map(([method]) => method)).toEqual([
      'voice.recognition.start',
      'voice.recognition.stop',
      'voice.recognition.cancel',
    ]);
    expect(api.request.mock.calls.slice(1).map(([, input]) => input)).toEqual([
      { requestId: params.requestId },
      { requestId: params.requestId },
    ]);
  });

  it('识别错误保留系统原因，未启动时关闭不会触发识别', async () => {
    api.request.mockRejectedValue(new Error('系统语音识别权限未开启'));
    await expect(new SystemSpeechRecognition().start()).rejects.toThrow('权限未开启');
    const recognition = new SystemSpeechRecognition();
    await recognition.close();
    await expect(recognition.start()).rejects.toThrow('已开始或结束');
    expect(api.request).toHaveBeenCalledOnce();
  });
});
