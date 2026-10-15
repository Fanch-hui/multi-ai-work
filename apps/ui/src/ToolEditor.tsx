import { useState, type FormEvent } from "react";
import type { ToolConnection } from "../../../src/domain/types.js";
import type { Mutate } from "./store.js";
import { errorMessage } from "./api.js";
import { Button, ErrorNote, Field, Modal, inputClass } from "./components.js";
export function ToolEditor({ tool, mutate, close }: { tool?: ToolConnection; mutate: Mutate; close: () => void }) {
  const [name, setName] = useState(tool?.name || "");
  const [kind, setKind] = useState<ToolConnection["kind"]>(tool?.kind || "mcp");
  const [searchBackend, setSearchBackend] = useState(tool?.searchBackend || (tool?.kind === "search" ? "http" : ""));
  const [transport, setTransport] = useState(tool?.transport || "http");
  const [url, setUrl] = useState(tool?.url || "");
  const [command, setCommand] = useState(tool?.command || "");
  const [args, setArgs] = useState((tool?.args || []).join("\n"));
  const [secret, setSecret] = useState("");
  const [enabled, setEnabled] = useState(tool?.enabled ?? true);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function save(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await mutate("tools.save", {
        input: {
          ...tool,
          name,
          kind,
          searchBackend: kind === "search" ? "http" : searchBackend || undefined,
          transport,
          url: transport === "http" ? url : undefined,
          command: transport === "stdio" ? command : undefined,
          args: transport === "stdio" ? args.split("\n").filter(Boolean) : undefined,
          enabled,
          secret: secret || undefined,
        },
      });
      close();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal open onOpenChange={(open) => !open && close()} title={tool ? "编辑工具连接" : "添加工具连接"}>
      <form className="grid gap-4" onSubmit={(event) => void save(event)}>
        <Field label="名称">
          <input className={inputClass} required value={name} onChange={(event) => setName(event.target.value)} />
        </Field>
        <div className="grid grid-cols-2 gap-4">
          <Field label="类型">
            <select
              className={inputClass}
              value={kind === "bridge" ? "mcp" : kind}
              onChange={(event) => {
                const value = event.target.value as typeof kind;
                setKind(value); setSearchBackend(value === "search" ? "http" : "");
                if (value === "search") setTransport("http");
              }}
            >
              <option value="mcp">MCP</option>
              <option value="search">搜索</option>
            </select>
          </Field>
          <Field label="传输">
            <select
              className={inputClass}
              value={transport}
              disabled={kind === "search"}
              onChange={(event) => setTransport(event.target.value as typeof transport)}
            >
              <option value="http">HTTP</option>
              <option value="stdio">stdio</option>
            </select>
          </Field>
        </div>
        {kind !== "search" && <Field label="搜索适配" hint="Tavily 也会在检测到 tavily-search 工具后自动识别。">
          <select className={inputClass} value={searchBackend} onChange={event => setSearchBackend(event.target.value as typeof searchBackend)}>
            <option value="">自动识别</option>
            <option value="tavily">Tavily MCP</option>
          </select>
        </Field>}
        {kind === "search" && <p className="text-xs leading-5 text-slate-500">HTTP 搜索服务使用 GET 请求，并通过 q 参数传递查询。Tavily 地址请选择 MCP 类型。</p>}
        {transport === "http" ? (
          <>
            <Field label="服务地址">
              <input
                type="url"
                required
                className={inputClass}
                value={url}
                onChange={(event) => setUrl(event.target.value)}
                placeholder={kind === "search" ? "https://example.com/search" : "https://example.com/mcp"}
              />
            </Field>
            <Field label="Bearer 凭据" hint={tool?.secretRef ? "留空保留已保存凭据。" : undefined}>
              <input
                type="password"
                autoComplete="new-password"
                className={inputClass}
                value={secret}
                onChange={(event) => setSecret(event.target.value)}
              />
            </Field>
          </>
        ) : (
          <>
            <Field label="启动程序">
              <input
                required
                className={inputClass}
                value={command}
                onChange={(event) => setCommand(event.target.value)}
                placeholder="/绝对路径/可执行程序"
              />
            </Field>
            <Field label="参数" hint="每行一个参数。">
              <textarea
                className={inputClass}
                rows={4}
                value={args}
                onChange={(event) => setArgs(event.target.value)}
              />
            </Field>
          </>
        )}
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} />
          启用工具连接
        </label>
        <ErrorNote error={error} />
        <div className="flex justify-end gap-2">
          <Button type="button" onClick={close}>
            取消
          </Button>
          <Button variant="primary" disabled={busy}>
            {busy ? "保存中…" : "保存"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
