import { useLayoutEffect, useRef } from 'react';
import { ArrowUpRight } from 'lucide-react';
import type { Conversation, Snapshot, Task } from '../../../src/domain/types.js';
import type { ConversationHistory, Mutate } from './store.js';
import { Badge, cn, timeLabel } from './components.js';
import Avatar, { UserAvatar } from './Avatar.js';
import { ConversationAvatar } from './ConversationAvatar.js';
import { Markdown } from './Artifacts.js';
import { AgentActivity, agentActivity } from './AgentActivity.js';
import { ApprovalCard } from './TaskDetail.js';
import { UserQuestionCard } from './UserQuestionCard.js';
import { MessageArtifacts } from './MessageArtifacts.js';
import { conversationMessages, recoveringTasks, workingMembers } from './message-feed.js';
import { useScrollFollow } from './useScrollFollow.js';
import { taskRecovery } from './task-activity.js';
import { messageInputFeedbackIndex } from './task-input-feedback.js';
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
  const messages = conversationMessages(data, conversation);
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
  const bots = new Map(data.bots.map((bot) => [bot.id, bot]));
  const runs = new Map(data.runs.map((run) => [run.id, run]));
  const tasksByRun = new Map<string, Task>();
  for (const task of data.tasks)
    for (const runId of task.runIds) if (!tasksByRun.has(runId)) tasksByRun.set(runId, task);
  const feedback = messageInputFeedbackIndex(data, conversation.id);
  const main = conversation.purpose === 'chief';
  const groups = main
    ? data.conversations.filter(
        (item) =>
          item.purpose === 'task' &&
          !item.archived &&
          item.sourceConversationId === conversation.id,
      )
    : [];
  const taskIds = new Set(
    data.tasks
      .filter(
        (item) =>
          item.kind !== 'memory-review' &&
          item.kind !== 'context-compaction' &&
          item.conversationId === conversation.id,
      )
      .map((item) => item.id),
  );
  const recovery = recoveringTasks(data, conversation, messages);
  const working = [
    ...workingMembers(data, conversation, messages),
    ...recovery.map((task) => ({ task, run: undefined })),
  ];
  const approvals = data.approvals.filter(
    (item) => taskIds.has(item.taskId) && item.status === 'pending',
  );
  const questions = (data.questions ?? []).filter(
    (item) => item.conversationId === conversation.id && item.status === 'pending',
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
        {messages.map((message, index) => {
          const bot = bots.get(message.authorBotId ?? '');
          const user = message.authorType === 'user';
          const previous = messages[index - 1];
          const continuation =
            message.authorType === 'bot' &&
            previous?.authorType === 'bot' &&
            previous.authorBotId === message.authorBotId &&
            previous.runId === message.runId;
          const inputFeedback = user ? (feedback.get(message.id) ?? []) : [];
          return (
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
                  <Markdown>{message.content}</Markdown>
                </div>
                {message.artifactIds.length > 0 && (
                  <MessageArtifacts
                    ids={message.artifactIds}
                    user={user}
                    conversation={conversation}
                    data={data}
                    mutate={mutate}
                  />
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
            </article>
          );
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
                <div className="flex min-w-0 items-center gap-3" key={task.botId}>
                  <Avatar bot={bot} name={bot?.name || '成员'} className="size-8" />
                  <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs">
                    <span className="truncate font-medium text-slate-600">
                      {bot?.name || '智能体'}
                    </span>
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
        {!!groups.length && (
          <div className="grid gap-1 border-t border-black/5 pt-4" aria-label="关联任务群聊">
            {groups.map((group) => (
              <button
                key={group.id}
                onClick={() => onSelectConversation(group.id)}
                className="flex min-w-0 items-center gap-2 rounded-lg px-2 py-2 text-left text-xs text-slate-500 hover:bg-slate-50"
              >
                <ConversationAvatar conversation={group} bots={data.bots} className="size-6" />
                <span className="truncate">{group.name}</span>
                <span className="ml-auto shrink-0 text-slate-400">进入群聊</span>
                <ArrowUpRight size={13} className="shrink-0" />
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
