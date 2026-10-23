import { Mic, Phone, Square, VolumeX } from 'lucide-react';
import { Button } from '../components.js';
import { useVoiceSession, type VoiceReply } from './useVoiceSession.js';

const labels = {
  idle: '',
  recording: '正在听你说话',
  transcribing: '正在识别',
  waiting: '等待回复',
  speaking: '正在朗读（AI 合成语音）',
};
export function VoiceControls(props: {
  conversationId: string;
  onSubmit: (text: string) => void | Promise<unknown>;
  onDictation?: (text: string) => void | Promise<unknown>;
  taskError?: string;
  reply?: VoiceReply;
  busy?: boolean;
  disabled?: boolean;
}) {
  const voice = useVoiceSession(props);
  const unavailable = props.disabled || !voice.supported || !voice.status?.transcriptionAvailable;
  let title = '录音将发送至已配置的语音服务';
  if (!voice.status?.transcriptionAvailable) title = '请先在设置中配置语音服务';
  if (!voice.supported) title = '当前环境不支持麦克风录音';
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500">
      {voice.phase === 'idle' ? (
        <>
          <Button
            type="button"
            title={title}
            disabled={unavailable || props.busy}
            onClick={() => voice.start(false)}
          >
            <Mic size={15} />
            语音输入
          </Button>
          <Button
            type="button"
            title={voice.status?.speechAvailable ? title : '请先在设置中配置语音合成模型与音色'}
            disabled={unavailable || props.busy || !voice.status?.speechAvailable}
            onClick={() => voice.start(true)}
          >
            <Phone size={15} />
            语音对话
          </Button>
        </>
      ) : (
        <>
          <span role="status">{labels[voice.phase]}</span>
          {voice.phase === 'recording' && (
            <Button type="button" onClick={voice.finish}>
              说完了
            </Button>
          )}
          {(voice.phase === 'speaking' || voice.phase === 'waiting') && (
            <Button type="button" onClick={voice.interrupt}>
              <VolumeX size={15} />
              打断并说话
            </Button>
          )}
          <Button type="button" onClick={voice.end}>
            <Square size={13} />
            结束
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
