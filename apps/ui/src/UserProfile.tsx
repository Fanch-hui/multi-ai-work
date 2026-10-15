import { useState, type FormEvent } from 'react';
import type { Snapshot } from '../../../src/domain/types.js';
import type { Mutate } from './store.js';
import { errorMessage } from './api.js';
import { AvatarPicker } from './AvatarPicker.js';
import { Button, ErrorNote } from './components.js';

export function UserProfile({ data, mutate }: { data: Snapshot; mutate: Mutate }) {
  const [avatar, setAvatar] = useState(data.settings.userAvatar ?? 'cat');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  async function save(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError(''); setSaved(false);
    try { await mutate('settings.save', { input: { userAvatar: avatar } }); setSaved(true); }
    catch (cause) { setError(errorMessage(cause)); }
    finally { setBusy(false); }
  }
  return <section>
    <h2 className="mb-5 text-balance text-base font-semibold">个人头像</h2>
    <form className="grid gap-4 rounded-xl border border-slate-200 bg-white p-5" onSubmit={event => void save(event)}>
      <AvatarPicker value={avatar} onChange={value => { setAvatar(value); setSaved(false); }} mutate={mutate} />
      <ErrorNote error={error} />
      <div className="flex items-center justify-end gap-3">
        {saved && <span role="status" className="text-sm text-blue-700">头像已保存</span>}
        <Button variant="primary" disabled={busy}>{busy ? '保存中…' : '保存头像'}</Button>
      </div>
    </form>
  </section>;
}
