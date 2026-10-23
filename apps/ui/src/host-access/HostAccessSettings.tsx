import { useState } from 'react';
import type {
  HostAccessStatus,
  HostDevice,
  HostDeviceScope,
  ResidentSettings,
} from '../../../../src/domain/host-access.js';
import type { Snapshot } from '../../../../src/domain/types.js';
import type { Mutate } from '../store.js';
import { Button, ErrorNote } from '../components.js';
import { errorMessage } from '../api.js';
import { useResource } from '../local-work/useResource.js';

const scopes: { value: HostDeviceScope; label: string }[] = [
  { value: 'read', label: '查看消息与任务' },
  { value: 'send', label: '发送消息启动工作' },
  { value: 'stop', label: '停止会话任务' },
];
export function HostAccessSettings({ data, mutate }: { data: Snapshot; mutate: Mutate }) {
  const status = useResource<HostAccessStatus>('hostAccess.status');
  const resident = useResource<ResidentSettings>('hostAccess.resident.get');
  const devices = useResource<HostDevice[]>('hostAccess.devices');
  const [selected, setSelected] = useState<string[]>([]);
  const [grants, setGrants] = useState<HostDeviceScope[]>(['read']);
  const [pairing, setPairing] = useState<{ code: string; expiresAt: string }>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function act(action: () => Promise<unknown>) {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await action();
      status.reload();
      resident.reload();
      devices.reload();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="space-y-5">
      <h2 className="text-base font-semibold text-slate-800">桌面常驻与设备接入</h2>
      <ErrorNote error={error || status.error || resident.error || devices.error} />
      {resident.value?.available && (
        <fieldset disabled={busy} className="space-y-3 rounded-xl border border-slate-200 p-4">
          <legend className="px-1 text-sm font-medium">常驻工作</legend>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={resident.value.openAtLogin}
              onChange={(event) => {
                const value = event.target.checked;
                void act(() =>
                  mutate('hostAccess.resident.set', {
                    openAtLogin: value,
                    keepAwake: resident.value!.keepAwake,
                  }),
                );
              }}
            />
            登录电脑时启动 App
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={resident.value.keepAwake}
              onChange={(event) => {
                const value = event.target.checked;
                void act(() =>
                  mutate('hostAccess.resident.set', {
                    openAtLogin: resident.value!.openAtLogin,
                    keepAwake: value,
                  }),
                );
              }}
            />
            App 运行时保持电脑唤醒
          </label>
          <p className="text-xs leading-5 text-slate-500">
            关闭窗口后可继续通过托盘运行。保持唤醒会增加电脑耗电，退出 App 后结束。
          </p>
        </fieldset>
      )}
      <div className="space-y-3 rounded-xl border border-slate-200 p-4">
        <div className="flex items-center justify-between gap-3">
          <h3 className="text-sm font-medium">本机宿主接口</h3>
          <Button
            disabled={busy || !status.value}
            onClick={() =>
              void act(async () => {
                await mutate('hostAccess.configure', { enabled: !status.value?.enabled });
                setPairing(undefined);
              })
            }
          >
            {status.value?.enabled ? '关闭接口' : '启用接口'}
          </Button>
        </div>
        <p className="text-xs leading-5 text-slate-500">
          供后续手机端和安全隧道连接使用。接口仅监听本机 127.0.0.1，每次启动 App
          后由你启用；设备只能访问配对时选定的会话。
        </p>
        {status.value?.url && (
          <p className="break-all rounded-lg bg-slate-50 p-3 font-mono text-xs">
            {status.value.url}
          </p>
        )}
        {status.value?.enabled && (
          <fieldset disabled={busy} className="space-y-3">
            <legend className="mb-2 text-sm font-medium">配对授权</legend>
            <div className="max-h-44 space-y-2 overflow-y-auto rounded-lg border border-slate-200 p-3">
              {data.conversations
                .filter((room) => !room.archived)
                .map((room) => (
                  <label key={room.id} className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={selected.includes(room.id)}
                      onChange={(event) =>
                        setSelected((current) =>
                          event.target.checked
                            ? [...current, room.id]
                            : current.filter((id) => id !== room.id),
                        )
                      }
                    />
                    {room.name}
                  </label>
                ))}
            </div>
            <div className="flex flex-wrap gap-3">
              {scopes.map((scope) => (
                <label key={scope.value} className="flex items-center gap-2 text-xs">
                  <input
                    type="checkbox"
                    checked={grants.includes(scope.value)}
                    onChange={(event) =>
                      setGrants((current) =>
                        event.target.checked
                          ? [...current, scope.value]
                          : current.filter((value) => value !== scope.value),
                      )
                    }
                  />
                  {scope.label}
                </label>
              ))}
            </div>
            <Button
              disabled={busy || !selected.length || !grants.length}
              onClick={() =>
                void act(async () => {
                  setPairing(
                    await mutate('hostAccess.pairing', {
                      scopes: grants,
                      conversationIds: selected,
                    }),
                  );
                })
              }
            >
              生成一次性配对码
            </Button>
            {pairing && (
              <div role="status" className="space-y-1 rounded-lg bg-blue-50 p-3">
                <p className="select-all break-all font-mono text-sm text-blue-900">
                  {pairing.code}
                </p>
                <p className="text-xs text-blue-700">
                  有效至 {new Date(pairing.expiresAt).toLocaleTimeString()}，使用一次后失效。
                </p>
              </div>
            )}
          </fieldset>
        )}
      </div>
      <div className="space-y-3">
        <h3 className="text-sm font-medium">已配对设备</h3>
        {!devices.value?.length && <p className="text-sm text-slate-500">尚未配对设备</p>}
        {devices.value?.map((device) => (
          <article
            key={device.id}
            className="flex items-center justify-between gap-3 rounded-xl border border-slate-200 p-3"
          >
            <div className="min-w-0 text-sm">
              <p className="font-medium">
                {device.name}
                {device.revokedAt ? ' · 已撤销' : ''}
              </p>
              <p className="mt-1 text-xs text-slate-500">
                {device.conversationIds.length} 个会话 ·{' '}
                {scopes
                  .filter((scope) => device.scopes.includes(scope.value))
                  .map((scope) => scope.label)
                  .join('、')}
              </p>
            </div>
            {!device.revokedAt && (
              <Button
                disabled={busy}
                onClick={() => void act(() => mutate('hostAccess.revoke', { id: device.id }))}
              >
                撤销访问
              </Button>
            )}
          </article>
        ))}
      </div>
    </section>
  );
}
