import { useState } from 'react';
import { Cable, LogIn, LogOut, Pencil, Plus, RefreshCw, Trash2, Users } from 'lucide-react';
import type { Snapshot, ToolConnection } from '../../../../src/domain/types.js';
import { ToolEditor } from '../ToolEditor.js';
import { ModalPresence } from '../ModalPresence.js';
import { Badge, Button, Confirm, ErrorNote, Field, Modal, inputClass } from '../components.js';
import type { Mutate } from '../store.js';
import { errorMessage } from '../api.js';
import { useResource } from '../local-work/useResource.js';
import { ConnectorDraftsPanel } from './ConnectorDraftsPanel.js';

interface ConnectorView extends ToolConnection {
  authenticated: boolean;
  authorizedBots: { id: string; name: string }[];
  authentication: { enabled: boolean; phase: string; error?: string };
}

export function ConnectorsPanel({ data, mutate }: { data: Snapshot; mutate: Mutate }) {
  const resource = useResource<ConnectorView[]>('connectors.list');
  const [editing, setEditing] = useState<ToolConnection | 'new'>();
  const [authorizing, setAuthorizing] = useState<ConnectorView>();
  const [login, setLogin] = useState<ConnectorView>();
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  async function run(method: string, params: Record<string, unknown>) {
    setBusy(String(params.id ?? method));
    setError('');
    try {
      await mutate(method, params);
      resource.reload();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy('');
    }
  }
  const editorMutate: Mutate = (method, params) =>
    mutate(method === 'tools.save' ? 'connectors.save' : method, params);
  return (
    <section className="grid gap-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold">应用连接器</h2>
          <p className="mt-1 text-sm text-slate-500">
            连接应用与资料服务，按成员授权，在聊天中调用。
          </p>
        </div>
        <Button variant="primary" onClick={() => setEditing('new')}>
          <Plus size={16} />
          添加连接器
        </Button>
      </div>
      <ErrorNote error={error || resource.error} />
      <div className="grid gap-3 md:grid-cols-3">
        {[
          ['远程 MCP', '服务商 MCP 地址，支持浏览器登录和 Bearer 凭据。'],
          ['本机 MCP', '使用本机安装的服务程序，发现其实际工具。'],
          ['HTTP 搜索', '连接真实搜索接口，支持 GET 和 POST。'],
        ].map(([name, description]) => (
          <div key={name} className="rounded-xl bg-slate-50 p-4">
            <h3 className="text-sm font-medium">{name}</h3>
            <p className="mt-1 text-xs leading-5 text-slate-500">{description}</p>
          </div>
        ))}
      </div>
      <div className="grid gap-3 xl:grid-cols-2">
        {resource.value?.map((connection) => (
          <article
            key={connection.id}
            className="min-w-0 rounded-xl border border-black/8 bg-white p-4"
          >
            <div className="flex items-start justify-between gap-3">
              <div className="flex min-w-0 gap-3">
                <Cable className="mt-1 shrink-0 text-slate-400" size={20} />
                <div className="min-w-0">
                  <h3 className="truncate font-semibold">{connection.name}</h3>
                  <p className="mt-1 break-all text-xs text-slate-500">
                    {connection.transport === 'stdio' ? connection.command : connection.url}
                  </p>
                </div>
              </div>
              <Badge status={connection.status} />
            </div>
            <p className="mt-3 text-xs text-slate-500">
              {authLabel(connection)} · {connection.toolNames.length} 个工具
            </p>
            <p className="mt-2 text-xs text-slate-500">
              已授权：
              {connection.authorizedBots.map((bot) => bot.name).join('、') || '尚未授权成员'}
            </p>
            <ErrorNote error={connection.authentication.error || connection.error || ''} />
            {connection.toolNames.length > 0 && (
              <details className="mt-3 text-xs">
                <summary className="cursor-pointer text-slate-600">查看可用工具</summary>
                <ul className="mt-2 grid gap-1 break-all text-slate-500">
                  {connection.toolNames.map((name) => (
                    <li key={name}>{name}</li>
                  ))}
                </ul>
              </details>
            )}
            <div className="mt-4 flex flex-wrap gap-2 border-t border-black/5 pt-3">
              {connection.kind !== 'search' && connection.transport !== 'stdio' && (
                <Button
                  disabled={
                    !!busy ||
                    ['authorizing', 'awaiting_user'].includes(connection.authentication.phase)
                  }
                  onClick={() => setLogin(connection)}
                >
                  <LogIn size={14} />
                  {connection.authentication.phase === 'awaiting_user'
                    ? '等待浏览器授权'
                    : '登录授权'}
                </Button>
              )}
              <Button
                disabled={!!busy}
                onClick={() => void run('connectors.probe', { id: connection.id })}
              >
                <RefreshCw size={14} />
                {busy === connection.id ? '处理中…' : '检测'}
              </Button>
              <Button variant="ghost" onClick={() => setAuthorizing(connection)}>
                <Users size={14} />
                授权成员
              </Button>
              <Button
                variant="ghost"
                onClick={() =>
                  setEditing(
                    data.toolConnections.find((item) => item.id === connection.id) ?? connection,
                  )
                }
              >
                <Pencil size={14} />
                配置
              </Button>
              {connection.authentication.enabled && (
                <Confirm
                  title={`退出 ${connection.name}？`}
                  description="清除本应用保存的 OAuth 登录，重新使用时需要授权。"
                  actionLabel="退出登录"
                  onConfirm={() => run('connectors.logout', { id: connection.id })}
                >
                  <Button variant="ghost">
                    <LogOut size={14} />
                    退出登录
                  </Button>
                </Confirm>
              )}
              <Confirm
                title={`删除 ${connection.name}？`}
                description="删除连接配置与应用保存的凭据。"
                actionLabel="删除连接器"
                onConfirm={() => run('connectors.delete', { id: connection.id })}
              >
                <Button variant="ghost" aria-label={`删除 ${connection.name}`}>
                  <Trash2 size={14} />
                </Button>
              </Confirm>
            </div>
          </article>
        ))}
      </div>
      {!resource.loading && !resource.value?.length && (
        <p className="py-5 text-sm text-slate-500">
          添加服务提供的真实 MCP 或搜索地址，然后授权给需要的成员。
        </p>
      )}
      <ConnectorDraftsPanel mutate={mutate} />
      <ModalPresence show={!!editing}>
        {editing && (
          <ToolEditor
            tool={editing === 'new' ? undefined : editing}
            mutate={editorMutate}
            close={() => {
              setEditing(undefined);
              resource.reload();
            }}
          />
        )}
      </ModalPresence>
      <ModalPresence show={!!authorizing}>
        {authorizing && (
          <ConnectorAccess
            key={authorizing.id}
            connection={authorizing}
            data={data}
            save={(botIds) => run('connectors.setAccess', { id: authorizing.id, botIds })}
            close={() => setAuthorizing(undefined)}
          />
        )}
      </ModalPresence>
      <ModalPresence show={!!login}>
        {login && (
          <ConnectorLogin
            connection={login}
            login={(params) => run('connectors.login', { id: login.id, ...params })}
            close={() => setLogin(undefined)}
          />
        )}
      </ModalPresence>
    </section>
  );
}
function authLabel(connection: ConnectorView) {
  if (connection.authentication.phase === 'connected') return '已通过浏览器授权';
  if (connection.authentication.phase === 'awaiting_user') return '等待浏览器授权';
  if (connection.authentication.phase === 'authorizing') return '正在准备授权';
  if (connection.authentication.enabled) return '需要完成浏览器授权';
  return connection.authenticated ? '已配置凭据' : '按服务配置认证';
}
function ConnectorAccess({
  connection,
  data,
  save,
  close,
}: {
  connection: ConnectorView;
  data: Snapshot;
  save: (botIds: string[]) => Promise<void>;
  close: () => void;
}) {
  const [selected, setSelected] = useState(connection.authorizedBots.map((bot) => bot.id));
  const [busy, setBusy] = useState(false);
  return (
    <Modal open onOpenChange={(open) => !open && close()} title={`授权 ${connection.name}`}>
      <div className="grid gap-3">
        <p className="text-sm text-slate-500">
          成员仍需在工具权限中启用外部工具。连接授权单独保存。
        </p>
        {data.bots
          .filter((bot) => !bot.archived)
          .map((bot) => (
            <label key={bot.id} className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={selected.includes(bot.id)}
                onChange={(event) =>
                  setSelected((items) =>
                    event.target.checked ? [...items, bot.id] : items.filter((id) => id !== bot.id),
                  )
                }
              />
              {bot.name}
            </label>
          ))}
        <div className="flex justify-end gap-2">
          <Button onClick={close}>取消</Button>
          <Button
            variant="primary"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              void save(selected)
                .then(close)
                .finally(() => setBusy(false));
            }}
          >
            保存授权
          </Button>
        </div>
      </div>
    </Modal>
  );
}
function ConnectorLogin({
  connection,
  login,
  close,
}: {
  connection: ConnectorView;
  login: (params: Record<string, unknown>) => Promise<void>;
  close: () => void;
}) {
  const [clientId, setClientId] = useState('');
  const [issuer, setIssuer] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <Modal open onOpenChange={(open) => !open && close()} title={`登录 ${connection.name}`}>
      <div className="grid gap-4">
        <p className="text-sm leading-6 text-slate-500">
          将在系统浏览器中打开服务的授权页面，成功后自动回到连接器状态。支持标准 MCP OAuth 与 PKCE。
        </p>
        <details>
          <summary className="cursor-pointer text-sm text-slate-600">
            使用服务商预注册的客户端
          </summary>
          <div className="mt-3 grid gap-3">
            <Field label="Client ID">
              <input
                className={inputClass}
                value={clientId}
                onChange={(event) => setClientId(event.target.value)}
              />
            </Field>
            <Field label="授权服务器地址">
              <input
                type="url"
                className={inputClass}
                value={issuer}
                onChange={(event) => setIssuer(event.target.value)}
              />
            </Field>
            <p className="text-xs text-slate-500">
              服务商应允许本机 127.0.0.1 回调与动态端口。留空则使用服务提供的动态注册。
            </p>
          </div>
        </details>
        <div className="flex justify-end gap-2">
          <Button onClick={close}>取消</Button>
          <Button
            variant="primary"
            disabled={busy || (!!clientId && !issuer)}
            onClick={() => {
              setBusy(true);
              void login({
                clientId: clientId.trim() || undefined,
                issuer: issuer.trim() || undefined,
              })
                .then(close)
                .finally(() => setBusy(false));
            }}
          >
            打开浏览器授权
          </Button>
        </div>
      </div>
    </Modal>
  );
}
