import { Fragment, useEffect, useState, type FormEvent } from 'react';
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
    <form aria-label="语音设置" onSubmit={save} className="grid max-w-2xl gap-4">
      <div>
        <p className="text-sm leading-6 text-slate-500">
          语音输入将识别结果填入可编辑草稿；语音对话在停顿后发送给管家，并朗读回复。
          两者共用下方识别服务，录音在内存中处理并发送至所填地址。
        </p>
      </div>
      {status && (
        <>
          <Field label="服务地址（包含 /v1）">
            <input
              className={inputClass}
              value={status.configuration.baseUrl}
              placeholder="https://api.openai.com/v1"
              onChange={(event) => {
                setSaved(false);
                setStatus({
                  ...status,
                  configuration: { ...status.configuration, baseUrl: event.target.value },
                });
              }}
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
          <p className="text-xs text-slate-500">
            识别与朗读共用此密钥；ChatGPT 登录与语音服务分别配置。
          </p>
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
          {(
            [
              ['transcriptionModel', '识别模型', '填写服务商支持的语音识别模型 ID'],
              ['language', '识别语言', 'zh'],
              ['speechModel', '合成模型', '填写服务商支持的语音合成模型 ID'],
              ['voice', '音色', 'alloy'],
            ] as const
          ).map(([name, label, placeholder]) => (
            <Fragment key={name}>
              {name === 'transcriptionModel' && (
                <h3 className="mt-2 text-sm font-semibold text-slate-700">
                  语音识别 · 两种功能共用
                </h3>
              )}
              {name === 'speechModel' && (
                <h3 className="mt-2 text-sm font-semibold text-slate-700">
                  回复朗读 · 语音对话使用
                </h3>
              )}
              <Field label={label}>
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
            </Fragment>
          ))}
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
