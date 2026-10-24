import { useState, type FormEvent } from 'react';
import { FolderOpen, Plus } from 'lucide-react';
import type { Snapshot, Workspace } from '../../../src/domain/types.js';
import type { Mutate } from './store.js';
import { choosePath, errorMessage } from './api.js';
import { Button, ErrorNote, Field, Modal, inputClass } from './components.js';
function workspaceAccess(workspace: Pick<Workspace, 'enabled' | 'writable'>) {
  if (workspace.enabled === false) return 'revoked';
  return workspace.writable ? 'write' : 'read';
}
const accessLabels = { write: '读写', read: '只读', revoked: '已撤销' };

export function Workspaces({ data, mutate }: { data: Snapshot; mutate: Mutate }) {
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<string>();
  const [enabled, setEnabled] = useState(true);
  function edit(workspace?: Workspace) {
    setEditing(workspace?.id);
    setPath(workspace?.path ?? '');
    setName(workspace?.name ?? '');
    setWritable(workspace?.writable ?? true);
    setEnabled(workspace?.enabled !== false);
    setError('');
    setOpen(true);
  }
  const [path, setPath] = useState('');
  const [name, setName] = useState('');
  const [writable, setWritable] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function browse() {
    try {
      const value = await choosePath('directory');
      if (value) setPath(value);
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }
  async function save(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      await mutate(
        editing ? 'workspaces.update' : 'workspaces.add',
        editing ? { id: editing, name, writable, enabled } : { name, path, writable },
      );
      setOpen(false);
      setName('');
      setPath('');
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section>
      <div className="mb-5 flex items-center justify-between">
        <div>
          <h2 className="text-balance text-base font-semibold">授权工作目录</h2>
        </div>
        <Button variant="primary" onClick={() => edit()}>
          <Plus size={16} />
          添加目录
        </Button>
      </div>
      <div className="grid gap-3">
        {data.workspaces.map((item) => (
          <div
            className="flex items-center gap-4 rounded-xl border border-slate-200 bg-white p-5"
            key={item.id}
          >
            <FolderOpen className="shrink-0 text-slate-400" size={22} />
            <div className="min-w-0 flex-1">
              <h3 className="text-sm font-semibold">{item.name}</h3>
              <p className="mt-1 truncate text-xs text-slate-500" title={item.path}>
                {item.path}
              </p>
            </div>
            <span className="rounded-md bg-slate-100 px-2 py-1 text-xs text-slate-600">
              {accessLabels[workspaceAccess(item)]}
            </span>
            <Button variant="ghost" onClick={() => edit(item)} aria-label={`管理目录 ${item.name}`}>
              管理
            </Button>
          </div>
        ))}
      </div>
      {!data.workspaces.length && (
        <div className="rounded-xl border border-dashed border-slate-300 p-8 text-center">
          <FolderOpen className="mx-auto mb-3 text-slate-400" size={24} />
          <p className="mb-4 text-sm text-slate-600">授权资料目录，让管家使用其中的文件。</p>
          <Button onClick={() => edit()}>添加目录</Button>
        </div>
      )}
      <Modal open={open} onOpenChange={setOpen} title={editing ? '管理工作目录' : '添加工作目录'}>
        <form className="grid gap-4" onSubmit={(event) => void save(event)}>
          <Field label="名称">
            <input
              required
              className={inputClass}
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="例如：研究资料"
            />
          </Field>
          <Field label="目录路径">
            <div className="flex gap-2">
              <input
                required
                disabled={!!editing}
                className={inputClass}
                value={path}
                onChange={(event) => setPath(event.target.value)}
                placeholder="/path/to/workspace"
              />
              {!editing && (
                <Button type="button" aria-label="选择工作目录" onClick={() => void browse()}>
                  <FolderOpen size={16} />
                </Button>
              )}
            </div>
          </Field>
          <Field label="访问权限">
            <select
              className={inputClass}
              aria-label="目录访问权限"
              disabled={editing === data.settings.defaultWorkspaceId}
              value={workspaceAccess({ enabled, writable })}
              onChange={(event) => {
                setEnabled(event.target.value !== 'revoked');
                setWritable(event.target.value === 'write');
              }}
            >
              <option value="write">读写</option>
              <option value="read">只读</option>
              {editing && <option value="revoked">已撤销</option>}
            </select>
          </Field>
          <ErrorNote error={error} />
          <div className="flex justify-end">
            <Button variant="primary" disabled={busy}>
              {busy ? '保存中…' : '保存'}
            </Button>
          </div>
        </form>
      </Modal>
    </section>
  );
}
