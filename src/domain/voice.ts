export interface VoiceConfiguration {
  baseUrl: string;
  transcriptionModel: string;
  speechModel: string;
  voice: string;
  language: string;
}
export interface VoiceStatus {
  configuration: VoiceConfiguration;
  hasApiKey: boolean;
  transcriptionAvailable: boolean;
  speechAvailable: boolean;
  mode: 'segmented';
  maxRecordingMs: number;
}
export interface VoiceAudio {
  audioBase64: string;
  mimeType: string;
}
export const maxVoiceRecordingMs = 45_000;
