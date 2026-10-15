import { useState, type FormEvent } from "react";
import type { Snapshot } from "../../../src/domain/types.js";
import type { Mutate } from "./store.js";
import { errorMessage } from "./api.js";
import { Button, ErrorNote, Field, Modal, inputClass } from "./components.js";
import Avatar from "./Avatar.js";
export function ConversationEditor({
  data,
  mutate,
  close,
  created,
  configure,
}: {
  data: Snapshot;
  mutate: Mutate;
  close: () => void;
  created: (id: string) => void;
  configure: () => void;
}) {
  const [kind, setKind] = useState<"private" | "group">("group");
  const [name, setName] = useState("");
  const [members, setMembers] = useState<string[]>(data.settings.mainBotId ? [data.settings.mainBotId] : []);
  const [chief, setChief] = useState(data.settings.mainBotId || "");
  const [workspace, setWorkspace] = useState(data.workspaces[0]?.id || "");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const bots = data.bots.filter((item) => !item.archived);
  function toggle(id: string) {
    const next =
      kind === "private" ? [id] : members.includes(id) ? members.filter((item) => item !== id) : [...members, id];
    setMembers(next);
    if (!next.includes(chief)) setChief(next[0] || "");
  }
  async function save(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const result = await mutate<{ id: string }>("conversations.create", {
        name: name || (kind === "private" ? bots.find((item) => item.id === members[0])?.name : "团队会话"),
        kind,
        memberIds: members,
        chiefId: kind === "group" ? chief || members[0] : undefined,
        workspaceId: workspace,
      });
      created(result.id);
      close();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal open onOpenChange={(open) => !open && close()} title="新建会话">
      <form className="grid gap-4" onSubmit={(event) => void save(event)}>
        <div className="grid grid-cols-2 gap-2">
          <Button
            type="button"
            variant={kind === "group" ? "primary" : "default"}
            onClick={() => {
              setKind("group");
              setMembers(data.settings.mainBotId ? [data.settings.mainBotId] : []);
              setChief(data.settings.mainBotId || "");
            }}
          >
            团队群聊
          </Button>
          <Button
            type="button"
            variant={kind === "private" ? "primary" : "default"}
            onClick={() => {
              setKind("private");
              setMembers([]);
              setChief("");
            }}
          >
            成员私聊
          </Button>
        </div>
        <Field label="会话名称">
          <input
            className={inputClass}
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder={kind === "group" ? "例如：新产品研究" : "留空使用成员名称"}
          />
        </Field>
        <fieldset>
          <legend className="mb-2 text-sm font-medium text-slate-700">
            {kind === "group" ? "选择团队成员" : "选择智能体"}
          </legend>
          <div className="grid max-h-48 gap-2 overflow-auto rounded-lg border border-slate-200 p-3">
            {bots.map((bot) => (
              <label key={bot.id} className="flex items-center gap-3 rounded-lg p-1.5 text-sm">
                <input
                  type={kind === "private" ? "radio" : "checkbox"}
                  name="conversation-member"
                  checked={members.includes(bot.id)}
                  onChange={() => toggle(bot.id)}
                />
                <Avatar bot={bot} className="size-9" />
                <div>
                  <p className="font-medium">{bot.name}</p>
                  {bot.id !== data.settings.mainBotId && <p className="mt-0.5 text-xs text-slate-500">{bot.role}</p>}
                </div>
              </label>
            ))}
            {!bots.length && <p className="text-sm text-slate-500">请先创建智能体。</p>}
          </div>
        </fieldset>
        {kind === "group" && members.length > 0 && (
          <Field label="Chief · 负责分工和汇总">
            <select className={inputClass} value={chief} onChange={(event) => setChief(event.target.value)}>
              {bots
                .filter((item) => members.includes(item.id))
                .map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
            </select>
          </Field>
        )}
        <Field label="工作目录">
          <select
            required
            className={inputClass}
            value={workspace}
            onChange={(event) => setWorkspace(event.target.value)}
          >
            <option value="">选择授权目录</option>
            {data.workspaces.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </select>
        </Field>
        {!data.workspaces.length && (
          <Button
            type="button"
            onClick={() => {
              close();
              configure();
            }}
          >
            前往设置添加工作目录
          </Button>
        )}
        <ErrorNote error={error} />
        <div className="flex justify-end gap-2">
          <Button type="button" onClick={close}>
            取消
          </Button>
          <Button variant="primary" disabled={busy || !members.length || !workspace}>
            {busy ? "创建中…" : "创建会话"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
