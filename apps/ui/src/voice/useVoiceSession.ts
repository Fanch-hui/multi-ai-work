import { useEffect, useRef, useState } from 'react';
import type { VoiceAudio, VoiceStatus } from '../../../../src/domain/voice.js';
import { errorMessage, request } from '../api.js';
import { VoiceRecorder, recordingBase64 } from './recorder.js';
import { SystemSpeechRecognition } from './system-recognition.js';

export type VoicePhase = 'idle' | 'recording' | 'transcribing' | 'waiting' | 'speaking';
export interface VoiceReply {
  id: string;
  text: string;
}
export function useVoiceSession({
  conversationId,
  onSubmit,
  onDictation,
  taskError,
  reply,
}: {
  conversationId: string;
  onSubmit: (text: string) => void | Promise<unknown>;
  onDictation?: (text: string) => void | Promise<unknown>;
  taskError?: string;
  reply?: VoiceReply;
}) {
  const [status, setStatus] = useState<VoiceStatus>();
  const [session, setSession] = useState({ phase: 'idle' as VoicePhase, continuous: false });
  const phase = session.phase;
  const [error, setError] = useState('');
  const [loadedConversationId, setLoadedConversationId] = useState<string>();
  const state = useRef({
    version: 0,
    continuous: false,
    recognition: undefined as SystemSpeechRecognition | undefined,
    release: undefined as Promise<void> | undefined,
    recorder: undefined as VoiceRecorder | undefined,
    audio: undefined as HTMLAudioElement | undefined,
    url: '',
    requestId: '',
    lastReply: '',
    priorTaskError: taskError,
  });
  const current = useRef({ onSubmit, onDictation, reply });
  current.current = { onSubmit, onDictation, reply };
  function change(next: VoicePhase) {
    setSession({ phase: next, continuous: state.current.continuous });
  }
  function stopPlayback() {
    state.current.audio?.pause();
    state.current.audio = undefined;
    if (state.current.url) URL.revokeObjectURL(state.current.url);
    state.current.url = '';
  }
  function end(reportFailure = true) {
    state.current.version++;
    const version = state.current.version;
    state.current.continuous = false;
    state.current.recorder?.close();
    state.current.recorder = undefined;
    const recognition = state.current.recognition;
    state.current.recognition = undefined;
    if (recognition) {
      const release = recognition.close();
      state.current.release = release;
      void release.then(
        () => {
          if (state.current.release === release) state.current.release = undefined;
        },
        (cause) => {
          if (state.current.release === release) state.current.release = undefined;
          if (reportFailure && state.current.version === version) setError(errorMessage(cause));
        },
      );
    }
    const release = state.current.release;
    stopPlayback();
    if (state.current.requestId)
      void request('voice.cancel', { requestId: state.current.requestId }).catch(() => {});
    state.current.requestId = '';
    change('idle');
    return release;
  }
  useEffect(() => {
    let disposed = false;
    void request<VoiceStatus>('voice.status')
      .then((value) => {
        if (!disposed) setStatus(value);
      })
      .catch((cause) => {
        if (!disposed) setError(errorMessage(cause));
      })
      .finally(() => {
        if (!disposed) setLoadedConversationId(conversationId);
      });
    return () => {
      disposed = true;
      void end(false);
    };
  }, [conversationId]);

  async function recognizeDictation() {
    const recognition = new SystemSpeechRecognition();
    state.current.recognition = recognition;
    return recognition.start(status?.configuration.dictationLanguage);
  }
  async function recognizeConversation(version: number) {
    const recorder = new VoiceRecorder();
    state.current.recorder = recorder;
    const recording = await recorder.start(true);
    if (!recording || state.current.version !== version) return;
    state.current.recorder = undefined;
    change('transcribing');
    const requestId = crypto.randomUUID();
    state.current.requestId = requestId;
    const audioBase64 = await recordingBase64(recording.blob);
    if (state.current.version !== version) return;
    return request<{ text: string }>('voice.transcribe', {
      requestId,
      audioBase64,
      mimeType: recording.blob.type,
      durationMs: recording.durationMs,
    });
  }
  async function listen(version: number, release?: Promise<void>) {
    if (state.current.version !== version) return;
    change('recording');
    try {
      if (release) await release;
      if (state.current.version !== version) return;
      const result = await (state.current.continuous
        ? recognizeConversation(version)
        : recognizeDictation());
      if (!result || state.current.version !== version) return;
      state.current.recognition = undefined;
      state.current.requestId = '';
      if (!result.text.trim()) {
        if (state.current.continuous) void listen(version);
        else end();
        return;
      }
      state.current.lastReply = current.current.reply?.id ?? '';
      change('waiting');
      const submit = state.current.continuous
        ? current.current.onSubmit
        : current.current.onDictation;
      await submit?.(result.text);
      if (state.current.version === version && !state.current.continuous) end();
    } catch (cause) {
      if (state.current.version === version) {
        end();
        setError(errorMessage(cause));
      }
    }
  }
  function start(continuous: boolean) {
    const release = end(false);
    state.current.version++;
    setError('');
    if (!continuous && !status?.recognition?.available) {
      setError(status?.recognition?.reason || '请使用桌面 App 的语音输入或系统听写快捷键');
      return;
    }
    if (continuous && (!VoiceRecorder.supported() || !status?.transcriptionAvailable)) {
      setError(status?.transcriptionUnavailableReason || '当前环境无法录音，请使用桌面 App');
      return;
    }
    state.current.continuous = continuous;
    state.current.priorTaskError = taskError;
    state.current.lastReply = current.current.reply?.id ?? '';
    void listen(state.current.version, release);
  }
  async function speak(next: VoiceReply, version: number) {
    state.current.lastReply = next.id;
    change('speaking');
    try {
      if (!status?.speechAvailable) {
        await listen(version);
        return;
      }
      // Split long replies into speech requests without truncating the final response.
      const chunks = next.text.match(/[\s\S]{1,3500}/g) ?? [];
      for (const text of chunks) {
        if (state.current.version !== version) return;
        const requestId = crypto.randomUUID();
        state.current.requestId = requestId;
        const result = await request<VoiceAudio>('voice.speak', { requestId, text });
        if (state.current.version !== version) return;
        state.current.requestId = '';
        const bytes = Uint8Array.from(atob(result.audioBase64), (value) => value.charCodeAt(0));
        const url = URL.createObjectURL(new Blob([bytes], { type: result.mimeType }));
        state.current.url = url;
        const audio = new Audio(url);
        state.current.audio = audio;
        await new Promise<void>((resolve, reject) => {
          audio.onended = () => resolve();
          audio.onpause = () => resolve();
          audio.onerror = () => reject(new Error('语音播放失败'));
          void audio.play().catch(reject);
        });
        stopPlayback();
      }
      if (state.current.version === version) await listen(version);
    } catch (cause) {
      if (state.current.version === version) {
        end();
        setError(errorMessage(cause));
      }
    }
  }
  useEffect(() => {
    if (
      phase !== 'waiting' ||
      !state.current.continuous ||
      !reply?.text.trim() ||
      reply.id === state.current.lastReply
    )
      return;
    void speak(reply, state.current.version);
  }, [phase, reply?.id, reply?.text]);

  useEffect(() => {
    if (!taskError) {
      state.current.priorTaskError = undefined;
      return;
    }
    if (phase !== 'waiting' || taskError === state.current.priorTaskError) return;
    end();
    setError(taskError);
  }, [phase, taskError]);

  function interrupt() {
    const continuous = state.current.continuous;
    const release = end(false);
    state.current.version++;
    state.current.continuous = continuous;
    setError('');
    void listen(state.current.version, release);
  }
  return {
    status,
    statusLoaded: loadedConversationId === conversationId,
    phase,
    continuous: session.continuous,
    error,
    reportError: setError,
    supported: !!status?.recognition,
    conversationSupported: VoiceRecorder.supported(),
    start,
    end: () => end(),
    interrupt,
    finish: () => {
      if (state.current.continuous) {
        state.current.recorder?.stop();
        return;
      }
      const recognition = state.current.recognition;
      if (!recognition) return;
      const version = state.current.version;
      change('transcribing');
      void recognition.stop().catch((cause) => {
        if (state.current.version === version) {
          end();
          setError(errorMessage(cause));
        }
      });
    },
  };
}
