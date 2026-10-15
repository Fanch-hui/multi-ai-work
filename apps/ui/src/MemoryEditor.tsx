import { useState, type FormEvent } from "react";
import type { MemoryEntry, Snapshot } from "../../../src/domain/types.js";
import type { Mutate } from "./store.js";
import { errorMessage } from "./api.js";
import { Button, ErrorNote, Field, Modal, inputClass } from "./components.js";
export function MemoryEditor({ memory, target, data, mutate, close }: {
  memory?: MemoryEntry; target?: Pick<MemoryEntry, "scope" | "ownerId">;
  data: Snapshot; mutate: Mutate; close: () => void;
}) {
  const [content, setContent] = useState(memory?.content || "");
  const [scope, setScope] = useState<MemoryEntry["scope"]>(memory?.scope || target?.scope || "bot");
  const [ownerId, setOwner] = useState(memory?.ownerId || target?.ownerId || data.settings.mainBotId || "");
  const [allowed, setAllowed] = useState<string[]>((memory?.scope === "team" ? [memory.ownerId] : memory?.allowedConversationIds || [])
    .filter((id) => data.conversations.some((room) => room.id === id)));
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function save(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await mutate("memories.save", {
        id: memory?.id,
        content,
        scope,
        ownerId: scope === "team" ? allowed[0] || "" : scope === "shared"
          ? memory?.scope === "shared" ? memory.ownerId : "shared" : ownerId,
        allowedConversationIds: allowed,
        sourceIds: memory?.sourceIds || [],
      });
      close();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      open
      onOpenChange={(open) => !open && close()}
      title={memory ? "编辑记忆" : "添加记忆"}
    >
      <form className="grid gap-4" onSubmit={(event) => void save(event)}>
        <Field label="内容">
          <textarea
            rows={5}
            required
            className={inputClass}
            value={content}
            onChange={(event) => setContent(event.target.value)}
            placeholder="保存稳定的偏好、约定和已确认事实"
          />
        </Field>
        <Field label="使用范围">
          <select
            className={inputClass}
            value={scope}
            disabled={target?.scope === "bot"}
            onChange={(event) => {
              setScope(event.target.value as typeof scope);
              setAllowed([]);
            }}
          >
            {target?.scope !== "shared" && <option value="bot">成员专用</option>}
            {target?.scope !== "bot" && <option value="team">团队会话</option>}
            {target?.scope !== "bot" && <option value="shared">共享资料</option>}
          </select>
        </Field>
        {scope === "bot" && (
          <Field label="所属成员">
            <select required className={inputClass} value={ownerId} disabled={target?.scope === "bot"}
              onChange={(event) => setOwner(event.target.value)}>
              <option value="">选择成员</option>
              {data.bots
                .filter((item) => !item.archived || item.id === ownerId)
                .map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
            </select>
          </Field>
        )}
        <fieldset>
          <legend className="mb-2 text-sm font-medium text-slate-700">
            {scope === "team" ? "所属团队会话" : "授权会话"}
          </legend>
          <div className="grid max-h-40 gap-2 overflow-auto rounded-lg border border-slate-200 p-3">
            {data.conversations
              .filter((item) => (!item.archived || allowed.includes(item.id)) && (scope !== "team" || item.kind === "group"))
              .map((item) => (
                <label key={item.id} className="flex items-center gap-2 text-sm text-slate-600">
                  <input
                    type={scope === "team" ? "radio" : "checkbox"}
                    name="memory-conversation"
                    checked={allowed.includes(item.id)}
                    onChange={() =>
                      setAllowed(
                        scope === "team"
                          ? [item.id]
                          : allowed.includes(item.id)
                            ? allowed.filter((value) => value !== item.id)
                            : [...allowed, item.id],
                      )
                    }
                  />
                  {item.name}
                </label>
              ))}
            {!data.conversations.some((item) => (!item.archived || allowed.includes(item.id)) && (scope !== "team" || item.kind === "group")) &&
              <p className="text-sm text-slate-500">创建会话后可设置使用范围。</p>}
          </div>
        </fieldset>
        <ErrorNote error={error} />
        <div className="flex justify-end gap-2">
          <Button type="button" onClick={close}>
            取消
          </Button>
          <Button variant="primary" disabled={busy || (scope === "team" && !allowed.length)}>
            {busy ? "保存中…" : "保存记忆"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
