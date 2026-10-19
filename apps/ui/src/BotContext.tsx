import { useState } from 'react';
import type { Bot, Snapshot } from '../../../src/domain/types.js';
import { Field, Modal, inputClass, timeLabel } from './components.js';
import { NativeContextGuide } from './NativeContextGuide.js';
import {
  defaultContextWindow,
  managedContextBudget,
} from '../../../src/domain/context-settings.js';

export function BotContext({ bot, data, close }: { bot: Bot; data: Snapshot; close: () => void }) {
  const bindings = data.bindings.filter((binding) => binding.botId === bot.id && !binding.purpose);
  const latest = bindings.reduce(
    (result, binding) => {
      const previous = result.find((item) => item.conversationId === binding.conversationId);
      if (!previous || binding.generation > previous.generation) {
        return [
          ...result.filter((item) => item.conversationId !== binding.conversationId),
          binding,
        ];
      }
      return result;
    },
    [] as typeof bindings,
  );
  const [selected, setSelected] = useState(latest[0]?.conversationId || '');
  const binding = latest.find((item) => item.conversationId === selected);
  const connection = data.connections.find((item) => item.id === bot.connectionId);
  const runIds = new Set(
    data.runs.filter((run) => run.bindingId === binding?.id).map((run) => run.id),
  );
  const context = data.events
    .filter((event) => runIds.has(event.runId) && event.type === 'context')
    .at(-1)?.data;
  const checkpoint = data.checkpoints.filter((item) => item.bindingId === binding?.id).at(-1);
  const compaction = data.compactions.filter((item) => item.bindingId === binding?.id).at(-1);
  const native = connection?.provider === 'antigravity' || connection?.provider === 'qoder';
  const model = connection?.models.find((item) => item.id === bot.model);
  const contextWindow = bot.contextWindow ?? defaultContextWindow(connection?.provider, model);
  const budget = managedContextBudget(contextWindow, bot.compactionThreshold, bot.outputReserve);
  const memories = data.memories.filter(
    (memory) =>
      memory.status === 'approved' &&
      binding &&
      (memory.scope === 'team'
        ? memory.ownerId === binding.conversationId
        : memory.allowedConversationIds.includes(binding.conversationId) &&
          (memory.scope === 'shared' || memory.ownerId === bot.id)),
  );
  const getContextLabel = () => {
    if (context?.source === 'native-reported' && typeof context.usedPercentage === 'number') {
      return `运行时报告占用 ${context.usedPercentage.toFixed(1)}%`;
    }
    if (context?.source === 'native-reported' && typeof context.usedTokens === 'number') {
      return `运行时报告已用 ${context.usedTokens.toLocaleString()} / ${String(context.contextWindow ?? '未知')} tokens`;
    }
    if (context?.source === 'app-estimated' && typeof context.estimatedTokens === 'number') {
      return `估计占用 ${context.estimatedTokens.toLocaleString()} tokens${typeof context.availableTokens === 'number' ? ` / 可用 ${context.availableTokens.toLocaleString()}` : '，窗口未知'}`;
    }
    return '上下文占用未知';
  };
  const getCompactionLabel = (status: string) => {
    if (status === 'completed') {
      return '完成';
    }
    if (status === 'started') {
      return '进行中';
    }
    return '未替换上下文';
  };
  const renderMemories = () => {
    if (bot.memoryMode === 'off') {
      return <p className="text-slate-500">此成员已关闭记忆</p>;
    }
    if (memories.length) {
      return memories.map((memory) => (
        <p key={memory.id} className="mt-2 whitespace-pre-wrap text-slate-600">
          {memory.content}
        </p>
      ));
    }
    return <p className="text-slate-500">尚无长期记忆</p>;
  };
  return (
    <Modal open title={`${bot.name} · 上下文与记忆`} onOpenChange={(open) => !open && close()}>
      <div className="grid gap-5">
        <Field label="会话">
          <select
            className={inputClass}
            value={selected}
            onChange={(event) => setSelected(event.target.value)}
          >
            {!latest.length && <option value="">尚未开始会话</option>}
            {latest.map((item) => (
              <option key={item.id} value={item.conversationId}>
                {data.conversations.find((room) => room.id === item.conversationId)?.name ||
                  item.conversationId}
              </option>
            ))}
          </select>
        </Field>
        <section className="rounded-xl border border-slate-200 p-4 text-sm">
          <h3 className="mb-3 font-semibold">上下文</h3>
          {native && connection ? (
            <NativeContextGuide connection={connection} />
          ) : (
            <>
              <p className="text-slate-600">App 管理</p>
              <p className="mt-2 text-xs tabular-nums text-slate-500">
                配置窗口 {contextWindow?.toLocaleString() || '自动'} tokens
                <span>
                  {' '}
                  · 压缩阈值 {budget.compactionThreshold}% · 预留 {100 - budget.compactionThreshold}
                  %
                </span>
              </p>
              {budget.effectiveCompactionThreshold !== undefined &&
                budget.effectiveCompactionThreshold < budget.compactionThreshold && (
                  <p className="mt-2 text-xs tabular-nums text-slate-500">
                    回复预留限制了输入预算，实际达到{' '}
                    {Number(budget.effectiveCompactionThreshold.toFixed(2))}% 时压缩。
                  </p>
                )}
            </>
          )}
          <p className="mt-2 text-slate-600 tabular-nums">{getContextLabel()}</p>
          {binding && (
            <p className="mt-2 break-all text-xs text-slate-400">
              绑定 {binding.id} · 第 {binding.generation} 代
            </p>
          )}
          {compaction && (
            <p className="mt-3 text-xs text-slate-500">
              最近整理：
              {getCompactionLabel(compaction.status)} · {timeLabel(compaction.createdAt)}
              {compaction.reason === 'needs_split' && ' · 单轮资料过大，需要分割输入'}
            </p>
          )}
          {checkpoint && (
            <details className="mt-3 text-xs text-slate-500">
              <summary className="cursor-pointer">
                会话检查点 · 截至消息 {checkpoint.throughSequence}
              </summary>
              <p className="mt-2 whitespace-pre-wrap leading-6">{checkpoint.content}</p>
            </details>
          )}
        </section>
        <section className="rounded-xl border border-slate-200 p-4 text-sm">
          <h3 className="mb-3 font-semibold">本会话可用记忆</h3>
          {renderMemories()}
          <p className="mt-3 text-xs text-slate-400">
            成员管理自己的记忆，你可以在“记忆”页面编辑。
          </p>
        </section>
      </div>
    </Modal>
  );
}
