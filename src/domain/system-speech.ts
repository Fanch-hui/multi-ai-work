import { z } from 'zod';

export const systemSpeechLanguageSchema = z
  .string()
  .trim()
  .max(64)
  .regex(/^[a-zA-Z0-9_-]*$/, '请填写语言代码，例如 zh-CN')
  .optional();

export interface SystemSpeechStatus {
  available: boolean;
  locale: string;
  authorization: 'authorized' | 'not_determined' | 'denied' | 'restricted' | 'unavailable';
  reason?: string;
}

export interface SystemSpeechInput {
  requestId: string;
  language?: string;
}

export interface SystemSpeechResult {
  text: string;
}
