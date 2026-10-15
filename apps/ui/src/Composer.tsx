import { ModalPresence } from "./ModalPresence.js";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { AtSign, ArrowUp, ChevronDown, X, Square, Paperclip } from "lucide-react";
import type { Conversation, Snapshot } from "../../../src/domain/types.js";
import type { Mutate } from "./store.js";
import { errorMessage } from "./api.js";
import { Button, Confirm, ErrorNote, activeTask } from "./components.js";
import { ConversationStats } from "./ConversationStats.js";
import { ChiefConversationEditor } from "./ChiefConversationEditor.js";
import { ImageAttachment, isImageAttachment } from "./ImageAttachment.js";
import { useAttachments } from "./useAttachments.js";
import { busyInputMembers } from "./task-input-feedback.js";
import { composerDrafts, composerSubmission, useComposerDraft } from "./composer-drafts.js";
import { modelLabel } from "./model-label.js";
export function Composer({
  data,
  conversation,
  mutate,
  configureChief,
}: {
  data: Snapshot;
  conversation: Conversation;
  mutate: Mutate;
  configureChief?: () => void;
}) {
  const { draft, setContent, setTargets } = useComposerDraft(conversation.id);
  const { content, targets, error, sending: busy } = draft;
  const [settingsOpen, setSettingsOpen] = useState(false);
  const { attachments, setAttachments, attaching, dragging, attach, onPaste, dragHandlers } = useAttachments(
    conversation.id, mutate,
  );
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const mentionRef = useRef<HTMLDetailsElement>(null);
  const currentConversation = useRef(conversation.id);
  currentConversation.current = conversation.id;
  const composing = useRef(false);
  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = "auto";
    textarea.style.height = `${Math.min(192, Math.max(64, textarea.scrollHeight))}px`;
  }, [conversation.id, content]);
  useEffect(() => {
    function dismissMentions(event: PointerEvent) {
      const menu = mentionRef.current;
      if (menu?.open && event.target instanceof Node && !menu.contains(event.target)) menu.open = false;
    }
    document.addEventListener("pointerdown", dismissMentions);
    return () => document.removeEventListener("pointerdown", dismissMentions);
  }, []);
  const main = conversation.purpose === "chief";
  const members = data.bots.filter((item) => conversation.memberIds.includes(item.id) && !item.archived);
  const bot = members.find((item) => item.id === conversation.chiefId) || members[0];
  const receivingMembers = !main && targets.length ? members.filter(member => targets.includes(member.id)) : members;
  const busyMembers = busyInputMembers(data, conversation, targets);
  const mixedTargets = busyMembers.length > 0 && busyMembers.length < receivingMembers.length;
  const model = (bot?.id === conversation.chiefId ? conversation.model : undefined) || bot?.model;
  const displayModel = modelLabel(data.connections.find(item => item.id === bot?.connectionId), model, "配置模型");
  const reasoning = bot?.id === conversation.chiefId && conversation.model ? conversation.reasoning : bot?.reasoning;
  const rootTasks = data.tasks.filter(
    (item) => item.kind !== 'memory-review' && item.conversationId === conversation.id && activeTask(item.status)
      && !data.tasks.some((parent) => parent.id === item.parentId && parent.conversationId === conversation.id),
  );
  async function send(event: FormEvent) {
    event.preventDefault();
    const pending = composerDrafts.beginSend(conversation.id);
    if (!pending) return;
    try {
      await mutate("conversations.send", composerSubmission(conversation, pending));
      composerDrafts.finishSend(conversation.id, pending.requestId);
      if (currentConversation.current === conversation.id && mentionRef.current) mentionRef.current.open = false;
    } catch (cause) {
      composerDrafts.finishSend(conversation.id, pending.requestId, errorMessage(cause));
    }
  }
  return (
    <div className="chat-composer-region px-6 pb-3 pt-3 max-sm:px-3">
      <form className="mx-auto w-full max-w-4xl" onSubmit={(event) => void send(event)}>
        <ErrorNote error={error} />
        <div {...(!busy ? dragHandlers : {})} aria-busy={attaching}
          className={`chat-composer rounded-3xl border bg-white/80 px-4 pb-3 pt-2 shadow-sm focus-within:border-black/15 ${dragging ? "border-blue-400 ring-2 ring-blue-100" : "border-black/8"}`}>
          {dragging && <p role="status" className="py-2 text-xs text-blue-700">松开以添加图片或资料</p>}
          {attaching && <p role="status" className="py-2 text-xs text-slate-500">正在添加资料…</p>}
          {!!attachments.length && <div className="mb-2 flex flex-wrap gap-2">
            {attachments.map((artifact) => isImageAttachment(artifact) ? <ImageAttachment key={artifact.id} artifact={artifact}
              conversationId={conversation.id} disabled={busy} onRemove={() => {
                setAttachments(items => items.filter(item => item.id !== artifact.id));
              }} /> : <button key={artifact.id} type="button" aria-label={`取消附加 ${artifact.name}`}
              className="inline-flex max-w-full items-center gap-2 rounded-lg bg-slate-50 px-2 py-1 text-xs text-slate-600"
              disabled={busy} onClick={() => { setAttachments(attachments.filter((item) => item.id !== artifact.id)); }}>
              <Paperclip size={12} /><span className="truncate">{artifact.name}</span><X size={12} /><span className="sr-only">取消附加</span>
            </button>)}
          </div>}
          {targets.length > 0 && (
            <div className="mb-2 flex flex-wrap gap-2">
              {targets.map((id) => (
                <button
                  key={id}
                  type="button"
                  className="inline-flex items-center gap-1 rounded-md bg-blue-50 px-2 py-1 text-xs text-blue-800"
                  disabled={busy}
                  onClick={() => { setTargets(targets.filter((item) => item !== id)); }}
                >
                  @{members.find((item) => item.id === id)?.name || "成员已不可用"}
                  <X size={12} />
                  <span className="sr-only">取消指定</span>
                </button>
              ))}
            </div>
          )}
          <textarea
            ref={textareaRef}
            aria-label="消息内容"
            aria-describedby={busyMembers.length ? `task-input-hint-${conversation.id}` : undefined}
            className="max-h-48 min-h-16 w-full resize-none border-0 bg-transparent px-1 py-3 text-sm leading-6 outline-none placeholder:text-slate-400"
            value={content}
            disabled={busy}
            onPaste={onPaste}
            onChange={(event) => {
              setContent(event.target.value);
            }}
            placeholder={busyMembers.length ? mixedTargets ? "给成员发消息，或补充当前任务…" : "补充、纠正或调整当前任务…"
              : main ? "给主管发消息，或交代一个任务…" : "发消息…"}
            onCompositionStart={() => { composing.current = true; }}
            onCompositionEnd={() => { composing.current = false; }}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing && !composing.current && event.keyCode !== 229) {
                event.preventDefault();
                event.currentTarget.form?.requestSubmit();
              }
            }}
          />
          {!!busyMembers.length && <p id={`task-input-hint-${conversation.id}`} className="mb-2 px-1 text-xs leading-5 text-slate-400">
            {mixedTargets ? "执行中的成员接收任务补充，空闲成员正常回复。" : "消息将补充到正在执行的任务。"}
          </p>}
          <div className="flex items-center justify-between gap-3">
            <div className="flex min-w-0 items-center gap-1">
              <Button type="button" variant="ghost" className="size-8 min-h-8 rounded-full p-0" aria-label={attaching ? "正在添加资料" : "添加资料"} title="添加资料" disabled={busy || attaching} onClick={() => void attach()}>
                <Paperclip size={17} />
              </Button>
              {!main && conversation.kind === "group" && (
                <details ref={mentionRef} className="composer-mention-root relative text-sm">
                  <summary aria-label="指定成员" title="指定成员" className="flex cursor-pointer list-none items-center gap-1.5 rounded-full p-2 text-xs text-slate-500 hover:bg-slate-50">
                    <AtSign size={15} />
                    {!!targets.length && <span>{targets.length}</span>}
                  </summary>
                  <fieldset className="composer-mentions absolute bottom-full left-0 z-10 mb-2 grid max-h-52 w-52 gap-2 overflow-auto rounded-xl border border-slate-200 bg-white p-3 shadow-lg">
                    <label className="mb-1 flex items-center gap-1.5 border-b border-black/5 pb-2 text-xs font-medium text-slate-700"><input type="checkbox" disabled={busy} checked={!!members.length && members.every((bot) => targets.includes(bot.id))} onChange={() => { setTargets(members.every((bot) => targets.includes(bot.id)) ? [] : members.map((bot) => bot.id)); }} />@所有人</label>
                    {members.map((bot) => (
                      <label key={bot.id} className="flex items-center gap-1.5 text-xs text-slate-600">
                        <input
                          type="checkbox"
                          disabled={busy}
                          checked={targets.includes(bot.id)}
                          onChange={() => {
                            setTargets(
                              targets.includes(bot.id) ? targets.filter((id) => id !== bot.id) : [...targets, bot.id],
                            );
                          }}
                        />
                        {bot.name}
                      </label>
                    ))}
                  </fieldset>
                </details>
              )}
              {rootTasks.length > 0 && (
                <Confirm
                  title="停止当前工作？"
                  description="所有进行中的主任务和子任务将收到取消请求，已生成成果保留。"
                  actionLabel="停止"
                  onConfirm={() => Promise.all(rootTasks.map((task) => mutate("tasks.cancel", { id: task.id })))}
                >
                  <Button type="button" variant="ghost" className="text-xs">
                    <Square size={12} />
                    停止
                  </Button>
                </Confirm>
              )}
            </div>
            <div className="flex min-w-0 items-center gap-2">
              {configureChief ? <button type="button" onClick={() => setSettingsOpen(true)} aria-label="配置此对话模型与推理强度" className="flex min-w-0 items-center gap-1 rounded-lg px-2 py-1.5 text-xs text-slate-500 hover:bg-slate-50">
                <span className="truncate">{displayModel}</span>{reasoning && <span className="max-w-24 shrink-0 truncate text-slate-400">{reasoning}</span>}<ChevronDown size={12} className="shrink-0" />
              </button> : <span className="hidden max-w-60 truncate text-xs text-slate-500 sm:inline" title={model}>{displayModel}{reasoning && <span className="ml-1.5 text-slate-400">{reasoning}</span>}</span>}
              <Button variant="primary" aria-label={busy ? "发送中" : "发送消息"} title="Enter 发送，Shift + Enter 换行" disabled={busy || attaching || (!content.trim() && !attachments.length)} className="size-9 shrink-0 rounded-full p-0">
                <ArrowUp size={19} />
              </Button>
            </div>
          </div>
        </div>
        {conversation.kind === "private" && <ConversationStats data={data} conversation={conversation} />}
      </form>
      <ModalPresence show={settingsOpen && !!configureChief}>{settingsOpen && configureChief && <ChiefConversationEditor data={data} mutate={mutate} conversation={conversation}
        close={() => setSettingsOpen(false)} configureChief={configureChief} />}</ModalPresence>
    </div>
  );
}
