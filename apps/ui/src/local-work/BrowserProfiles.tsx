import { useRef, useState, type FormEvent } from 'react';
import type { BrowserProfile, BrowserSession } from '../../../../src/domain/work-browser.js';
import type { Snapshot } from '../../../../src/domain/types.js';
import type { Mutate } from '../store.js';
import { errorMessage } from '../api.js';
import { Button, ErrorNote, Field, inputClass, Modal } from '../components.js';
import { useResource } from './useResource.js';
import { WorkBrowser } from './WorkBrowser.js';

export function BrowserProfiles({
  data,
  mutate,
  close,
}: {
  data: Snapshot;
  mutate: Mutate;
  close: () => void;
}) {
  const profiles = useResource<BrowserProfile[]>('browser.profiles');
  const capability = useResource<{ available: boolean }>('browser.available');
  const [editing, setEditing] = useState<BrowserProfile | 'new'>();
  const [preview, setPreview] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const opening = useRef(false);
  async function open(profile: BrowserProfile) {
    if (opening.current) return;
    opening.current = true;
    setBusy(true);
    setError('');
    try {
      const session = await mutate<BrowserSession>('browser.profileOpen', {
        profileId: profile.id,
      });
      setPreview(session.id);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      opening.current = false;
      setBusy(false);
    }
  }
  if (preview)
    return (
      <div className="fixed inset-y-0 right-0 z-30 flex w-[min(90vw,900px)] border-l border-slate-200 bg-white shadow-xl [&>aside]:w-full [&>aside]:max-w-none">
        <WorkBrowser initialSessionId={preview} mutate={mutate} close={() => setPreview('')} />
      </div>
    );
  return (
    <>
      <Modal
        open
        onOpenChange={(value) => {
          if (!value && !busy) close();
        }}
        title="工作浏览器配置"
        wide
      >
        <p className="mb-4 text-sm leading-6 text-slate-500">
          每个配置独立保存网站登录状态。选择允许使用的成员后，由用户在浏览器中完成登录。
        </p>
        <ErrorNote error={profiles.error || capability.error || error} />
        {capability.value?.available === false && (
          <p className="mb-3 rounded-lg bg-amber-50 p-3 text-sm text-amber-800">
            工作浏览器在桌面 App 中可用。
          </p>
        )}
        <Button onClick={() => setEditing('new')}>新建浏览器配置</Button>
        <div className="mt-4 space-y-3">
          {profiles.value?.map((profile) => (
            <article key={profile.id} className="rounded-xl border border-slate-200 p-4">
              <h3 className="text-sm font-semibold">{profile.name}</h3>
              <p className="my-2 text-xs text-slate-500">
                已授权：
                {profile.allowedBotIds
                  .map((id) => data.bots.find((bot) => bot.id === id)?.name ?? '已失效成员')
                  .join('、') || '尚未授权成员'}
              </p>
              <div className="flex gap-2">
                <Button onClick={() => setEditing(profile)}>编辑授权</Button>
                <Button
                  disabled={busy || !capability.value?.available}
                  onClick={() => void open(profile)}
                >
                  {busy ? '打开中…' : '打开并登录'}
                </Button>
              </div>
            </article>
          ))}
        </div>
        {profiles.loading && !profiles.value && (
          <p role="status" className="mt-4 text-sm text-slate-500">
            读取配置…
          </p>
        )}
      </Modal>
      {editing && (
        <ProfileEditor
          key={editing === 'new' ? 'new' : editing.id}
          profile={editing === 'new' ? undefined : editing}
          data={data}
          mutate={mutate}
          close={() => setEditing(undefined)}
          saved={profiles.reload}
        />
      )}
    </>
  );
}
function ProfileEditor({
  profile,
  data,
  mutate,
  close,
  saved,
}: {
  profile?: BrowserProfile;
  data: Snapshot;
  mutate: Mutate;
  close: () => void;
  saved: () => void;
}) {
  const [name, setName] = useState(profile?.name ?? '');
  const [allowedBotIds, setAllowedBotIds] = useState(profile?.allowedBotIds ?? []);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const submitting = useRef(false);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (submitting.current) return;
    submitting.current = true;
    setBusy(true);
    setError('');
    try {
      await mutate('browser.saveProfile', { input: { id: profile?.id, name, allowedBotIds } });
      saved();
      close();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }
  return (
    <Modal
      open
      onOpenChange={(open) => {
        if (!open && !busy) close();
      }}
      title={profile ? '编辑浏览器配置' : '新建浏览器配置'}
    >
      <form onSubmit={(event) => void submit(event)} className="space-y-4">
        <Field label="配置名称">
          <input
            required
            value={name}
            onChange={(event) => setName(event.target.value)}
            className={inputClass}
            placeholder="例如：工作账号"
          />
        </Field>
        <fieldset>
          <legend className="mb-2 text-sm font-medium text-slate-700">允许使用的成员</legend>
          <div className="max-h-60 space-y-2 overflow-y-auto">
            {data.bots
              .filter((bot) => !bot.archived || allowedBotIds.includes(bot.id))
              .map((bot) => (
                <label key={bot.id} className="flex items-center gap-2 text-sm text-slate-600">
                  <input
                    type="checkbox"
                    checked={allowedBotIds.includes(bot.id)}
                    onChange={(event) =>
                      setAllowedBotIds(
                        event.target.checked
                          ? [...allowedBotIds, bot.id]
                          : allowedBotIds.filter((id) => id !== bot.id),
                      )
                    }
                  />
                  {bot.name}
                </label>
              ))}
          </div>
        </fieldset>
        <p className="text-xs leading-5 text-slate-500">
          成员还需具备浏览器工具权限。网站账号状态仅保存在本机浏览器配置中。
        </p>
        <ErrorNote error={error} />
        <div className="flex justify-end">
          <Button type="submit" variant="primary" disabled={busy}>
            {busy ? '保存中…' : '保存'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
