import { useState } from 'react';
import { Minimize2 } from 'lucide-react';
import type { Conversation, Snapshot, Task } from '../../../src/domain/types.js';
import { terminal } from '../../../src/domain/task-status.js';
import { defaultContextWindow } from '../../../src/domain/context-settings.js';
import type { Mutate } from './store.js';

export function ContextCompactionControl({ data, conversation, mutate }: {
  data: Snapshot; conversation: Conversation; mutate: Mutate;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const bot = data.bots.find(bot => bot.id === (conversation.chiefId ?? conversation.memberIds[0]));
  const connection = data.connections.find(connection => connection.id === bot?.connectionId);
  const tasks = data.tasks.filter(task => task.conversationId === conversation.id);
  const latest = tasks.filter(task => task.kind === 'context-compaction').sort((a, b) => a.createdAt.localeCompare(b.createdAt)).at(-1);
  const active = latest && !terminal(latest.status);
  const busy = tasks.some(task => !task.kind && !terminal(task.status));
  const managed = connection && ['chatgpt', 'custom'].includes(connection.provider);
  const contextWindow = bot?.contextWindow ?? defaultContextWindow(connection?.provider,
    connection?.models.find(model => model.id === (conversation.model ?? bot?.model)));
  const reason = !managed ? '此通道的上下文由原生运行时管理' : conversation.archived ? '恢复对话后可压缩'
    : connection.status !== 'ready' ? '请先完成模型连接检测' : !contextWindow ? '请先在成员配置中设置上下文窗口'
    : busy ? '当前任务结束后可压缩' : '';
  const act = async (method: string, id: string) => {
    setPending(true); setError('');
    try { await mutate<Task>(method, { id }); }
    catch (error) { setError(String(error instanceof Error ? error.message : error)); }
    finally { setPending(false); }
  };
  const message = error || (latest?.status === 'failed' || latest?.status === 'interrupted' ? latest.error : latest?.status === 'completed' ? latest.result : undefined);
  return <div className="mt-4 border-t border-slate-100 pt-4">
    <div className="flex items-center justify-between gap-3">
      <button type="button" disabled={pending || !!active || !!reason} onClick={() => void act('conversations.compact', conversation.id)}
        className="inline-flex items-center gap-2 rounded-lg border border-slate-200 px-3 py-2 text-xs text-slate-700 hover:bg-slate-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-blue-500 disabled:cursor-not-allowed disabled:opacity-50">
        <Minimize2 size={13} aria-hidden="true" />{active ? latest.status === 'queued' ? '等待压缩…' : '正在压缩…' : '立即压缩'}
      </button>
      {active && <button type="button" disabled={pending} onClick={() => void act('tasks.cancel', latest.id)}
        className="rounded-md px-2 py-1 text-xs text-slate-500 hover:bg-slate-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-blue-500 disabled:opacity-50">取消</button>}
    </div>
    <p className="mt-2 text-xs leading-relaxed text-slate-500">{reason || '提前整理较早的对话，保留近期内容和完整聊天记录。摘要会产生少量模型用量。'}</p>
    {message && <p role={error || latest?.status === 'failed' ? 'alert' : 'status'} className={`mt-2 text-xs leading-relaxed ${error || latest?.status === 'failed' ? 'text-red-600' : 'text-slate-600'}`}>{message}</p>}
  </div>;
}
