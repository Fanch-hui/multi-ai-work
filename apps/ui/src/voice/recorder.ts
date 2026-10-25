import { maxVoiceRecordingMs } from '../../../../src/domain/voice.js';

export interface VoiceRecording {
  blob: Blob;
  durationMs: number;
}
export class VoiceRecorder {
  private stream?: MediaStream;
  private context?: AudioContext;
  private recorder?: MediaRecorder;
  private frame = 0;
  private closed = false;
  private started = 0;
  private finish?: (recording?: VoiceRecording) => void;

  static supported() {
    return (
      typeof navigator !== 'undefined' &&
      !!navigator.mediaDevices?.getUserMedia &&
      typeof MediaRecorder !== 'undefined' &&
      typeof AudioContext !== 'undefined'
    );
  }
  async start(autoSegment: boolean): Promise<VoiceRecording | undefined> {
    try {
      return await this.record(autoSegment);
    } catch (cause) {
      this.close();
      throw microphoneError(cause);
    }
  }
  private async record(autoSegment: boolean): Promise<VoiceRecording | undefined> {
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
    if (this.closed) {
      this.close();
      return;
    }
    this.context = new AudioContext();
    await this.context.resume();
    if (this.closed) return;
    const analyser = this.context.createAnalyser();
    analyser.fftSize = 2048;
    this.context.createMediaStreamSource(this.stream).connect(analyser);
    const mimeType = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/mp4'].find(
      (value) => MediaRecorder.isTypeSupported(value),
    );
    this.recorder = new MediaRecorder(this.stream, mimeType ? { mimeType } : undefined);
    const chunks: Blob[] = [];
    let size = 0;
    this.started = performance.now();
    const result = new Promise<VoiceRecording | undefined>((resolve, reject) => {
      this.finish = resolve;
      this.recorder!.ondataavailable = (event) => {
        if (this.closed) return;
        size += event.data.size;
        if (size > 8 * 1024 * 1024) {
          reject(new Error('录音超过 8 MiB，请缩短录音'));
          this.close();
          return;
        }
        if (event.data.size) chunks.push(event.data);
      };
      this.recorder!.onerror = () => {
        reject(new Error('麦克风录音失败'));
        this.close();
      };
      this.recorder!.onstop = () => {
        if (!this.closed && size)
          resolve({
            blob: new Blob(chunks, { type: this.recorder!.mimeType.split(';')[0] }),
            durationMs: Math.min(performance.now() - this.started, maxVoiceRecordingMs),
          });
        else resolve(undefined);
        this.release();
      };
    });
    this.recorder.start(250);
    const samples = new Float32Array(analyser.fftSize);
    let speech = false;
    let lastSpeech = this.started;
    const sample = () => {
      if (this.closed || this.recorder?.state !== 'recording') return;
      analyser.getFloatTimeDomainData(samples);
      const rms = Math.sqrt(
        samples.reduce((sum, value) => sum + value * value, 0) / samples.length,
      );
      const time = performance.now();
      if (rms > 0.025) {
        speech = true;
        lastSpeech = time;
      }
      if (
        time - this.started >= maxVoiceRecordingMs ||
        (autoSegment && speech && time - lastSpeech > 1000 && time - this.started > 500)
      ) {
        this.stop();
        return;
      }
      this.frame = requestAnimationFrame(sample);
    };
    this.frame = requestAnimationFrame(sample);
    return result;
  }
  stop() {
    if (this.recorder?.state === 'recording') this.recorder.stop();
  }
  close() {
    this.closed = true;
    this.stop();
    this.finish?.();
    this.release();
  }
  private release() {
    cancelAnimationFrame(this.frame);
    for (const track of this.stream?.getTracks() ?? []) track.stop();
    this.stream = undefined;
    if (this.context) void this.context.close();
    this.context = undefined;
  }
}

export async function recordingBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 8192)
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  return btoa(binary);
}

function microphoneError(cause: unknown): Error {
  if (!(cause instanceof Error)) return new Error(String(cause));
  if (cause.name === 'NotAllowedError' || cause.name === 'PermissionDeniedError')
    return new Error('麦克风权限未开启，请在系统或浏览器设置中允许此应用使用麦克风');
  if (cause.name === 'NotFoundError' || cause.name === 'DevicesNotFoundError')
    return new Error('未找到麦克风，请连接麦克风并检查系统输入设备');
  if (cause.name === 'NotReadableError' || cause.name === 'TrackStartError')
    return new Error('麦克风无法录音，请检查设备是否被占用或已停用');
  if (cause.name === 'SecurityError')
    return new Error('当前页面无法使用麦克风，请使用桌面应用或本机安全页面');
  return cause;
}
