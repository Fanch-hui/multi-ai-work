import { useState, type FormEvent } from 'react';
import type { Connection, ProviderKind } from '../../../src/domain/types.js';
import type { Mutate } from './store.js';
import { Button, ErrorNote, Field, Modal, inputClass } from './components.js';
import { useConnectionFlow } from './useConnectionFlow.js';
import { ConnectionAuthorization } from './ConnectionAuthorization.js';
const providerLabels: Record<ProviderKind, string> = {
  antigravity: 'Antigravity CLI（agy）',
  chatgpt: 'ChatGPT',
  qoder: 'Qoder CN',
  custom: '自定义 API',
};
export function ConnectionEditor({
  connection,
  connections,
  mutate,
  close,
  initialProvider,
  inline = false,
  connected,
}: {
  connection?: Connection;
  connections: Connection[];
  mutate: Mutate;
  close: () => void;
  initialProvider?: 'chatgpt' | 'custom';
  inline?: boolean;
  connected?: (connection: Connection) => void;
}) {
  const [provider, setProvider] = useState<ProviderKind>(
    connection?.provider || initialProvider || 'custom',
  );
  const [name, setName] = useState(connection?.name || '');
  const [protocol, setProtocol] = useState(connection?.protocol || 'chat-completions');
  const [baseUrl, setUrl] = useState(connection?.baseUrl || '');
  const [secret, setSecret] = useState('');
  const [apiAuth, setApiAuth] = useState<'api-key' | 'none'>(
    connection?.authMode === 'none' ? 'none' : 'api-key',
  );
  const [qoderAuth, setQoderAuth] = useState<'local' | 'pat'>(
    connection?.authMode === 'pat' ? 'pat' : 'local',
  );
  const [executable, setExecutable] = useState(
    connection?.executableMode === 'auto' ? '' : connection?.executable || '',
  );
  const [concurrency, setConcurrency] = useState(connection?.concurrency ?? 5);
  const flow = useConnectionFlow(connections, mutate, (saved) => {
    if (connected) connected(saved);
    else close();
  });
  async function save(event: FormEvent) {
    event.preventDefault();
    await flow.connect(
      {
        id: connection?.id,
        name: name || providerLabels[provider],
        provider,
        protocol: provider === 'custom' ? protocol : undefined,
        baseUrl: baseUrl || undefined,
        executable: executable || undefined,
        executableMode: ['antigravity', 'qoder'].includes(provider)
          ? executable
            ? 'explicit'
            : 'auto'
          : undefined,
        concurrency,
        authMode:
          provider === 'custom'
            ? apiAuth
            : provider === 'chatgpt'
              ? 'oauth'
              : provider === 'qoder'
                ? qoderAuth
                : 'local',
        secret: secret || undefined,
      },
      provider,
    );
    setSecret('');
  }
  const content = (
    <>
      {['authorization', 'waiting', 'signingIn'].includes(flow.phase) ||
      (flow.phase === 'checking' && flow.connectionId) ? (
        <ConnectionAuthorization
          flow={flow}
          canLogin={provider !== 'custom' && !(provider === 'qoder' && qoderAuth === 'pat')}
        />
      ) : (
        <form className="grid gap-4" onSubmit={(event) => void save(event)}>
          <fieldset disabled={flow.busy} className="grid min-w-0 gap-4">
            {!initialProvider && (
              <Field label="通道">
                <select
                  className={inputClass}
                  value={provider}
                  disabled={!!connection || !!flow.connectionId}
                  onChange={(event) => setProvider(event.target.value as ProviderKind)}
                >
                  {Object.entries(providerLabels).map(([key, label]) => (
                    <option key={key} value={key}>
                      {label}
                    </option>
                  ))}
                </select>
              </Field>
            )}
            {!inline && (
              <Field label="连接名称">
                <input
                  className={inputClass}
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  placeholder={providerLabels[provider]}
                />
              </Field>
            )}
            {inline && provider === 'chatgpt' && (
              <p className="text-sm leading-6 text-slate-500">
                使用你的 ChatGPT 账号登录，授权完成后选择管家的模型。
              </p>
            )}
            {provider === 'custom' && (
              <>
                <Field label="协议">
                  <select
                    className={inputClass}
                    value={protocol}
                    onChange={(event) => setProtocol(event.target.value as typeof protocol)}
                  >
                    <option value="chat-completions">Chat Completions</option>
                    <option value="responses">Responses</option>
                  </select>
                </Field>
                <Field label="API 地址">
                  <input
                    type="url"
                    className={inputClass}
                    value={baseUrl}
                    onChange={(event) => setUrl(event.target.value)}
                    required
                    placeholder="https://api.example.com/v1"
                  />
                </Field>
                <Field label="认证方式">
                  <select
                    className={inputClass}
                    value={apiAuth}
                    onChange={(event) => setApiAuth(event.target.value as typeof apiAuth)}
                  >
                    <option value="api-key">API Key</option>
                    <option value="none">无需认证</option>
                  </select>
                </Field>
                {apiAuth === 'api-key' && (
                  <Field
                    label="API Key"
                    hint={
                      connection?.secretRef
                        ? '已保存凭据。留空保留，输入新值替换。'
                        : '凭据保存到本应用的系统保护存储。'
                    }
                  >
                    <input
                      type="password"
                      autoComplete="new-password"
                      className={inputClass}
                      value={secret}
                      onChange={(event) => setSecret(event.target.value)}
                    />
                  </Field>
                )}
              </>
            )}
            {['antigravity', 'qoder'].includes(provider) && (
              <Field
                label="运行时路径"
                hint={
                  provider === 'antigravity'
                    ? '留空自动检测本机 agy，复用原生登录；未安装时提供安装指引。'
                    : '填写绝对路径，留空自动检测本机或 App 运行时。'
                }
              >
                <input
                  className={inputClass}
                  value={executable}
                  onChange={(event) => setExecutable(event.target.value)}
                  placeholder={
                    provider === 'antigravity' ? '自动检测已安装的 agy' : 'Qoder CN SDK 默认路径'
                  }
                />
              </Field>
            )}
            {provider === 'qoder' && (
              <>
                <Field label="授权方式">
                  <select
                    className={inputClass}
                    value={qoderAuth}
                    onChange={(event) => setQoderAuth(event.target.value as typeof qoderAuth)}
                  >
                    <option value="local">官方登录</option>
                    <option value="pat">PAT</option>
                  </select>
                </Field>
                {qoderAuth === 'pat' && (
                  <Field
                    label="PAT"
                    hint={
                      connection?.secretRef
                        ? '留空保留已保存凭据。'
                        : '凭据保存在本应用的系统保护存储。'
                    }
                  >
                    <input
                      type="password"
                      autoComplete="new-password"
                      className={inputClass}
                      value={secret}
                      onChange={(event) => setSecret(event.target.value)}
                    />
                  </Field>
                )}
              </>
            )}
            {!inline && (
              <Field label="此连接同时工作的智能体上限">
                <input
                  className={inputClass}
                  type="number"
                  min={1}
                  max={10}
                  value={concurrency}
                  onChange={(event) => setConcurrency(Number(event.target.value))}
                />
              </Field>
            )}
          </fieldset>
          <ErrorNote error={flow.error} />
          <div className="mt-2 flex justify-end gap-2">
            <Button type="button" onClick={close}>
              {inline ? '返回' : '取消'}
            </Button>
            <Button variant="primary" disabled={flow.busy}>
              {flow.phase === 'saving'
                ? '准备连接…'
                : flow.phase === 'checking'
                  ? '连接中…'
                  : inline && provider === 'chatgpt'
                    ? 'Sign in ChatGPT'
                    : '连接'}
            </Button>
          </div>
        </form>
      )}
    </>
  );
  return inline ? (
    content
  ) : (
    <Modal
      open
      onOpenChange={(open) => !open && close()}
      title={connection ? '配置连接' : '添加连接'}
    >
      {content}
    </Modal>
  );
}
