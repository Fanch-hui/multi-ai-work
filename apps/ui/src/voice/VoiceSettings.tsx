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
  function update(
    name:
      | 'baseUrl'
      | 'dictationLanguage'
      | 'language'
      | 'transcriptionModel'
      | 'speechModel'
      | 'voice',
    value: string,
  ) {
    if (!status) return;
    setSaved(false);
    setStatus({ ...status, configuration: { ...status.configuration, [name]: value } });
  }
  const recognition = status?.recognition;
  let recognitionState = '请在桌面 App 中使用语音输入，或使用系统听写快捷键。';
  if (recognition?.available)
    recognitionState =
      recognition.authorization === 'not_determined'
        ? '首次使用时允许麦克风和语音识别。'
        : `系统语音识别已就绪 · ${recognition.locale}`;
  else if (recognition?.reason) recognitionState = recognition.reason;
  return (
    <form aria-label="语音设置" onSubmit={save} className="grid max-w-2xl gap-5">
      <p className="text-sm leading-6 text-slate-500">
        语音输入填入草稿；语音对话在停顿后发送并朗读回复。
      </p>
      {status && (
        <>
          <fieldset className="grid min-w-0 gap-3">
            <legend className="mb-3 text-sm font-semibold text-slate-700">语音输入</legend>
            <p role="status" className="text-sm text-slate-500">
              {recognitionState}
            </p>
            <Field label="输入语言">
              <input
                className={inputClass}
                value={status.configuration.dictationLanguage ?? ''}
                placeholder="留空使用系统语言"
                onChange={(event) => update('dictationLanguage', event.target.value)}
              />
            </Field>
          </fieldset>
          <fieldset className="grid min-w-0 gap-4 border-t border-slate-100 pt-4">
            <legend className="pr-3 text-sm font-semibold text-slate-700">语音对话</legend>
            <p className="text-xs text-slate-500">录音发送至下方服务识别，回复由同一服务朗读。</p>
            <Field label="服务地址（包含 /v1）">
              <input
                className={inputClass}
                value={status.configuration.baseUrl}
                placeholder="https://api.openai.com/v1"
                onChange={(event) => update('baseUrl', event.target.value)}
              />
            </Field>
            <Field
              label={`API Key${status.hasApiKey ? '（已保存，留空保留）' : '（免密钥服务可留空）'}`}
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
            <Field label="识别模型">
              <input
                className={inputClass}
                value={status.configuration.transcriptionModel}
                placeholder="填写服务商支持的语音识别模型 ID"
                onChange={(event) => update('transcriptionModel', event.target.value)}
              />
            </Field>
            <Field label="识别语言">
              <input
                className={inputClass}
                value={status.configuration.language}
                placeholder="zh"
                onChange={(event) => update('language', event.target.value)}
              />
            </Field>
            <Field label="合成模型">
              <input
                className={inputClass}
                value={status.configuration.speechModel}
                placeholder="填写服务商支持的语音合成模型 ID"
                onChange={(event) => update('speechModel', event.target.value)}
              />
            </Field>
            <Field label="音色">
              <input
                className={inputClass}
                value={status.configuration.voice}
                placeholder="alloy"
                onChange={(event) => update('voice', event.target.value)}
              />
            </Field>
          </fieldset>
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
