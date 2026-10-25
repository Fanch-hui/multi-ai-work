import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { State } from '../src/core/state.js';
import { VoiceService } from '../src/core/voice.js';
import { Vault } from '../src/security/vault.js';
import { configureProviderFetch } from '../src/providers/network.js';
import type { VoiceStatus } from '../src/domain/voice.js';

const resources: { state: State; root: string; service: VoiceService }[] = [];
afterEach(async () => {
  configureProviderFetch((input, init) => fetch(input, init));
  for (const { state, root, service } of resources.splice(0)) {
    service.close();
    state.storage.close();
    await rm(root, { recursive: true, force: true });
  }
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'voice-test-'));
  const state = new State(root);
  const vault = new Vault(join(root, 'vault'));
  const service = new VoiceService(state, vault);
  resources.push({ root, state, service });
  const input = {
    baseUrl: 'http://127.0.0.1:8900/v1',
    transcriptionModel: 'test-transcriber',
    speechModel: 'test-speaker',
    voice: 'test-voice',
    language: 'zh',
  };
  await service.request('voice.save', { input: { ...input, apiKey: 'synthetic-key' } });
  return { root, state, service, vault, input };
}

describe('语音服务', () => {
  it('保存前校验系统听写语言，保留原有语音对话配置', async () => {
    const { service, input } = await fixture();
    await expect(
      service.request('voice.save', { input: { ...input, dictationLanguage: '中文' } }),
    ).rejects.toThrow('语言代码');
    expect(((await service.request('voice.status')) as VoiceStatus).configuration).toEqual(input);
    await service.request('voice.save', { input: { ...input, dictationLanguage: 'zh-CN' } });
    expect(((await service.request('voice.status')) as VoiceStatus).configuration).toEqual({
      ...input,
      dictationLanguage: 'zh-CN',
    });
  });

  it('默认配置逐项提示缺少识别、朗读模型与独立的OpenAI密钥', async () => {
    const { service, state, vault } = await fixture();
    state.storage.setMetadata('voice-configuration', {
      baseUrl: 'https://api.openai.com/v1',
      transcriptionModel: '',
      speechModel: '',
      voice: 'alloy',
      language: 'zh',
    });
    await vault.delete('voice-api-key');
    const status = (await service.request('voice.status')) as VoiceStatus;
    expect(status.transcriptionAvailable).toBe(false);
    expect(status.transcriptionUnavailableReason).toContain('语音识别模型');
    expect(status.transcriptionUnavailableReason).toContain('API Key');
    expect(status.speechUnavailableReason).toContain('语音合成模型');
    const transport = vi.fn();
    configureProviderFetch(transport);
    await expect(
      service.request('voice.transcribe', { requestId: 'missing-config' }),
    ).rejects.toThrow(status.transcriptionUnavailableReason);
    expect(transport).not.toHaveBeenCalled();
  });

  it('本机免密钥识别服务保持可用，朗读配置独立检查', async () => {
    const { service, input } = await fixture();
    await service.request('voice.save', {
      input: { ...input, speechModel: '', voice: '', clearApiKey: true },
    });
    expect(await service.request('voice.status')).toMatchObject({
      hasApiKey: false,
      transcriptionAvailable: true,
      speechAvailable: false,
      speechUnavailableReason: '请在语音设置中填写语音合成模型、音色',
    });
  });

  it('凭据仅在Vault，公开配置保存独立能力，支持保留与清除Key', async () => {
    const { service, state, vault, input } = await fixture();
    expect(JSON.stringify(await service.request('voice.status'))).not.toContain('synthetic-key');
    expect(JSON.stringify(state.storage.metadata('voice-configuration'))).not.toContain(
      'synthetic-key',
    );
    expect(await vault.get('voice-api-key')).toBe('synthetic-key');
    await service.request('voice.save', { input: { ...input, speechModel: '' } });
    expect(await service.request('voice.status')).toMatchObject({
      hasApiKey: true,
      transcriptionAvailable: true,
      speechAvailable: false,
      mode: 'segmented',
    });
    await service.request('voice.save', { input: { ...input, clearApiKey: true } });
    expect(((await service.request('voice.status')) as VoiceStatus).hasApiKey).toBe(false);
  });

  it('识别传递真实multipart音频、模型与语言，合成传递显式音色', async () => {
    const { service } = await fixture();
    const calls: { url: string; init?: RequestInit }[] = [];
    configureProviderFetch(async (url, init) => {
      calls.push({ url: String(url), init });
      if (String(url).endsWith('transcriptions')) return Response.json({ text: '整理今天的资料' });
      return new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'audio/mpeg' } });
    });
    expect(
      await service.request('voice.transcribe', {
        requestId: 'stt',
        audioBase64: Buffer.from('synthetic-audio').toString('base64'),
        mimeType: 'audio/webm',
        durationMs: 1000,
      }),
    ).toEqual({ text: '整理今天的资料' });
    const form = calls[0]!.init!.body as FormData;
    expect(await (form.get('file') as File).text()).toBe('synthetic-audio');
    expect(form.get('language')).toBe('zh');
    expect(form.get('model')).toBe('test-transcriber');
    expect(calls[0]!.init).toMatchObject({ credentials: 'omit', redirect: 'error' });
    expect(calls[0]!.init?.headers).toEqual({ Authorization: 'Bearer synthetic-key' });
    expect(await service.request('voice.speak', { requestId: 'tts', text: '处理完成' })).toEqual({
      audioBase64: 'AQID',
      mimeType: 'audio/mpeg',
    });
    expect(JSON.parse(calls[1]!.init!.body as string)).toEqual({
      model: 'test-speaker',
      voice: 'test-voice',
      input: '处理完成',
      response_format: 'mp3',
    });
  });

  it('拒绝超长录音、非音频回复、不安全地址；错误响应不泄露供应商正文', async () => {
    const { service, input } = await fixture();
    await expect(
      service.request('voice.save', { input: { ...input, baseUrl: 'http://example.com/v1' } }),
    ).rejects.toThrow('HTTPS');
    await expect(
      service.request('voice.save', {
        input: { ...input, baseUrl: 'https://user:pass@example.com/v1' },
      }),
    ).rejects.toThrow('凭据');
    const transport = vi.fn(async () => new Response('provider-secret', { status: 401 }));
    configureProviderFetch(transport);
    await expect(
      service.request('voice.transcribe', {
        requestId: 'long',
        audioBase64: 'YWJj',
        mimeType: 'audio/webm',
        durationMs: 60_000,
      }),
    ).rejects.toThrow();
    expect(transport).not.toHaveBeenCalled();
    await expect(
      service.request('voice.speak', { requestId: 'failure', text: 'hello' }),
    ).rejects.toThrow('HTTP 401');
    configureProviderFetch(
      async () => new Response('html', { headers: { 'content-type': 'text/html' } }),
    );
    await expect(
      service.request('voice.speak', { requestId: 'invalid', text: 'hello' }),
    ).rejects.toThrow('无效音频');
  });

  it('取消和关闭中止真实请求，限制并发且请求标识冲突失败', async () => {
    const { service } = await fixture();
    configureProviderFetch(
      async (_url, init) =>
        new Promise((_resolve, reject) => {
          init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), {
            once: true,
          });
        }),
    );
    const first = service.request('voice.speak', { requestId: 'first', text: 'hello' });
    const firstFailure = expect(first).rejects.toThrow();
    const second = service.request('voice.speak', { requestId: 'second', text: 'hello' });
    const secondFailure = expect(second).rejects.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await expect(
      service.request('voice.speak', { requestId: 'first', text: 'hello' }),
    ).rejects.toThrow('正在执行');
    await expect(
      service.request('voice.speak', { requestId: 'third', text: 'hello' }),
    ).rejects.toThrow('繁忙');
    await service.request('voice.cancel', { requestId: 'first' });
    await firstFailure;
    service.close();
    await secondFailure;
    await expect(
      service.request('voice.speak', { requestId: 'fourth', text: 'hello' }),
    ).rejects.toThrow('已结束');
  });
});
