import { useState } from 'react';
import type { Snapshot } from '../../../../src/domain/types.js';
import type {
  ComputerApp,
  ComputerCapabilities,
  ComputerSession,
  ComputerSettings,
} from '../../../../src/domain/computer.js';
import { Button, ErrorNote, Modal } from '../components.js';
import { errorMessage } from '../api.js';
import type { Mutate } from '../store.js';
import { useResource } from '../local-work/useResource.js';
export function ComputerPanel({
  data,
  mutate,
  close,
}: {
  data: Snapshot;
  mutate: Mutate;
  close(): void;
}) {
  const settings = useResource<ComputerSettings>('computer.settings');
  const capabilities = useResource<ComputerCapabilities>('computer.capabilities');
  const apps = useResource<{ apps: ComputerApp[] }>(
    'computer.apps',
    {},
    capabilities.value?.available === true,
  );
  const session = useResource<ComputerSession | null>('computer.session');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function run(method: string, params: Record<string, unknown>) {
    setBusy(true);
    setError('');
    try {
      await mutate(method, params);
      settings.reload();
      capabilities.reload();
      session.reload();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }
  const configured = settings.value ?? { enabled: false, grants: [] };
  return (
    <Modal
      open
      onOpenChange={(open) => {
        if (!open && !busy) close();
      }}
      title="电脑操作"
      wide
    >
      <p className="mb-4 text-sm leading-6 text-slate-500">
        成员操作你选择的本机应用。多个成员共用同一桌面，任务依次使用；登录和敏感输入由你接管完成。
      </p>
      <ErrorNote
        error={error || settings.error || capabilities.error || apps.error || session.error}
      />
      {capabilities.value?.guidance && (
        <p className="mb-3 text-sm text-amber-800">{capabilities.value.guidance}</p>
      )}
      <label className="flex items-center gap-2 text-sm font-medium">
        <input
          type="checkbox"
          checked={configured.enabled}
          disabled={busy || !capabilities.value?.available}
          onChange={(event) =>
            void run('computer.configure', {
              input: { ...configured, enabled: event.target.checked },
            })
          }
        />
        启用电脑操作
      </label>
      {capabilities.value?.available && (
        <div className="my-4 flex flex-wrap gap-2">
          <Button
            disabled={busy}
            onClick={() => void run('computer.permissions', { permission: 'accessibility' })}
          >
            {capabilities.value.accessibility ? '辅助功能已允许' : '前往允许辅助功能'}
          </Button>
          <Button
            disabled={busy}
            onClick={() => void run('computer.permissions', { permission: 'screenCapture' })}
          >
            {capabilities.value.screenCapture ? '窗口截图已允许' : '前往允许窗口截图'}
          </Button>
          <Button
            disabled={busy}
            onClick={() => {
              apps.reload();
              capabilities.reload();
            }}
          >
            刷新
          </Button>
        </div>
      )}
      {session.value && (
        <section className="my-4 rounded-lg border border-blue-200 bg-blue-50 p-3 text-sm">
          <p>
            {data.bots.find((bot) => bot.id === session.value?.botId)?.name ?? '成员'} 正在使用{' '}
            {session.value.bundleId} ·{' '}
            {session.value.status === 'handoff' ? '由你接管' : '自动工作'}
          </p>
          <Button
            disabled={busy}
            onClick={() =>
              void run(
                session.value?.status === 'handoff' ? 'computer.resume' : 'computer.takeover',
                {},
              )
            }
          >
            {session.value.status === 'handoff' ? '交回并继续' : '接管电脑'}
          </Button>
        </section>
      )}
      <div className="mt-4 max-h-[50vh] space-y-4 overflow-y-auto">
        {apps.value?.apps.map((app) => {
          const grant = configured.grants.find((item) => item.bundleId === app.bundleId);
          return (
            <fieldset key={app.bundleId} className="rounded-lg border border-slate-200 p-3">
              <legend className="px-1 text-sm font-medium">{app.name}</legend>
              <div className="flex flex-wrap gap-3">
                {data.bots
                  .filter((bot) => !bot.archived)
                  .map((bot) => (
                    <label key={bot.id} className="flex items-center gap-2 text-sm text-slate-600">
                      <input
                        type="checkbox"
                        checked={grant?.allowedBotIds.includes(bot.id) ?? false}
                        disabled={busy}
                        onChange={(event) => {
                          const allowedBotIds = event.target.checked
                            ? [...(grant?.allowedBotIds ?? []), bot.id]
                            : (grant?.allowedBotIds ?? []).filter((id) => id !== bot.id);
                          void run('computer.configure', {
                            input: {
                              ...configured,
                              grants: [
                                ...configured.grants.filter(
                                  (item) => item.bundleId !== app.bundleId,
                                ),
                                { bundleId: app.bundleId, name: app.name, allowedBotIds },
                              ],
                            },
                          });
                        }}
                      />
                      {bot.name}
                    </label>
                  ))}
              </div>
            </fieldset>
          );
        })}
      </div>
      <p className="mt-4 text-xs text-slate-500">
        成员还需具备电脑工具权限。窗口截图需 macOS 14；系统权限变更后可退出并重新打开 App。
      </p>
    </Modal>
  );
}
