import { useState, type FormEvent } from "react";
import { FolderOpen, Plus } from "lucide-react";
import type { Snapshot } from "../../../src/domain/types.js";
import type { Mutate } from "./store.js";
import { choosePath, errorMessage } from "./api.js";
import { Button, ErrorNote, Field, Modal, inputClass } from "./components.js";
export function Workspaces({ data, mutate }: { data: Snapshot; mutate: Mutate }) {
  const [open, setOpen] = useState(false);
  const [path, setPath] = useState("");
  const [name, setName] = useState("");
  const [writable, setWritable] = useState(true);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function browse() {
    try {
      const value = await choosePath("directory");
      if (value) setPath(value);
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }
  async function save(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await mutate("workspaces.add", { name, path, writable });
      setOpen(false);
      setName("");
      setPath("");
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
          <p className="mt-1 text-sm text-slate-500">每个会话绑定一个目录，文件与成果保持可追溯。</p>
        </div>
        <Button variant="primary" onClick={() => setOpen(true)}>
          <Plus size={16} />
          添加目录
        </Button>
      </div>
      <div className="grid gap-3">
        {data.workspaces.map((item) => (
          <div className="flex items-center gap-4 rounded-xl border border-slate-200 bg-white p-5" key={item.id}>
            <FolderOpen className="shrink-0 text-slate-400" size={22} />
            <div className="min-w-0 flex-1">
              <h3 className="text-sm font-semibold">{item.name}</h3>
              <p className="mt-1 truncate text-xs text-slate-500" title={item.path}>
                {item.path}
              </p>
            </div>
            <span className="rounded-md bg-slate-100 px-2 py-1 text-xs text-slate-600">
              {item.writable ? "可创建成果" : "只读"}
            </span>
          </div>
        ))}
      </div>
      {!data.workspaces.length && (
        <div className="rounded-xl border border-dashed border-slate-300 p-8 text-center">
          <FolderOpen className="mx-auto mb-3 text-slate-400" size={24} />
          <p className="mb-4 text-sm text-slate-600">选择资料目录，开始你的第一个工作会话。</p>
          <Button onClick={() => setOpen(true)}>添加目录</Button>
        </div>
      )}
      <Modal open={open} onOpenChange={setOpen} title="添加工作目录">
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
                className={inputClass}
                value={path}
                onChange={(event) => setPath(event.target.value)}
                placeholder="/path/to/workspace"
              />
              <Button type="button" aria-label="选择工作目录" onClick={() => void browse()}>
                <FolderOpen size={16} />
              </Button>
            </div>
          </Field>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={writable} onChange={(event) => setWritable(event.target.checked)} />
            允许创建成果和更新本任务自产文件
          </label>
          <ErrorNote error={error} />
          <div className="flex justify-end">
            <Button variant="primary" disabled={busy}>
              {busy ? "添加中…" : "授权目录"}
            </Button>
          </div>
        </form>
      </Modal>
    </section>
  );
}
