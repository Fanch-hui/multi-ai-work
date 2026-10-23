import { useEffect, useState, type FormEvent } from 'react';
import type { VoiceStatus } from '../../../../src/domain/voice.js';
import { request, errorMessage } from '../api.js';
import { Button, ErrorNote, Field, inputClass } from '../components.js';

export function VoiceSettings() {
  const [status, setStatus] = useState<VoiceStatus>();
  const [key, setKey] = useState('');
  const [clearKey, setClearKey] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    let disposed = false;
    void request<VoiceStatus>('voice.status')
      .then((value) => {
        if (!disposed) setStatus(value);
      })
      .catch((cause) => {
        if (!disposed) setError(errorMessage(cause));
      });
    return () => {
      disposed = true;
    };
  }, []);
  async function save(event: FormEvent) {
    event.preventDefault();
    if (!status || busy) return;
    setBusy(true);
    setError('');
    setSaved(false);
    try {
      const result = await request<VoiceStatus>('voice.save', {
        input: { ...status.configuration, ...(key ? { apiKey: key } : {}), clearApiKey: clearKey },
      });
      setStatus(result);
      setKey('');
      setClearKey(false);
      setSaved(true);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }
  return (
    <form onSubmit={save} className="grid max-w-2xl gap-4">
      <div>
        <h2 className="text-base font-semibold text-slate-800">语音</h2>
        <p className="mt-2 text-sm leading-6 text-slate-500">
          使用 OpenAI 兼容的语音识别与合成服务，也可连接本机兼容服务。语音对话在停顿后识别，
          交给当前成员处理，再朗读回复。点击录音后音频发送至下方地址，录音在内存中处理。
        </p>
      </div>
      {status && (
        <>
          {(
            [
              ['baseUrl', '服务地址（包含 /v1）', 'https://api.openai.com/v1'],
              ['transcriptionModel', '语音识别模型', '填写服务商支持的模型 ID'],
              ['speechModel', '语音合成模型', '填写服务商支持的模型 ID'],
              ['voice', '音色', 'alloy'],
              ['language', '识别语言', 'zh'],
            ] as const
          ).map(([name, label, placeholder]) => (
            <Field key={name} label={label}>
              <input
                className={inputClass}
                value={status.configuration[name]}
                placeholder={placeholder}
                onChange={(event) => {
                  setSaved(false);
                  setStatus({
                    ...status,
                    configuration: {
                      ...status.configuration,
                      [name]: event.target.value,
                    },
                  });
                }}
              />
            </Field>
          ))}
          <Field
            label={`API Key${status.hasApiKey ? '（已保存，留空保留）' : '（本机服务可留空）'}`}
          >
            <input
              className={inputClass}
              type="password"
              autoComplete="new-password"
              value={key}
              onChange={(event) => setKey(event.target.value)}
            />
          </Field>
          {status.hasApiKey && (
            <label className="flex items-center gap-2 text-sm text-slate-600">
              <input
                type="checkbox"
                checked={clearKey}
                onChange={(event) => setClearKey(event.target.checked)}
              />
              清除已保存的 API Key
            </label>
          )}
          <p className="text-xs text-slate-500">每段最长 45 秒；合成的回复以 AI 语音播放。</p>
          <div>
            <Button type="submit" disabled={busy}>
              {busy ? '正在保存' : '保存语音设置'}
            </Button>
            {saved && (
              <span role="status" className="ml-3 text-sm text-blue-700">
                已保存
              </span>
            )}
          </div>
        </>
      )}
      <ErrorNote error={error} />
    </form>
  );
}
