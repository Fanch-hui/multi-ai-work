import type { SystemSpeechResult } from '../../../../src/domain/system-speech.js';
import { request } from '../api.js';

export class SystemSpeechRecognition {
  private requestId = crypto.randomUUID();
  private pending = false;
  private started = false;
  private closed = false;

  async start(language?: string): Promise<SystemSpeechResult | undefined> {
    if (this.started || this.closed) throw new Error('这次语音识别已开始或结束');
    this.started = true;
    this.pending = true;
    try {
      const result = await request<SystemSpeechResult>('voice.recognition.start', {
        requestId: this.requestId,
        language,
      });
      return this.closed ? undefined : result;
    } catch (cause) {
      if (!this.closed) throw cause;
      return undefined;
    } finally {
      this.pending = false;
    }
  }

  async stop() {
    if (!this.pending || this.closed) return;
    await request('voice.recognition.stop', { requestId: this.requestId });
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    if (this.pending) await request('voice.recognition.cancel', { requestId: this.requestId });
  }
}
