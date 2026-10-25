import { useState } from 'react';
import { ArrowLeft, ChevronRight } from 'lucide-react';
import type { Conversation, Snapshot, Task } from '../../../src/domain/types.js';
import { isDeliverableArtifact } from '../../../src/domain/artifact-purpose.js';
import type { Mutate } from './store.js';
import { Avatar } from './Avatar.js';
import { Badge, Button, Empty, cn, timeLabel } from './components.js';
import { TaskDetail } from './TaskDetail.js';
import {
  conversationMemberRecords,
  conversationRecordTasks,
  recordTaskTitle,
  taskRecordStatus,
} from './conversation-records.js';
import { conversationTaskPlans } from './task-plans.js';
import { TaskWorkOverview } from './TaskWorkOverview.js';
import { TaskPlanCard } from './TaskPlanCard.js';
import { ChiefHistorySearch } from './ChiefHistorySearch.js';
import { ChiefHistoryTasks } from './ChiefHistoryTasks.js';
import { inputClass } from './components.js';
import { contextRecordTasks, isChiefHome } from './chief-work.js';

export function ConversationRecords({
  data,
  conversation,
  mutate,
  onContinueHistory,
}: {
  data: Snapshot;
  conversation: Conversation;
  mutate: Mutate;
  onContinueHistory?: () => void;
}) {
  const [selectedId, setSelected] = useState<string>();
  const [memberId, setMember] = useState<string>();
  const [contextId, setContext] = useState('all');
  const [historyQuery, setHistoryQuery] = useState('');
  const home = isChiefHome(data, conversation);
  const contexts = home ? (data.chief?.contexts ?? []) : [];
  const context = contexts.find((item) => item.id === contextId);
  const allTasks = conversationRecordTasks(data, conversation);
  const tasks = context ? contextRecordTasks(allTasks, context.conversationIds) : allTasks;
  const plans = home
    ? data.taskPlans.filter((plan) => tasks.some((task) => task.id === plan.taskId))
    : conversationTaskPlans(data, conversation);
  const taskIds = new Set(tasks.map((task) => task.id));
  const processes = (data.processes ?? []).filter((process) => taskIds.has(process.taskId));
  const members = conversationMemberRecords(tasks, conversation.memberIds);
  const selected = tasks.find((task) => task.id === selectedId);
  const member = members.find((item) => item.botId === (selected?.botId ?? memberId)) ?? members[0];
  const bot = data.bots.find((item) => item.id === member?.botId);
  const scopedData = { ...data, tasks, processes };
  const contextFilter = home && (
    <label className="flex items-center gap-3 text-xs text-slate-500">
      工作记录
      <select
        className="min-w-0 flex-1 rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700"
        aria-label="筛选工作记录的事项"
        value={contextId}
        onChange={(event) => {
          setContext(event.target.value);
          setSelected(undefined);
          setMember(undefined);
        }}
      >
        <option value="all">全部工作</option>
        {contexts.map((item) => (
          <option key={item.id} value={item.id}>
            {item.title}
          </option>
        ))}
      </select>
    </label>
  );
  const search = home && (
    <details className="min-w-0 border-b border-slate-100 pb-4">
      <summary className="cursor-pointer text-sm text-slate-600">查找历史对话</summary>
      <div className="mt-3 grid gap-3">
        <input
          className={inputClass}
          aria-label="搜索历史对话"
          placeholder="输入关键词"
          value={historyQuery}
          onChange={(event) => setHistoryQuery(event.target.value)}
        />
        <ChiefHistorySearch
          query={historyQuery}
          workspaceId=""
          data={data}
          mutate={mutate}
          onContinue={() => onContinueHistory?.()}
        />
      </div>
    </details>
  );
  const history = !!plans.length && (
    <details className="min-w-0 border-b border-slate-100 pb-4">
      <summary className="cursor-pointer text-xs text-slate-500">
        任务安排 · <span className="tabular-nums">{plans.length}</span> 项
      </summary>
      <div className="mt-3 grid min-w-0 gap-2">
        {plans.map((plan) => (
          <TaskPlanCard key={plan.id} plan={plan} data={data} />
        ))}
      </div>
    </details>
  );
  if (!member)
    return (
      <div className="mx-auto grid w-full min-w-0 max-w-3xl gap-5">
        {home && <ChiefHistoryTasks data={data} mutate={mutate} />}
        {search}
        {contextFilter}
        {history}
        <Empty compact title="暂无工作记录" description="智能体的任务和操作会显示在这里。" />
      </div>
    );
  return (
    <div className="mx-auto grid w-full min-w-0 max-w-3xl grid-cols-1 gap-5">
      {home && <ChiefHistoryTasks data={data} mutate={mutate} />}
      {search}
      {contextFilter}
      {history}
      <nav
        aria-label="按智能体查看记录"
        className="flex flex-wrap gap-2 border-b border-slate-100 pb-4"
      >
        {members.map((item) => {
          const owner = data.bots.find((bot) => bot.id === item.botId);
          return (
            <button
              key={item.botId}
              aria-pressed={member.botId === item.botId}
              onClick={() => {
                setMember(item.botId);
                setSelected(undefined);
              }}
              className={cn(
                'flex min-w-0 max-w-full items-center gap-2 rounded-lg border px-3 py-2 text-left',
                member.botId === item.botId
                  ? 'border-blue-200 bg-blue-50 text-blue-800'
                  : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50',
              )}
            >
              <Avatar bot={owner} small />
              <span className="min-w-0">
                <span className="block truncate text-sm font-medium">
                  {owner?.name ?? '已移除成员'}
                </span>
                <span className="block text-xs tabular-nums">
                  {item.tasks.length} 项任务{item.active ? ` · ${item.active} 项进行中` : ''}
                  {item.failed ? ` · ${item.failed} 项失败` : ''}
                </span>
              </span>
            </button>
          );
        })}
      </nav>
      {selected ? (
        <div className="min-w-0">
          <Button
            variant="ghost"
            className="mb-4"
            onClick={() => {
              setMember(selected.botId);
              setSelected(undefined);
            }}
          >
            <ArrowLeft size={14} />
            {bot?.name ?? '成员'}的记录
          </Button>
          <TaskDetail
            key={selected.id}
            task={selected}
            data={scopedData}
            mutate={mutate}
            onSelect={setSelected}
          />
        </div>
      ) : (
        <section aria-label={`${bot?.name ?? '成员'}的记录`} className="grid min-w-0 gap-4">
          <h2 className="text-balance text-sm font-medium text-slate-800">
            {bot?.name ?? '成员'}的任务
          </h2>
          {member.tasks.length ? (
            <ol className="grid gap-2">
              {member.tasks.map((task) => (
                <TaskRecord
                  key={task.id}
                  task={task}
                  data={scopedData}
                  onSelect={() => setSelected(task.id)}
                />
              ))}
            </ol>
          ) : (
            <p className="text-pretty text-sm text-slate-500">该成员暂无对话任务。</p>
          )}
          {!!member.background.length && (
            <details className="border-t border-slate-100 pt-4">
              <summary className="cursor-pointer text-xs text-slate-500">
                后台工作 · <span className="tabular-nums">{member.background.length}</span> 项
              </summary>
              <ol className="mt-3 grid gap-2">
                {member.background.map((task) => (
                  <TaskRecord
                    key={task.id}
                    task={task}
                    data={scopedData}
                    onSelect={() => setSelected(task.id)}
                  />
                ))}
              </ol>
            </details>
          )}
        </section>
      )}
    </div>
  );
}

