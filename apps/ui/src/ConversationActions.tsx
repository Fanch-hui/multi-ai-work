import { useState } from "react";
import { Archive, ArchiveRestore, Trash2 } from "lucide-react";
import type { Conversation } from "../../../src/domain/types.js";
import type { Mutate } from "./store.js";
import { errorMessage } from "./api.js";
import { Button, Confirm, ErrorNote, Field, inputClass, Modal } from "./components.js";

export function ConversationActions({ conversation, mutate, close, deleted }: {
  conversation: Conversation; mutate: Mutate; close: () => void; deleted?: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [name, setName] = useState(conversation.name);
  async function rename() {
    setBusy(true); setError("");
    try { await mutate("conversations.rename", { id: conversation.id, name: name.trim() }); close(); }
    catch (cause) { setError(errorMessage(cause)); }
    finally { setBusy(false); }
  }
  async function archive() {
    setBusy(true); setError("");
    try { await mutate("conversations.archive", { id: conversation.id, archived: !conversation.archived }); close(); }
    catch (cause) { setError(errorMessage(cause)); }
    finally { setBusy(false); }
  }
  return <Modal open title="管理会话" onOpenChange={(open) => !open && close()}>
    <div className="grid gap-3">
      <form className="grid gap-3 border-b border-black/5 pb-4" onSubmit={(event) => { event.preventDefault(); void rename(); }}>
        <Field label="会话名称"><input className={inputClass} value={name} maxLength={120} disabled={busy}
          onChange={(event) => setName(event.target.value)} /></Field>
        <div className="flex justify-end"><Button type="submit" variant="primary" disabled={busy || !name.trim() || name.trim() === conversation.name}>保存名称</Button></div>
      </form>
      <Button className="justify-start" disabled={busy} onClick={() => void archive()}>
        {conversation.archived ? <ArchiveRestore size={17} /> : <Archive size={17} />}{conversation.archived ? "恢复到会话列表" : "归档会话"}
      </Button>
      <Confirm title="删除这个会话？" description="聊天记录会永久删除，正在进行的工作会停止。已生成的成果仍保留在库中。" actionLabel="删除会话"
        onConfirm={async () => { await mutate("conversations.delete", { id: conversation.id }); deleted?.(); close(); }}>
        <Button className="justify-start text-red-600" disabled={busy}><Trash2 size={17} />删除会话</Button>
      </Confirm>
      <ErrorNote error={error} />
    </div>
  </Modal>;
}
