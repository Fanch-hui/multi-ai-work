import { afterEach, describe, expect, it, vi } from 'vitest';
import { VoiceRecorder, recordingBase64 } from '../apps/ui/src/voice/recorder.js';

function environment(deferred = false) {
  const stop = vi.fn();
  const stream = { getTracks: () => [{ stop }] };
  let allow: (value: unknown) => void = () => {};
  const getUserMedia = vi.fn(() =>
    deferred
      ? new Promise((resolve) => {
          allow = resolve;
        })
      : Promise.resolve(stream),
  );
  const close = vi.fn(async () => {});
  class Context {
    resume = async () => {};
    close = close;
    createAnalyser = () => ({ fftSize: 2048, getFloatTimeDomainData: () => {} });
    createMediaStreamSource = () => ({ connect: () => {} });
  }
  class Recorder {
    static isTypeSupported() {
      return true;
    }
    static current: Recorder;
    state = 'inactive';
    mimeType = 'audio/webm;codecs=opus';
    ondataavailable?: (event: { data: Blob }) => void;
    onstop?: () => void;
    onerror?: () => void;
    constructor() {
      Recorder.current = this;
    }
    start() {
      this.state = 'recording';
    }
    stop() {
      this.state = 'inactive';
      this.ondataavailable?.({ data: new Blob(['synthetic-audio']) });
      this.onstop?.();
    }
  }
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } });
  vi.stubGlobal('AudioContext', Context);
  vi.stubGlobal('MediaRecorder', Recorder);
  vi.stubGlobal(
    'requestAnimationFrame',
    vi.fn(() => 1),
  );
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
  return { stop, close, getUserMedia, allow: () => allow(stream), Recorder };
}
async function flush() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}
afterEach(() => vi.unstubAllGlobals());

describe('麦克风生命周期', () => {
  it('只在start请求权限，完成段落释放麦克风与AudioContext，保留实际音频', async () => {
    const { getUserMedia, stop, close } = environment();
    const recorder = new VoiceRecorder();
    expect(VoiceRecorder.supported()).toBe(true);
    expect(getUserMedia).not.toHaveBeenCalled();
    const pending = recorder.start(false);
    await flush();
    recorder.stop();
    const result = await pending;
    expect(await result?.blob.text()).toBe('synthetic-audio');
    expect(result?.blob.type).toBe('audio/webm');
    expect(stop).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
    expect(getUserMedia).toHaveBeenCalledWith({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
  });
  it('结束录音丢弃片段；权限请求完成前结束同样释放新获得的麦克风', async () => {
    const first = environment();
    const recorder = new VoiceRecorder();
    const pending = recorder.start(true);
    await flush();
    recorder.close();
    expect(await pending).toBeUndefined();
    expect(first.stop).toHaveBeenCalledOnce();
    const second = environment(true);
    const next = new VoiceRecorder();
    const starting = next.start(true);
    next.close();
    second.allow();
    expect(await starting).toBeUndefined();
    expect(second.stop).toHaveBeenCalledOnce();
  });
  it('二进制录音完整编码，超过大小限制即释放资源', async () => {
    const { Recorder, stop } = environment();
    const recorder = new VoiceRecorder();
    const pending = recorder.start(false);
    await flush();
    Recorder.current.ondataavailable?.({ data: new Blob([new Uint8Array(8 * 1024 * 1024 + 1)]) });
    await expect(pending).rejects.toThrow('8 MiB');
    expect(stop).toHaveBeenCalledOnce();
    expect(await recordingBase64(new Blob([new Uint8Array([0, 128, 255])]))).toBe('AID/');
  });
});
