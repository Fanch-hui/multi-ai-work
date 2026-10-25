import type { SystemSpeechStatus } from './system-speech.js';

export interface VoiceConfiguration {
  dictationLanguage?: string;
  baseUrl: string;
  transcriptionModel: string;
  speechModel: string;
  voice: string;
  language: string;
}
export interface VoiceStatus {
  recognition?: SystemSpeechStatus;
  configuration: VoiceConfiguration;
  hasApiKey: boolean;
  transcriptionAvailable: boolean;
  speechAvailable: boolean;
  transcriptionUnavailableReason?: string;
  speechUnavailableReason?: string;
  mode: 'segmented';
  maxRecordingMs: number;
}
export interface VoiceAudio {
  audioBase64: string;
  mimeType: string;
}
export const maxVoiceRecordingMs = 45_000;

export function voiceConfigurationIssues(configuration: VoiceConfiguration, hasApiKey: boolean) {
  const shared: string[] = [];
  if (new URL(configuration.baseUrl).hostname === 'api.openai.com' && !hasApiKey)
    shared.push('API Key（OpenAI 语音服务单独配置）');
  const transcription = [...shared];
  if (!configuration.transcriptionModel.trim()) transcription.push('语音识别模型');
  const speech = [...shared];
  if (!configuration.speechModel.trim()) speech.push('语音合成模型');
  if (!configuration.voice.trim()) speech.push('音色');
  return {
    transcription: transcription.length ? `请在语音设置中填写${transcription.join('、')}` : '',
    speech: speech.length ? `请在语音设置中填写${speech.join('、')}` : '',
  };
}
