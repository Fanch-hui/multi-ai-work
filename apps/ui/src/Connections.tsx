import { ModalPresence } from "./ModalPresence.js";
import { ConnectionEditor } from "./ConnectionEditor.js";
import { useState } from "react";
import { Plus, Cable, Pencil, Play, LogOut, Trash2 } from "lucide-react";
import type { Connection, ProviderKind, Snapshot } from "../../../src/domain/types.js";
import type { Mutate } from "./store.js";
import { errorMessage } from "./api.js";
import { Badge, Button, Confirm, Empty, ErrorNote } from "./components.js";
const providerLabels: Record<ProviderKind, string> = {
  antigravity: "Antigravity CLI（agy）", chatgpt: "ChatGPT", qoder: "Qoder CN", custom: "自定义 API",
};
export function Connections({ data, mutate }: { data: Snapshot; mutate: Mutate }) {
  const [editing, setEditing] = useState<Connection | "new">();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  async function check(id: string) {
    setError(""); setBusy(id);
    try { await mutate("connections.probe", { id }); }
    catch (cause) { setError(errorMessage(cause)); }
    finally { setBusy(""); }
  }
  return (
    <section>
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-balance text-base font-semibold text-slate-900">模型供应</h2>
          <p className="mt-1 text-pretty text-sm text-slate-500">连接账号后，为每位智能体选择模型。</p>
        </div>
        <Button variant="primary" onClick={() => setEditing("new")}><Plus size={16} />添加连接</Button>
      </div>
      <ErrorNote error={error} />
      {data.connections.length ? (
        <div className="mt-4 grid gap-4 xl:grid-cols-2">
          {data.connections.map((item) => (
            <article key={item.id} className="min-w-0 rounded-xl border border-black/8 bg-white p-5">
              <div className="flex items-start justify-between gap-3">
                <div className="flex min-w-0 items-center gap-3">
                  <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-slate-50 text-slate-500"><Cable size={20} /></div>
                  <div className="min-w-0">
                    <h3 className="truncate font-semibold">{item.name}</h3>
                    <p className="mt-1 text-xs text-slate-500">{providerLabels[item.provider]}</p>
                  </div>
                </div>
                <Badge status={item.status} />
              </div>
              {item.error && <p className="mt-3 text-pretty text-sm leading-6 text-red-700">{item.error}</p>}
              {item.status === "ready" && <p className="mt-4 text-xs text-slate-500">
                {item.models.length ? `${item.models.length} 个可用模型` : "支持手动填写模型 ID"}
                {item.version && ` · ${item.version}`}
              </p>}
              {item.capabilities && <details className="mt-3 text-xs text-slate-500">
                <summary className="cursor-pointer">连接能力</summary>
                <dl className="mt-3 grid grid-cols-2 gap-2 rounded-lg bg-slate-50 p-3">
                  <dt>上下文管理</dt><dd>{item.capabilities.contextOwner === "native" ? "原生运行时" : "App"}</dd>
                  <dt>工具调用</dt><dd>{capabilityLabel(item.capabilities.tools)}</dd>
                  <dt>会话续接</dt><dd>{capabilityLabel(item.capabilities.resume)}</dd>
                  <dt>权限管理</dt><dd>{permissionLabel(item.capabilities.permissionEnforcement)}</dd>
                </dl>
              </details>}
              <div className="mt-4 flex flex-wrap gap-2 border-t border-black/5 pt-4">
                {item.status === "ready" || (item.provider === "chatgpt" && item.secretRef && item.status !== "needs_auth") ? <Button disabled={!!busy} onClick={() => void check(item.id)}>
                  <Play size={14} />{busy === item.id ? "检测中…" : "检测连接"}
                </Button> : <Button variant="primary" onClick={() => setEditing(item)}>完成连接</Button>}
                <Button variant="ghost" onClick={() => setEditing(item)}><Pencil size={14} />配置</Button>
                {item.status === "ready" && item.provider === "chatgpt" && <Confirm
                  title={`退出 ${item.name}？`} description="清除本应用保存的登录凭据，连接需要重新授权。"
                  actionLabel="退出登录" onConfirm={() => mutate("connections.logout", { id: item.id })}>
                  <Button variant="ghost" aria-label={`退出 ${item.name}`}><LogOut size={14} /></Button>
                </Confirm>}
                <Confirm title={`删除 ${item.name}？`} description="删除此连接及其应用凭据。正在使用此连接的智能体需要重新配置。"
                  actionLabel="删除连接" onConfirm={() => mutate("connections.delete", { id: item.id })}>
                  <Button variant="ghost" className="ml-auto" aria-label={`删除 ${item.name}`}><Trash2 size={15} /></Button>
                </Confirm>
              </div>
            </article>
          ))}
        </div>
      ) : <Empty title="连接你的第一个模型" description="使用现有账号登录，或接入兼容的 API 服务。"
        action={<Button variant="primary" onClick={() => setEditing("new")}><Plus size={16} />添加连接</Button>} />}
      <ModalPresence show={!!editing}>{editing && <ConnectionEditor key={typeof editing === "string" ? "new" : editing.id}
        connection={editing === "new" ? undefined : editing} connections={data.connections}
        mutate={mutate} close={() => setEditing(undefined)} />}</ModalPresence>
    </section>
  );
}
function capabilityLabel(value: string) {
  return value === "supported" ? "支持" : value === "unsupported" ? "不支持" : "待验证";
}
function permissionLabel(value: string) {
  if (value === "native-cli") return "原生 CLI；团队由 App";
  if (value === "gateway") return "App 工具授权";
  if (value === "native-hooks") return "原生权限钩子";
  if (value === "mixed") return "App 与原生运行时";
  return "尚未验证";
}
