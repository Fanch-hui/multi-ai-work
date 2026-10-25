import { composerDrafts } from './composer-drafts.js';
import { useLayoutEffect, useMemo, useRef } from 'react';
import type { Conversation, Message, Snapshot, Task } from '../../../src/domain/types.js';
import type { ConversationHistory, Mutate } from './store.js';
import { Badge, cn, timeLabel } from './components.js';
import Avatar, { UserAvatar } from './Avatar.js';
import { Markdown } from './Markdown.js';
import { AgentActivity, agentActivity } from './AgentActivity.js';
import { ApprovalCard } from './TaskDetail.js';
import { UserQuestionCard } from './UserQuestionCard.js';
import { MessageArtifacts } from './MessageArtifacts.js';
import {
  conversationMessages,
  messageTaskGroups,
  recoveringTasks,
  workingMembers,
} from './message-feed.js';
import { useScrollFollow } from './useScrollFollow.js';
import { taskRecovery } from './task-activity.js';
import { messageInputFeedbackIndex } from './task-input-feedback.js';
import { chiefConversationIds, isChiefHistory, isChiefHome } from './chief-work.js';
import { conversationRecordTasks } from './conversation-records.js';
import { ChiefInputFeedback } from './ChiefInputFeedback.js';
import { TaskGroupLinks } from './TaskGroupLinks.js';
export function MessageFeed({
  data,
  history,
  conversation,
  mutate,
  onSelectConversation,
}: {
  data: Snapshot;
  history?: ConversationHistory;
  conversation: Conversation;
  mutate: Mutate;
  onSelectConversation: (id: string) => void;
}) {
  const { scrollRef, contentRef, pauseFollow } = useScrollFollow(conversation.id);
  function reply(message: Message) {
    const target = isChiefHistory(data, conversation)
      ? data.chief!.homeConversationId
      : conversation.id;
    composerDrafts.edit(target, {
      replyToMessageId: message.id,
      targetContextId: data.chief?.contexts.find((context) =>
        context.conversationIds.includes(message.conversationId),
      )?.id,
    });
    if (target !== conversation.id) onSelectConversation(target);
  }
  const messages = useMemo(
    () => conversationMessages(data, conversation),
    [data.messages, data.chief, conversation.id, conversation.kind],
  );
  const anchor = useRef<{ messageId: string; offset: number; first?: string } | undefined>(
    undefined,
  );
  useLayoutEffect(() => {
    const feed = scrollRef.current,
      saved = anchor.current;
    if (feed && saved && messages[0]?.id !== saved.first) {
      const target = [...feed.querySelectorAll<HTMLElement>('[data-message-id]')].find(
        (item) => item.dataset.messageId === saved.messageId,
      );
      if (target)
        feed.scrollTop +=
          target.getBoundingClientRect().top - feed.getBoundingClientRect().top - saved.offset;
      anchor.current = undefined;
    } else if (!history?.loading) anchor.current = undefined;
  }, [messages[0]?.id, history?.loading, scrollRef]);
  async function loadOlder() {
    const feed = scrollRef.current;
    if (!feed || !history) return;
    pauseFollow();
    const top = feed.getBoundingClientRect().top;
    const target = [...feed.querySelectorAll<HTMLElement>('[data-message-id]')].find(
      (item) => item.getBoundingClientRect().bottom > top,
    );
    anchor.current = target?.dataset.messageId
      ? {
          messageId: target.dataset.messageId,
          offset: target.getBoundingClientRect().top - top,
          first: messages[0]?.id,
        }
      : undefined;
    await history.loadMore();
  }
  const bots = useMemo(() => new Map(data.bots.map((bot) => [bot.id, bot])), [data.bots]);
  const runs = useMemo(() => new Map(data.runs.map((run) => [run.id, run])), [data.runs]);
  const tasksByRun = useMemo(() => {
    const index = new Map<string, Task>();
    for (const task of data.tasks)
      for (const runId of task.runIds) if (!index.has(runId)) index.set(runId, task);
    return index;
  }, [data.tasks]);
  const feedback = useMemo(
    () =>
      new Map(
        [...chiefConversationIds(data, conversation)].flatMap((id) => [
          ...messageInputFeedbackIndex(data, id),
        ]),
      ),
    [data.bots, data.tasks, data.taskInputs, data.messages, data.chief, conversation.id],
  );
  const main = conversation.purpose === 'chief';
  const home = isChiefHome(data, conversation);
  const conversationIds = useMemo(
    () => chiefConversationIds(data, conversation),
    [data.chief, conversation.id],
  );
  const groups = useMemo(
    () =>
      main
        ? data.conversations.filter(
            (item) =>
              item.purpose === 'task' &&
              !item.archived &&
              conversationIds.has(item.sourceConversationId ?? ''),
          )
        : [],
    [data.conversations, main, conversationIds],
  );
  const groupsByMessage = useMemo(() => messageTaskGroups(groups), [groups]);
  const taskIds = useMemo(
    () =>
      new Set(
        conversationRecordTasks(data, conversation)
          .filter((item) => !item.kind)
          .map((item) => item.id),
      ),
    [data.tasks, data.conversations, data.chief, conversation.id],
  );
  const recovery = useMemo(
    () => recoveringTasks(data, conversation, messages),
    [data.tasks, data.chief, messages, conversation.id, conversation.kind],
  );
  const working = useMemo(
    () => [
      ...workingMembers(data, conversation, messages),
      ...recovery.map((task) => ({ task, run: undefined })),
    ],
    [data.tasks, data.runs, data.chief, messages, conversation.id, recovery],
  );
  const approvals = useMemo(
    () => data.approvals.filter((item) => taskIds.has(item.taskId) && item.status === 'pending'),
    [data.approvals, taskIds],
  );
  const questions = useMemo(
    () =>
      (data.questions ?? []).filter(
        (item) =>
          (conversationIds.has(item.conversationId) || (home && taskIds.has(item.taskId))) &&
          item.status === 'pending',
      ),
    [data.questions, taskIds, conversationIds, home],
  );
  const getEmptyTitle = () => {
    if (main) {
      return '今天想完成什么？';
    }
    if (conversation.kind === 'group') {
      return conversation.name;
    }
    return '开始对话';
  };
  return (
    <div
      ref={scrollRef}
      className="message-feed min-h-0 min-w-0 overflow-y-auto px-6 max-sm:px-3"
      tabIndex={0}
    >
      <div
        ref={contentRef}
        className="message-feed-content mx-auto grid min-w-0 w-full max-w-4xl grid-cols-1 gap-8"
      >
        {history?.hasMore && (
          <div className="text-center">
            <button
              disabled={history.loading}
              onClick={() => void loadOlder()}
              className="rounded-lg px-3 py-2 text-xs text-slate-500 hover:bg-slate-50 disabled:opacity-50"
            >
              {history.loading ? '正在加载…' : '加载更早消息'}
            </button>
          </div>
        )}
        {!messages.length && !working.length && !questions.length && !approvals.length && (
          <div className="flex min-h-48 flex-col items-center justify-center gap-3 py-12 text-center">
            <h2 className="text-balance text-xl font-medium text-slate-700">{getEmptyTitle()}</h2>
            {!main && conversation.kind === 'group' && (
              <p className="max-w-lg text-xs leading-6 text-slate-400">
                {conversation.memberIds
                  .map((id) => bots.get(id)?.name)
                  .filter(Boolean)
                  .join(' · ')}
              </p>
            )}
          </div>
        )}
        {messages.flatMap((message, index) => {
          const bot = bots.get(message.authorBotId ?? '');
          const user = message.authorType === 'user';
          const previous = messages[index - 1];
          const continuation =
            message.authorType === 'bot' &&
            previous?.authorType === 'bot' &&
            !groupsByMessage.has(previous.id) &&
            previous.chiefContextId === message.chiefContextId &&
            previous.authorBotId === message.authorBotId &&
            previous.runId === message.runId;
          const inputFeedback = user ? (feedback.get(message.id) ?? []) : [];
          return [
            <article
              key={message.id}
              data-message-id={message.id}
              className={cn(
                'flex min-w-0 items-start gap-3',
                user && 'justify-end',
                continuation && '-mt-5',
              )}
            >
              {!user &&
                (continuation ? (
                  <span aria-hidden="true" className="size-8 shrink-0" />
                ) : (
                  <Avatar bot={bot} name={bot?.name || '系统'} className="size-8" />
                ))}
              <div className={cn('min-w-0', user ? 'max-w-[85%]' : 'flex-1')}>
                {home &&
                  message.chiefContextId &&
                  message.chiefContextId !== data.chief?.mainContextId &&
                  message.chiefContextId !== previous?.chiefContextId && (
                    <p className="mb-2 text-xs text-slate-400">
                      {
                        data.chief?.contexts.find((item) => item.id === message.chiefContextId)
                          ?.title
                      }
                    </p>
                  )}
                {!user && (!continuation || message.status !== 'committed') && (
                  <div className="mb-2 flex items-center gap-2">
                    {!main && (
                      <span className="text-xs font-medium text-slate-600">
                        {bot?.name || '系统'}
                      </span>
                    )}
                    {!main && (
                      <span className="text-xs tabular-nums text-slate-400">
                        {timeLabel(message.createdAt)}
                      </span>
                    )}
                    {message.status === 'interrupted' && <Badge status="interrupted" />}
                    {message.status === 'draft' && (
                      <AgentActivity
                        animated={!taskRecovery(tasksByRun.get(message.runId ?? ''))}
                        label={agentActivity(
                          tasksByRun.get(message.runId ?? ''),
                          runs.get(message.runId ?? ''),
                          data.events,
                          !!message.content,
                          data.processes,
                        )}
                      />
                    )}
                  </div>
                )}
                {!main && message.mentionedBotIds?.length ? (
                  <p className="mb-2 text-xs font-medium text-blue-700">
                    {message.mentionedBotIds
                      .map((id) => `@${bots.get(id)?.name || '成员'}`)
                      .join(' ')}
                  </p>
                ) : null}
                <div
                  className={cn(
                    'rounded-2xl bg-slate-50 px-4 py-3 text-sm leading-7 text-slate-800',
                  )}
                >
                  {message.replyToMessageId && (
                    <p className="mb-2 border-l-2 border-blue-200 pl-2 text-xs text-slate-500">
                      回复：
                      {messages
                        .find((item) => item.id === message.replyToMessageId)
                        ?.content.slice(0, 100) ?? '较早的消息'}
                    </p>
                  )}
                  {!!message.references?.length && (
                    <p className="mb-2 text-xs text-blue-700">
                      {message.references
                        .map((item) => `${item.kind === 'skill' ? '/' : '@'}${item.label}`)
                        .join(' · ')}
                    </p>
                  )}
                  <Markdown>{message.content}</Markdown>
                </div>
                {message.status === 'committed' && (
                  <button
                    type="button"
                    className="mt-1 text-xs text-slate-400 hover:text-blue-600"
                    onClick={() => reply(message)}
                  >
                    {isChiefHistory(data, conversation) ? '在管家回复此消息' : '回复此消息'}
                  </button>
                )}
                {message.artifactIds.length > 0 && (
                  <MessageArtifacts
                    ids={message.artifactIds}
                    user={user}
                    conversation={
                      home
                        ? (data.conversations.find((room) => room.id === message.conversationId) ??
                          conversation)
                        : conversation
                    }
                    data={data}
                    mutate={mutate}
                  />
                )}
                {home && user && (
                  <ChiefInputFeedback data={data} messageId={message.id} mutate={mutate} />
                )}
                {!!inputFeedback.length && (
                  <div
                    role="status"
                    aria-label="消息送达状态"
                    className="mt-2 flex flex-wrap justify-end gap-x-3 gap-y-1 text-xs leading-5 text-slate-400"
                  >
                    {inputFeedback.map((input) => (
                      <span key={input.id}>
                        {input.name} · {input.status}
                      </span>
                    ))}
                  </div>
                )}
              </div>
              {user && <UserAvatar avatar={data.settings.userAvatar} className="size-8" />}
            </article>,
            <TaskGroupLinks
              key={`groups:${message.id}`}
              groups={groupsByMessage.get(message.id) ?? []}
              bots={data.bots}
              onSelect={onSelectConversation}
            />,
          ];
        })}
        {!!working.length && (
          <div
            className="grid gap-3"
            aria-label={recovery.length ? '当前任务状态' : '正在工作的成员'}
          >
            {working.map(({ run, task }) => {
              const bot = bots.get(task.botId);
              const label = agentActivity(task, run, data.events, false, data.processes);
              return (
                <div className="flex min-w-0 items-center gap-3" key={task.id}>
                  <Avatar bot={bot} name={bot?.name || '成员'} className="size-8" />
                  <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs">
                    <span className="truncate font-medium text-slate-600">
                      {bot?.name || '智能体'}
                    </span>
                    {home && (
                      <span className="truncate text-slate-400">
                        {
                          data.chief?.contexts.find((context) =>
                            context.conversationIds.includes(task.conversationId),
                          )?.title
                        }
                      </span>
                    )}
                    <AgentActivity label={label} animated={!taskRecovery(task)} />
                  </div>
                </div>
              );
            })}
          </div>
        )}
        {approvals.map((item) => (
          <ApprovalCard key={item.id} approval={item} data={data} mutate={mutate} />
        ))}
        {!!questions.length && (
          <div className="grid min-w-0 grid-cols-1 gap-3">
            {questions.map((item) => (
              <UserQuestionCard
                key={item.id}
                question={item}
                data={data}
                mutate={mutate}
                hideResolved
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