function TaskRecord({
  task,
  data,
  onSelect,
}: {
  task: Task;
  data: Snapshot;
  onSelect: () => void;
}) {
  const processes = (data.processes ?? []).filter((process) => process.taskId === task.id);
  const room = data.conversations.find((item) => item.id === task.conversationId);
  const activeCommands = processes.filter((process) => process.status === 'running').length;
  const deliverableCount = data.artifacts.filter(
    (artifact) => task.artifactIds.includes(artifact.id) && isDeliverableArtifact(artifact),
  ).length;
  const getBackgroundTaskLabel = () => {
    if (task.kind === 'memory-review') {
      return '记忆整理';
    }
    if (task.kind === 'context-compaction') {
      return '上下文压缩';
    }
    if (task.kind === 'chief-routing') return '事项识别';
    if (task.kind === 'chief-context-maintenance') return '上下文整理';
    return '主管代答';
  };
  return (
    <li>
      <button
        onClick={onSelect}
        className="flex w-full min-w-0 items-start gap-3 rounded-xl border border-slate-200 bg-white p-4 text-left hover:bg-slate-50"
      >
        <div className="min-w-0 flex-1">
          <div className="mb-2 flex flex-wrap items-center gap-2 text-xs">
            <Badge status={task.status}>{taskRecordStatus(task, processes)}</Badge>
            {task.kind && <span className="text-slate-500">{getBackgroundTaskLabel()}</span>}
            {room?.purpose === 'task' && (
              <span className="min-w-0 max-w-48 truncate text-slate-400">{room.name}</span>
            )}
            <span className="ml-auto tabular-nums text-slate-400">{timeLabel(task.updatedAt)}</span>
          </div>
          <p className="line-clamp-2 text-pretty text-sm leading-6 text-slate-700">
            {recordTaskTitle(task)}
          </p>
          <TaskWorkOverview task={task} data={data} compact />
          {task.error && (
            <p className="mt-2 line-clamp-2 break-words text-pretty text-xs leading-5 text-red-700">
              {task.error}
            </p>
          )}
          <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs tabular-nums text-slate-500">
            {!!deliverableCount && <span>{deliverableCount} 项成果</span>}
            {!!processes.length && (
              <span>
                {processes.length} 条命令{activeCommands ? ` · ${activeCommands} 条仍在运行` : ''}
              </span>
            )}
          </div>
        </div>
        <ChevronRight aria-hidden="true" size={16} className="mt-1 shrink-0 text-slate-400" />
      </button>
    </li>
  );
}
