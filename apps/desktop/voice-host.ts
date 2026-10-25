import { join } from 'node:path';
import { z } from 'zod';
import type { VoiceStatus } from '../../src/domain/voice.js';
import type { SystemSpeechInput } from '../../src/domain/system-speech.js';
import { SystemSpeechHost, type SpeechLaunch } from './system-speech-host.js';

export function systemSpeechLaunch(
  platform: string,
  resources: string,
  project?: string,
): SpeechLaunch {
  if (platform === 'darwin') {
    const helperPath = project
      ? join(project, '.data/system-speech-build/system-speech-helper')
      : join(resources, 'system-speech-helper');
    return { command: helperPath, helperPath };
  }
  if (platform === 'win32') {
    const helperPath = project
      ? join(project, 'apps/desktop/speech-windows.ps1')
      : join(resources, 'speech-windows.ps1');
    return {
      command: join(
        process.env.SystemRoot ?? 'C:\\Windows',
        'System32/WindowsPowerShell/v1.0/powershell.exe',
      ),
      args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', helperPath],
      helperPath,
    };
  }
  return {};
}

export class DesktopVoiceService {
  constructor(
    private coreRequest: (method: string, params: Record<string, unknown>) => Promise<unknown>,
    readonly recognition: SystemSpeechHost,
  ) {}

  async request(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (method === 'voice.recognition.start')
      return this.recognition.start(params as unknown as SystemSpeechInput);
    if (method === 'voice.recognition.stop' || method === 'voice.recognition.cancel') {
      const requestId = z.string().min(1).max(100).parse(params.requestId);
      if (method.endsWith('.stop')) await this.recognition.stop(requestId);
      else await this.recognition.cancel(requestId);
      return { ok: true };
    }
    const result = await this.coreRequest(method, params);
    if (method !== 'voice.status' && method !== 'voice.save') return result;
    const status = result as VoiceStatus;
    return {
      ...status,
      recognition: await this.recognition.status(status.configuration.dictationLanguage),
    } satisfies VoiceStatus;
  }

  close() {
    return this.recognition.close();
  }
}
