import { useEffect, useRef } from 'react';
import { Check, Mic, Square, VolumeX } from 'lucide-react';
import { Button } from '../components.js';
import { useVoiceSession, type VoiceReply } from './useVoiceSession.js';

const labels = {
  idle: '',
  recording: '正在听你说话',
  transcribing: '正在识别',
  waiting: '等待回复',
  speaking: '正在朗读',
};
export function VoiceControls(props: {
  conversationId: string;
  onSubmit: (text: string) => void | Promise<unknown>;
  onDictation?: (text: string) => void | Promise<unknown>;
  taskError?: string;
  reply?: VoiceReply;
  busy?: boolean;
  disabled?: boolean;
  conversationStartToken?: number;
  onConversationStateChange?: (active: boolean) => void;
  onConversationStartHandled?: (token: number) => void;
}) {
  const voice = useVoiceSession(props);
  const handled = useRef<number | undefined>(undefined);
  const active = voice.continuous && voice.phase !== 'idle';
  const unavailable =
    props.disabled ||
    !voice.statusLoaded ||
    !voice.supported ||
    !voice.status?.transcriptionAvailable;
  let issue = '';
  if (!voice.supported) issue = '当前环境不支持麦克风录音，请使用桌面应用或本机安全页面';
  else if (!voice.statusLoaded) issue = '正在读取语音设置';
  else if (!voice.status) issue = voice.error || '无法读取语音设置，请重试';
  else if (!voice.status.transcriptionAvailable)
    issue = voice.status.transcriptionUnavailableReason || '请在语音设置中填写语音识别模型';
  const title = issue || '语音输入：识别后填入草稿';
  useEffect(() => {
    props.onConversationStateChange?.(active);
  }, [active, props.onConversationStateChange]);
  useEffect(() => () => props.onConversationStateChange?.(false), []);
  useEffect(() => {
    const token = props.conversationStartToken;
    if (token === undefined || handled.current === token || !voice.statusLoaded) return;
    handled.current = token;
    let reason = issue;
    if (!reason && !voice.status?.speechAvailable)
      reason = voice.status?.speechUnavailableReason || '请在语音设置中填写语音合成模型与音色';
    if (!reason && (props.disabled || props.busy)) reason = '当前对话正在处理，请稍后开始语音对话';
    if (reason) voice.reportError(reason);
    else voice.start(true);
    props.onConversationStartHandled?.(token);
  }, [props.conversationStartToken, voice.statusLoaded]);
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500">
      {voice.phase === 'idle' ? (
        <>
          <Button
            type="button"
            title={title}
            aria-label="语音输入"
            className="size-9 p-0"
            disabled={unavailable || props.busy}
            onClick={() => voice.start(false)}
          >
            <Mic size={15} />
          </Button>
        </>
      ) : (
        <>
          <span role="status">{labels[voice.phase]}</span>
          {voice.phase === 'recording' && (
            <Button
              type="button"
              title="说完了"
              aria-label="说完了"
              className="size-9 p-0"
              onClick={voice.finish}
            >
              <Check size={15} />
            </Button>
          )}
          {(voice.phase === 'speaking' || voice.phase === 'waiting') && (
            <Button
              type="button"
              title="打断并说话"
              aria-label="打断并说话"
              className="size-9 p-0"
              onClick={voice.interrupt}
            >
              <VolumeX size={15} />
            </Button>
          )}
          <Button
            type="button"
            title="结束语音"
            aria-label="结束语音"
            className="size-9 p-0"
            onClick={voice.end}
          >
            <Square size={13} />
          </Button>
        </>
      )}
      {voice.error && (
        <span role="alert" className="text-red-600">
          {voice.error}
        </span>
      )}
    </div>
  );
}
