import { VoiceControls } from './voice/VoiceControls.js';
import { ReferencePicker } from './work-chat/ReferencePicker.js';
import { ModalPresence } from './ModalPresence.js';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ArrowUp, ChevronDown, X, Square, Paperclip } from 'lucide-react';
import type { Conversation, Snapshot } from '../../../src/domain/types.js';
import type { Mutate } from './store.js';
import { errorMessage } from './api.js';
import { Button, Confirm, ErrorNote, activeTask } from './components.js';
import { ConversationStats } from './ConversationStats.js';
import { ChiefConversationEditor } from './ChiefConversationEditor.js';
import { ImageAttachment, isImageAttachment } from './ImageAttachment.js';
import { useAttachments } from './useAttachments.js';
import { busyInputMembers } from './task-input-feedback.js';
import { composerDrafts, composerSubmission, useComposerDraft } from './composer-drafts.js';
import { modelLabel } from './model-label.js';
import { MAX_MESSAGE_ATTACHMENTS } from '../../../src/domain/attachment-policy.js';
import { focusedChiefContext, focusedConversation, isChiefHome } from './chief-work.js';
export function Composer({
  data,
  conversation,
  mutate,
  configureChief,
  conversationStartToken,
  onConversationStartHandled,
  onConversationStateChange,
}: {
  data: Snapshot;
  conversation: Conversation;
  mutate: Mutate;
  configureChief?: () => void;
  conversationStartToken?: number;
  onConversationStartHandled?: (token: number) => void;
  onConversationStateChange?: (active: boolean) => void;
}) {
  const { draft, setContent, setTargets, setReferences } = useComposerDraft(conversation.id);
  const { content, targets, error, sending: busy } = draft;
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [voiceTaskIds, setVoiceTaskIds] = useState<string[]>([]);
  const [voiceInputId, setVoiceInputId] = useState<string>();
  const [stopTaskIds, setStopTaskIds] = useState<string[]>([]);
  const { attachments, setAttachments, attaching, dragging, attach, onPaste, dragHandlers } =
    useAttachments(conversation.id, mutate);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const composing = useRef(false);
  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = 'auto';
    textarea.style.height = `${Math.min(192, Math.max(48, textarea.scrollHeight))}px`;
  }, [conversation.id, content]);
  const main = conversation.purpose === 'chief';
  const home = isChiefHome(data, conversation);
  const execution = focusedConversation(data, conversation);
  const context = home ? focusedChiefContext(data) : undefined;
  const members = data.bots.filter(
    (item) => conversation.memberIds.includes(item.id) && !item.archived,
  );
  const bot = members.find((item) => item.id === conversation.chiefId) || members[0];
  const receivingMembers =
    !main && targets.length ? members.filter((member) => targets.includes(member.id)) : members;
  const busyMembers = busyInputMembers(data, execution, targets);
  const mixedTargets = busyMembers.length > 0 && busyMembers.length < receivingMembers.length;
  const model =
    (!home && bot?.id === conversation.chiefId ? conversation.model : undefined) || bot?.model;
  const displayModel = modelLabel(
    data.connections.find((item) => item.id === bot?.connectionId),
    model,
    '配置模型',
  );
  const reasoning =
    !home && bot?.id === conversation.chiefId && conversation.model
      ? conversation.reasoning
      : bot?.reasoning;
  const rootTasks = data.tasks.filter(
    (item) =>
      !item.kind &&
      (context?.conversationIds ?? [conversation.id]).includes(item.conversationId) &&
      activeTask(item.status) &&
      !data.tasks.some(
        (parent) => parent.id === item.parentId && parent.conversationId === conversation.id,
      ),
  );
  const submittedVoice = data.chief?.inputs.find((input) => input.id === voiceInputId);
  const voiceIds = submittedVoice?.taskIds.length ? submittedVoice.taskIds : voiceTaskIds;
  const voiceTasks = data.tasks.filter((task) => voiceIds.includes(task.id));
  const voiceFinished =
    voiceTasks.length > 0 &&
    voiceTasks.length === voiceIds.length &&
    voiceTasks.every((task) =>
      ['completed', 'failed', 'cancelled', 'interrupted'].includes(task.status),
    );
  const voiceRuns = new Set(
    voiceTasks.filter((task) => task.status === 'completed').flatMap((task) => task.runIds),
  );
  const voiceReply = voiceFinished
    ? data.messages
        .filter(
          (message) =>
            (message.conversationId === conversation.id ||
              (home && message.chiefTimelineSequence !== undefined)) &&
            message.authorType === 'bot' &&
            message.status === 'committed' &&
            message.runId &&
            voiceRuns.has(message.runId) &&
            message.content.trim(),
        )
        .at(-1)
    : undefined;
  const getVoiceFailure = () => {
    if (submittedVoice?.status === 'failed') return submittedVoice.error;
    if (voiceFinished && !voiceReply)
      return (
        voiceTasks.find((task) => task.status !== 'completed')?.error ||
        '本次任务没有可朗读的回复，请继续输入'
      );
    return undefined;
  };
  const voiceFailure = getVoiceFailure();
  async function sendVoice(text: string) {
    const result = await mutate<{ taskIds: string[]; inputId?: string }>(
      home ? 'chief.inputs.send' : 'conversations.send',
      {
        conversationId: conversation.id,
        content: text,
        targetBotIds: targets.length ? targets : undefined,
        requestId: crypto.randomUUID(),
        ...(home && draft.targetContextId ? { targetContextId: draft.targetContextId } : {}),
      },
    );
    setVoiceTaskIds(result.taskIds);
    setVoiceInputId(result.inputId);
  }
  async function send(event: FormEvent) {
    event.preventDefault();
    const pending = composerDrafts.beginSend(conversation.id);
    if (!pending) return;
    try {
      await mutate(
        home ? 'chief.inputs.send' : 'conversations.send',
        composerSubmission(conversation, pending),
      );
      composerDrafts.finishSend(conversation.id, pending.requestId);
    } catch (cause) {
      composerDrafts.finishSend(conversation.id, pending.requestId, errorMessage(cause));
    }
  }
  const getMessagePlaceholder = () => {
    if (home) return '和管家聊聊，或交代一项工作…';
    if (busyMembers.length) {
      if (mixedTargets) {
        return '给成员发消息，或补充当前任务…';
      }
      return '补充、纠正或调整当前任务…';
    }
    if (main) {
      return '给主管发消息，或交代一个任务…';
    }
    return '发消息…';
  };
  return (
    <div className="chat-composer-region px-6 pb-3 pt-3 max-sm:px-3">
      <form className="mx-auto w-full max-w-4xl" onSubmit={(event) => void send(event)}>
        <ErrorNote error={error} />
        {draft.references?.length ||
        draft.replyToMessageId ||
        targets.length ||
        draft.targetContextId ? (
          <div className="mb-2 flex flex-wrap gap-2 text-xs">
            {draft.targetContextId && (
              <button
                type="button"
                className="rounded-lg bg-blue-50 px-3 py-1 text-blue-700"
                onClick={() => composerDrafts.edit(conversation.id, { targetContextId: undefined })}
              >
                参考工作：
                {data.chief?.contexts.find((item) => item.id === draft.targetContextId)?.title ||
                  '历史工作'}{' '}
                ×
              </button>
            )}
            {draft.replyToMessageId && (
              <button
                type="button"
                className="max-w-full truncate rounded-lg bg-blue-50 px-3 py-1 text-blue-700"
                onClick={() =>
                  composerDrafts.edit(conversation.id, { replyToMessageId: undefined })
                }
              >
                回复：
                {data.messages
                  .find((item) => item.id === draft.replyToMessageId)
                  ?.content.slice(0, 80) ?? '已选择消息'}{' '}
                ×
              </button>
            )}
            {draft.references?.map((item) => (
              <button
                type="button"
                key={`${item.kind}:${item.id}`}
                className="rounded-lg bg-slate-100 px-3 py-1"
                onClick={() => setReferences(draft.references!.filter((other) => other !== item))}
              >
                {item.kind === 'skill' ? '/' : '@'}
                {item.label} ×
              </button>
            ))}
          </div>
        ) : null}

        <div
          {...(!busy ? dragHandlers : {})}
          aria-busy={attaching}
          className={`chat-composer rounded-3xl border bg-white/80 px-4 pb-3 pt-2 shadow-sm focus-within:border-black/15 ${dragging ? 'border-blue-400 ring-2 ring-blue-100' : 'border-black/8'}`}
        >
          {dragging && (
            <p role="status" className="py-2 text-xs text-blue-700">
              松开以添加图片或资料
            </p>
          )}
          {attaching && (
            <p role="status" className="py-2 text-xs text-slate-500">
              正在添加资料…
            </p>
          )}
          {!!attachments.length && (
            <div className="mb-2 flex flex-wrap gap-2">
              {attachments.map((artifact) =>
                isImageAttachment(artifact) ? (
                  <ImageAttachment
                    key={artifact.id}
                    artifact={artifact}
                    conversationId={conversation.id}
                    disabled={busy}
                    onRemove={() => {
                      setAttachments((items) => items.filter((item) => item.id !== artifact.id));
                    }}
                  />
                ) : (
                  <button
                    key={artifact.id}
                    type="button"
                    aria-label={`取消附加 ${artifact.name}`}
                    className="inline-flex max-w-full items-center gap-2 rounded-lg bg-slate-50 px-2 py-1 text-xs text-slate-600"
                    disabled={busy}
                    onClick={() => {
                      setAttachments(attachments.filter((item) => item.id !== artifact.id));
                    }}
                  >
                    <Paperclip size={12} />
                    <span className="truncate">{artifact.name}</span>
                    <X size={12} />
                    <span className="sr-only">取消附加</span>
                  </button>
                ),
              )}
            </div>
          )}
          {targets.length > 0 && (
            <div className="mb-2 flex flex-wrap gap-2">
              {targets.map((id) => (
                <button
                  key={id}
                  type="button"
                  className="inline-flex items-center gap-1 rounded-md bg-blue-50 px-2 py-1 text-xs text-blue-800"
                  disabled={busy}
                  onClick={() => {
                    setTargets(targets.filter((item) => item !== id));
                  }}
                >
                  @{members.find((item) => item.id === id)?.name || '成员已不可用'}
                  <X size={12} />
                  <span className="sr-only">取消指定</span>
                </button>
              ))}
            </div>
          )}
          <textarea
            ref={textareaRef}
            rows={1}
            aria-label="消息内容"
            aria-describedby={busyMembers.length ? `task-input-hint-${conversation.id}` : undefined}
            className="max-h-48 min-h-12 w-full resize-none border-0 bg-transparent px-1 py-3 text-sm leading-6 outline-none placeholder:text-slate-400"
            value={content}
            disabled={busy}
            onPaste={onPaste}
            onChange={(event) => {
              setContent(event.target.value);
            }}
            placeholder={getMessagePlaceholder()}
            onCompositionStart={() => {
              composing.current = true;
            }}
            onCompositionEnd={() => {
              composing.current = false;
            }}
            onKeyDown={(event) => {
              if (
                event.key === 'Enter' &&
                !event.shiftKey &&
                !event.nativeEvent.isComposing &&
                !composing.current &&
                event.keyCode !== 229
              ) {
                event.preventDefault();
                event.currentTarget.form?.requestSubmit();
              }
            }}
          />
          {!home && !!busyMembers.length && (
            <p
              id={`task-input-hint-${conversation.id}`}
              className="mb-2 px-1 text-xs leading-5 text-slate-400"
            >
              {mixedTargets
                ? '执行中的成员接收任务补充，空闲成员正常回复。'
                : '消息将补充到正在执行的任务。'}
            </p>
          )}
          <div className="flex items-center justify-between gap-3">
            <div className="flex min-w-0 items-center gap-1">
              <Button
                type="button"
                variant="ghost"
                className="size-8 min-h-8 rounded-full p-0"
                aria-label={attaching ? '正在添加资料' : '添加资料'}
                title={`添加资料（每条消息最多 ${MAX_MESSAGE_ATTACHMENTS} 个附件）`}
                disabled={busy || attaching}
                onClick={() => void attach()}
              >
                <Paperclip size={17} />
              </Button>
              <ReferencePicker
                conversationId={conversation.id}
                members={members}
                targets={targets}
                content={content}
                selected={draft.references ?? []}
                disabled={busy}
                setContent={setContent}
                setTargets={setTargets}
                setSelected={setReferences}
              />
              <VoiceControls
                conversationId={conversation.id}
                onDictation={(text) =>
                  setContent((previous) => (previous.trim() ? `${previous}\n${text}` : text))
                }
                onSubmit={sendVoice}
                reply={voiceReply ? { id: voiceReply.id, text: voiceReply.content } : undefined}
                taskError={voiceFailure}
                busy={busy}
                disabled={attaching}
                conversationStartToken={conversationStartToken}
                onConversationStartHandled={onConversationStartHandled}
                onConversationStateChange={onConversationStateChange}
              />

              {rootTasks.length > 0 && (
                <Confirm
                  key={context?.id ?? conversation.id}
                  title="停止当前工作？"
                  description="所有进行中的主任务和子任务将收到取消请求，已生成成果保留。"
                  actionLabel="停止"
                  onConfirm={() =>
                    Promise.all(stopTaskIds.map((id) => mutate('tasks.cancel', { id })))
                  }
                >
                  <Button
                    type="button"
                    variant="ghost"
                    className="text-xs"
                    onClick={() => setStopTaskIds(rootTasks.map((task) => task.id))}
                  >
                    <Square size={12} />
                    停止
                  </Button>
                </Confirm>
              )}
            </div>
            <div className="flex min-w-0 items-center gap-2">
              {configureChief ? (
                <button
                  type="button"
                  onClick={() => (home ? configureChief() : setSettingsOpen(true))}
                  aria-label={home ? '配置管家模型与推理强度' : '配置此对话模型与推理强度'}
                  className="flex min-w-0 items-center gap-1 rounded-lg px-2 py-1.5 text-xs text-slate-500 hover:bg-slate-50"
                >
                  <span className="truncate">{displayModel}</span>
                  {reasoning && (
                    <span className="max-w-24 shrink-0 truncate text-slate-400">{reasoning}</span>
                  )}
                  <ChevronDown size={12} className="shrink-0" />
                </button>
              ) : (
                <span
                  className="hidden max-w-60 truncate text-xs text-slate-500 sm:inline"
                  title={model}
                >
                  {displayModel}
                  {reasoning && <span className="ml-1.5 text-slate-400">{reasoning}</span>}
                </span>
              )}
              <Button
                variant="primary"
                aria-label={busy ? '发送中' : '发送消息'}
                title="Enter 发送，Shift + Enter 换行"
                disabled={busy || attaching || (!content.trim() && !attachments.length)}
                className="size-9 shrink-0 rounded-full p-0"
              >
                <ArrowUp size={19} />
              </Button>
            </div>
          </div>
        </div>
        {conversation.kind === 'private' && (
          <ConversationStats
            data={data}
            conversation={home ? conversation : execution}
            mutate={mutate}
          />
        )}
      </form>
      <ModalPresence show={settingsOpen && !!configureChief}>
        {settingsOpen && configureChief && (
          <ChiefConversationEditor
            data={data}
            mutate={mutate}
            conversation={conversation}
            close={() => setSettingsOpen(false)}
            configureChief={configureChief}
          />
        )}
      </ModalPresence>
    </div>
  );
}
