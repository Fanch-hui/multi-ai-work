import { z } from 'zod';
import type { VoiceConfiguration, VoiceStatus } from '../domain/voice.js';
import { maxVoiceRecordingMs, voiceConfigurationIssues } from '../domain/voice.js';
import { systemSpeechLanguageSchema } from '../domain/system-speech.js';
import type { Vault } from '../security/vault.js';
import type { State } from './state.js';
import { voiceBaseUrl, voiceHttp } from './voice-http.js';

const configurationSchema = z.object({
  dictationLanguage: systemSpeechLanguageSchema,
  baseUrl: z.string().trim().max(2048).transform(voiceBaseUrl),
  transcriptionModel: z.string().trim().max(120),
  speechModel: z.string().trim().max(120),
  voice: z.string().trim().max(120),
  language: z.string().trim().max(20),
});
const defaultConfiguration: VoiceConfiguration = {
  baseUrl: 'https://api.openai.com/v1',
  transcriptionModel: '',
  speechModel: '',
  voice: 'alloy',
  language: 'zh',
};
const keyReference = 'voice-api-key';

export class VoiceService {
  private active = new Map<string, AbortController>();
  private closed = false;
  constructor(
    private state: State,
    private vault: Vault,
  ) {}

  async request(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    if (method === 'voice.status') return this.status();
    if (method === 'voice.save') return this.save(params);
    if (method === 'voice.cancel') {
      const { requestId } = z.object({ requestId: z.string().max(100) }).parse(params);
      this.active.get(requestId)?.abort();
      return { cancelled: true };
    }
    if (!['voice.transcribe', 'voice.speak'].includes(method))
      throw new Error(`未知语音操作：${method}`);
    const { requestId } = z.object({ requestId: z.string().min(1).max(100) }).parse(params);
    if (this.closed) throw new Error('语音服务已结束');
    if (this.active.has(requestId)) throw new Error('此语音请求正在执行');
    if (this.active.size >= 2) throw new Error('语音请求繁忙，请稍后再试');
    const controller = new AbortController();
    this.active.set(requestId, controller);
    try {
      const configuration = this.configuration();
      const key = await this.vault.get(keyReference);
      controller.signal.throwIfAborted();
      const issues = voiceConfigurationIssues(configuration, !!key);
      const issue = method === 'voice.transcribe' ? issues.transcription : issues.speech;
      if (issue) throw new Error(issue);
      const headers: Record<string, string> = key ? { Authorization: `Bearer ${key}` } : {};
      if (method === 'voice.transcribe')
        return await this.transcribe(configuration, headers, params, controller.signal);
      return await this.speak(configuration, headers, params, controller.signal);
    } finally {
      this.active.delete(requestId);
    }
  }

  close() {
    this.closed = true;
    for (const controller of this.active.values()) controller.abort();
  }

  private configuration(): VoiceConfiguration {
    return (
      this.state.storage.metadata<VoiceConfiguration>('voice-configuration') ?? defaultConfiguration
    );
  }
  private async status(): Promise<VoiceStatus> {
    const configuration = this.configuration();
    const hasApiKey = !!(await this.vault.get(keyReference));
    const issues = voiceConfigurationIssues(configuration, hasApiKey);
    return {
      configuration,
      hasApiKey,
      transcriptionAvailable: !issues.transcription,
      speechAvailable: !issues.speech,
      transcriptionUnavailableReason: issues.transcription || undefined,
      speechUnavailableReason: issues.speech || undefined,
      mode: 'segmented',
      maxRecordingMs: maxVoiceRecordingMs,
    };
  }
  private async save(params: Record<string, unknown>) {
    const { input } = z
      .object({
        input: configurationSchema.extend({
          apiKey: z.string().trim().max(4096).optional(),
          clearApiKey: z.boolean().optional(),
        }),
      })
      .parse(params);
    if (input.clearApiKey) await this.vault.delete(keyReference);
    else if (input.apiKey) await this.vault.set(keyReference, input.apiKey);
    const { apiKey: _key, clearApiKey: _clear, ...configuration } = input;
    this.state.storage.setMetadata('voice-configuration', configuration);
    this.state.changed();
    return this.status();
  }
  private async transcribe(
    config: VoiceConfiguration,
    headers: Record<string, string>,
    params: Record<string, unknown>,
    signal: AbortSignal,
  ) {
    const input = z
      .object({
        audioBase64: z
          .string()
          .min(4)
          .max(12 * 1024 * 1024)
          .regex(/^[A-Za-z0-9+/]*={0,2}$/),
        mimeType: z.enum(['audio/webm', 'audio/ogg', 'audio/wav', 'audio/mp4', 'audio/mpeg']),
        durationMs: z
          .number()
          .positive()
          .max(maxVoiceRecordingMs + 2000),
      })
      .parse(params);
    const bytes = Buffer.from(input.audioBase64, 'base64');
    if (bytes.length > 8 * 1024 * 1024) throw new Error('录音超过 8 MiB');
    const extensions: Record<string, string> = {
      'audio/webm': 'webm',
      'audio/ogg': 'ogg',
      'audio/wav': 'wav',
      'audio/mp4': 'mp4',
      'audio/mpeg': 'mp3',
    };
    const body = new FormData();
    body.set(
      'file',
      new Blob([bytes], { type: input.mimeType }),
      `recording.${extensions[input.mimeType]}`,
    );
    body.set('model', config.transcriptionModel);
    body.set('response_format', 'json');
    if (config.language) body.set('language', config.language);
    const result = await voiceHttp(
      `${config.baseUrl}/audio/transcriptions`,
      { method: 'POST', headers, body },
      signal,
    );
    let value: unknown;
    try {
      value = JSON.parse(result.bytes.toString('utf8'));
    } catch {
      throw new Error('语音识别服务返回格式错误');
    }
    return z.object({ text: z.string().max(40_000) }).parse(value);
  }
  private async speak(
    config: VoiceConfiguration,
    headers: Record<string, string>,
    params: Record<string, unknown>,
    signal: AbortSignal,
  ) {
    const { text } = z.object({ text: z.string().trim().min(1).max(4000) }).parse(params);
    const result = await voiceHttp(
      `${config.baseUrl}/audio/speech`,
      {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: config.speechModel,
          voice: config.voice,
          input: text,
          response_format: 'mp3',
        }),
      },
      signal,
    );
    if (!result.bytes.length || !/^(audio\/|application\/octet-stream)/i.test(result.mimeType))
      throw new Error('语音合成服务返回了无效音频');
    return { audioBase64: result.bytes.toString('base64'), mimeType: 'audio/mpeg' };
  }
}
