import { useEffect, useState } from 'react';
import { CheckCircle2, LoaderCircle, Minimize2 } from 'lucide-react';
import type { Conversation, Snapshot, Task } from '../../../src/domain/types.js';
import { terminal } from '../../../src/domain/task-status.js';
import { defaultContextWindow } from '../../../src/domain/context-settings.js';
import type { Mutate } from './store.js';
import {
  compactionFeedback,
  latestCompactionTask,
  type CompactionFeedback,
  type CompactionRequest,
} from './context-compaction-state.js';

export function ContextCompactionControl({
  data,
  conversation,
  mutate,
}: {
  data: Snapshot;
  conversation: Conversation;
  mutate: Mutate;
}) {
  const [pending, setPending] = useState<CompactionRequest>();
  const [error, setError] = useState('');
  const [response, setResponse] = useState<Task>();
  const bot = data.bots.find(
    (bot) => bot.id === (conversation.chiefId ?? conversation.memberIds[0]),
  );
  const connection = data.connections.find((connection) => connection.id === bot?.connectionId);
  const tasks = data.tasks.filter((task) => task.conversationId === conversation.id);
  const latest = latestCompactionTask(tasks, conversation.id, response);
  const feedback = compactionFeedback(latest, pending, error);
  useEffect(() => setError(''), [latest?.id, latest?.status]);
  const busy = tasks.some((task) => !task.kind && !terminal(task.status));
  const managed = connection && ['chatgpt', 'custom'].includes(connection.provider);
  const contextWindow =
    bot?.contextWindow ??
    defaultContextWindow(
      connection?.provider,
      connection?.models.find((model) => model.id === (conversation.model ?? bot?.model)),
    );
  const resolveReason = () => {
    if (!managed) {
      return '此通道的上下文由原生运行时管理';
    }
    if (conversation.archived) {
      return '恢复对话后可压缩';
    }
    if (connection.status !== 'ready') {
      return '请先完成模型连接检测';
    }
    if (!contextWindow) {
      return '请先在成员配置中设置上下文窗口';
    }
    if (busy) {
      return '当前任务结束后可压缩';
    }
    return '';
  };
  const reason = resolveReason();
  const act = async (action: CompactionRequest, id: string) => {
    setPending(action);
    setError('');
    if (action === 'start') setResponse(undefined);
    try {
      setResponse(
        await mutate<Task>(action === 'start' ? 'conversations.compact' : 'tasks.cancel', { id }),
      );
    } catch (error) {
      setError(String(error instanceof Error ? error.message : error));
    } finally {
      setPending(undefined);
    }
  };
  const resolveActionLabel = () => {
    if (!feedback?.busy) {
      return '立即压缩';
    }
    if (feedback.tone === 'progress') {
      return feedback.label;
    }
    return '正在压缩…';
  };
  const actionLabel = resolveActionLabel();
  return (
    <div className="mt-4 border-t border-slate-100 pt-4">
      <div className="flex items-center justify-between gap-3">
        <button
          type="button"
          disabled={feedback?.busy || !!reason}
          onClick={() => void act('start', conversation.id)}
          className="inline-flex items-center gap-2 rounded-lg border border-slate-200 px-3 py-2 text-xs text-slate-700 hover:bg-slate-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-blue-500 disabled:cursor-not-allowed disabled:opacity-50"
        >
          <Minimize2 size={13} aria-hidden="true" />
          {actionLabel}
        </button>
        {feedback?.cancellable && latest && (
          <button
            type="button"
            disabled={!!pending}
            onClick={() => void act('cancel', latest.id)}
            className="rounded-md px-2 py-1 text-xs text-slate-500 hover:bg-slate-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-blue-500 disabled:opacity-50"
          >
            {pending === 'cancel' ? '正在取消…' : '取消压缩'}
          </button>
        )}
      </div>
      <p className="mt-2 text-xs leading-relaxed text-slate-500">
        {reason || '提前整理较早的对话，保留近期内容和完整聊天记录。摘要会产生少量模型用量。'}
      </p>
      {feedback && <CompactionStatus feedback={feedback} />}
    </div>
  );
}

export function CompactionStatus({ feedback }: { feedback: CompactionFeedback }) {
  const resolveColor = () => {
    if (feedback.tone === 'error') {
      return 'text-red-600';
    }
    if (feedback.tone === 'success') {
      return 'text-emerald-700';
    }
    return 'text-slate-600';
  };
  const color = resolveColor();
  return (
    <div
      role={feedback.tone === 'error' ? 'alert' : 'status'}
      aria-live="polite"
      className={`mt-3 rounded-lg bg-slate-50 px-3 py-2 text-xs leading-relaxed ${color}`}
    >
      <div className="flex items-center gap-2 font-medium">
        {feedback.tone === 'progress' && (
          <LoaderCircle
            size={13}
            aria-hidden="true"
            className="shrink-0 motion-safe:animate-spin"
          />
        )}
        {feedback.tone === 'success' && (
          <CheckCircle2 size={13} aria-hidden="true" className="shrink-0" />
        )}
        {feedback.label}
      </div>
      {feedback.detail && <p className="mt-1 break-words">{feedback.detail}</p>}
    </div>
  );
}
