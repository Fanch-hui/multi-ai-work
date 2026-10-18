import { useState } from 'react';
import { CheckSquare, Trash2 } from 'lucide-react';
import type { Mutate } from './store.js';
import { Button, Confirm } from './components.js';

export function useArtifactSelection(ids: string[], mutate: Mutate) {
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const visible = new Set(ids);
  const checked = new Set(selected.filter(id => visible.has(id)));
  const toggle = (id: string) => setSelected(current => current.includes(id) ? current.filter(value => value !== id) : [...current, id]);
  const cancel = () => { setSelecting(false); setSelected([]); };
  async function remove() {
    const pending = [...checked];
    if (!pending.length) return;
    setBusy(true);
    try {
      for (const id of pending) {
        await mutate('artifacts.delete', { id });
        setSelected(current => current.filter(value => value !== id));
      }
      cancel();
    } finally { setBusy(false); }
  }
  const toolbar = <div className="flex min-h-8 flex-wrap items-center justify-end gap-2">
    {selecting ? <>
      <label className="mr-auto flex items-center gap-2 text-sm text-slate-600">
        <input type="checkbox" disabled={busy || !ids.length} checked={ids.length > 0 && checked.size === ids.length}
          ref={element => { if (element) element.indeterminate = checked.size > 0 && checked.size < ids.length; }}
          onChange={event => setSelected(event.target.checked ? ids : [])} />
        全选<span className="text-xs text-slate-400">已选 {checked.size} 项</span>
      </label>
      <Button variant="ghost" disabled={busy} onClick={cancel}>取消</Button>
      <Confirm title={`删除选中的 ${checked.size} 个成果？`} actionLabel="批量删除" onConfirm={remove}
        description="删除所选成果记录及 App 保存的文件副本，工作区原文件保留。如有历史版本，库中将显示上一版。">
        <Button variant="ghost" disabled={busy || checked.size === 0} className="text-red-600"><Trash2 size={15} />批量删除</Button>
      </Confirm>
    </> : <Button variant="ghost" disabled={!ids.length} onClick={() => setSelecting(true)}><CheckSquare size={15} />选择</Button>}
  </div>;
  return { selecting, checked, toggle, busy, toolbar };
}
