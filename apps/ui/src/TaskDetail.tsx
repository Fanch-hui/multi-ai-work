import { useState } from 'react';
import {
  Check,
  X,
  RotateCcw,
  Square,
  ChevronRight,
  FileText,
  Activity,
  ShieldCheck,
} from 'lucide-react';
import type { Approval, Snapshot, Task } from '../../../src/domain/types.js';
import { isDeliverableArtifact } from '../../../src/domain/artifact-purpose.js';
import { childTaskRetryBlocker } from '../../../src/domain/task-status.js';
import type { Mutate } from './store.js';
import { errorMessage } from './api.js';
import { Badge, Button, Confirm, ErrorNote, activeTask, timeLabel } from './components.js';
import { Avatar } from './Avatar.js';
import { recordTaskTitle, taskRecordStatus } from './conversation-records.js';
import { CommandRecords } from './CommandRecords.js';
import { ArtifactItem } from './Artifacts.js';
import { Markdown } from './Markdown.js';
import { UserQuestionCard } from './UserQuestionCard.js';
import { RunRecords } from './RunRecords.js';
import { TaskWorkOverview } from './TaskWorkOverview.js';
import { TaskActivityDetails } from './TaskActivityDetails.js';
import { RequirementDetails } from './RequirementDetails.js';
import { currentActivityLabel, stoppingTask } from './task-activity.js';
export function ApprovalCard({
  approval,
  data,
  mutate,
}: {
  approval: Approval;
  data: Snapshot;
  mutate: Mutate;
}) {
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const bot = data.bots.find((item) => item.id === approval.botId);
  async function resolve(approved: boolean) {
    setBusy(true);
    setError('');
    try {
      await mutate('approvals.resolve', { id: approval.id, approved });
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="rounded-xl border border-amber-200 bg-amber-50 p-4">
      <div className="mb-2 flex items-center gap-2 text-xs font-medium text-amber-800">
        <ShieldCheck size={14} />
        {bot?.name || '智能体'} 请求权限
      </div>
      <h3 className="text-pretty text-sm font-semibold text-slate-900">{approval.summary}</h3>
      <p className="mt-1 text-xs text-slate-500">{approval.toolName}</p>
      <details className="mt-3 text-xs text-slate-600">
        <summary className="cursor-pointer">查看操作参数</summary>
        <pre className="mt-2 max-h-44 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-white p-3">
          {JSON.stringify(approval.args, null, 2)}
        </pre>
      </details>
      <ErrorNote error={error} />
      <div className="mt-4 flex gap-2">
        <Button variant="primary" disabled={busy} onClick={() => void resolve(true)}>
          <Check size={14} />
          允许本次
        </Button>
        <Button disabled={busy} onClick={() => void resolve(false)}>
          <X size={14} />
          拒绝
        </Button>
      </div>
    </div>
  );
}
export function TaskDetail({
  task,
  data,
  mutate,
  onSelect,
}: {
  task: Task;
  data: Snapshot;
  mutate: Mutate;
  onSelect?: (id: string) => void;
}) {
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const bot = data.bots.find((item) => item.id === task.botId);
  const children = data.tasks.filter((item) => item.parentId === task.id);
  const retryBlocker = childTaskRetryBlocker(children);
  const canContinue =
    (task.status === 'waiting_input' && task.coordinationPaused) ||
    (!task.reconciliationRequired && ['failed', 'interrupted', 'cancelled'].includes(task.status));
  const artifacts = data.artifacts.filter(
    (item) => task.artifactIds.includes(item.id) && isDeliverableArtifact(item),
  );
  const approvals = data.approvals.filter(
    (item) => item.taskId === task.id && item.status === 'pending',
  );
  const questions = (data.questions ?? []).filter((item) => item.taskId === task.id);
  const runs = data.runs
    .filter((item) => item.taskId === task.id)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const latestRun = runs.find((run) => run.id === task.runIds.at(-1)) ?? runs[0];
  const stopping = stoppingTask(task, latestRun);
  const processes = (data.processes ?? []).filter((item) => item.taskId === task.id);
  async function retry() {
    if (retryBlocker) return;
    setBusy(true);
    setError('');
    try {
      await mutate('tasks.retry', { id: task.id });
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="grid min-w-0 max-w-full grid-cols-1 gap-5">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Avatar small bot={bot} name={bot?.name || '任务'} />
          <span className="text-sm font-medium">{bot?.name || '智能体'}</span>
        </div>
        <Badge status={task.status}>
          {currentActivityLabel(task, latestRun) ?? taskRecordStatus(task, processes)}
        </Badge>
      </div>
      <div>
        <h3 className="line-clamp-2 [overflow-wrap:anywhere] text-pretty text-sm font-semibold leading-6">
          {recordTaskTitle(task)}
        </h3>
        <p className="mt-3 text-xs tabular-nums text-slate-400">{timeLabel(task.createdAt)}</p>
        {!task.requirement && (
          <details className="mt-3 text-xs text-slate-500">
            <summary className="cursor-pointer">任务要求</summary>
            <p className="mt-2 whitespace-pre-wrap [overflow-wrap:anywhere] text-pretty leading-6">
              {task.goal}
            </p>
            {task.expectedOutput && (
              <p className="mt-2 whitespace-pre-wrap [overflow-wrap:anywhere] text-pretty leading-6">
                预期成果：{task.expectedOutput}
              </p>
            )}
          </details>
        )}
      </div>
      <section className="min-w-0 rounded-xl border border-slate-200 bg-white p-4">
        <h4 className="text-sm font-semibold text-slate-700">工作概览</h4>
        <TaskWorkOverview task={task} data={data} />
      </section>
      <TaskActivityDetails key={task.id} task={task} run={latestRun} mutate={mutate} />
      <RequirementDetails task={task} />
      {task.error && (
        <div className="rounded-lg bg-red-50 p-3 text-sm text-red-700">
          <p className="mb-1 font-medium">任务错误</p>
          <p className="text-pretty [overflow-wrap:anywhere] leading-6">{task.error}</p>
        </div>
      )}
      {task.reconciliationRequired && (
        <div className="rounded-lg bg-amber-50 p-3 text-xs leading-5 text-amber-800">
          <p>操作结果未知。请先核查外部系统或目标文件，再确认实际结果。</p>
          <div className="mt-3 flex flex-wrap gap-2">
            <Confirm
              title="已核查任务完成？"
              description="此确认会将任务标记为完成。"
              actionLabel="确认完成"
              onConfirm={() => mutate('tasks.reconcile', { id: task.id, outcome: 'succeeded' })}
            >
              <Button>
                <Check size={14} />
                已核查完成
              </Button>
            </Confirm>
            <Confirm
              title="已核查操作未执行？"
              description="此确认会解除重试限制。重试将重新执行任务。"
              actionLabel="确认未执行"
              onConfirm={() => mutate('tasks.reconcile', { id: task.id, outcome: 'not_executed' })}
            >
              <Button>确认未执行</Button>
            </Confirm>
          </div>
        </div>
      )}
      <div className="flex gap-2">
        {task.status === 'waiting_input' && task.coordinationPaused && (
          <Button disabled={busy || !!retryBlocker} onClick={() => void retry()}>
            <RotateCcw size={14} />
            {busy ? '继续中…' : '继续处理'}
          </Button>
        )}
        {activeTask(task.status) && !stopping && (
          <Confirm
            title="停止此任务？"
            description="任务及其子任务将收到取消请求，已生成的成果会保留。"
            actionLabel="停止任务"
            onConfirm={() => mutate('tasks.cancel', { id: task.id })}
          >
            <Button>
              <Square size={13} />
              停止
            </Button>
          </Confirm>
        )}
        {stopping && (
          <Button disabled>
            <Square size={13} />
            停止处理中…
          </Button>
        )}
        {!task.reconciliationRequired &&
          ['failed', 'interrupted', 'cancelled'].includes(task.status) && (
            <Button disabled={busy || !!retryBlocker} onClick={() => void retry()}>
              <RotateCcw size={14} />
              {busy ? '恢复中…' : '继续原任务'}
            </Button>
          )}
      </div>
      {canContinue && retryBlocker && (
        <div className="rounded-lg bg-amber-50 p-3 text-xs leading-5 text-amber-800">
          <p>
            {retryBlocker.reason === 'reconciliation'
              ? '请先核查以下成员任务的外部操作结果，再继续。'
              : '请等待以下成员任务结束，再继续。'}
          </p>
          <ul className="mt-2 grid gap-1">
            {retryBlocker.tasks.map((child) => (
              <li key={child.id} className="[overflow-wrap:anywhere]">
                {onSelect ? (
                  <button className="text-left underline" onClick={() => onSelect(child.id)}>
                    {data.bots.find((item) => item.id === child.botId)?.name ?? '成员'}：
                    {recordTaskTitle(child)}
                  </button>
                ) : (
                  <span>
                    {data.bots.find((item) => item.id === child.botId)?.name ?? '成员'}：
                    {recordTaskTitle(child)}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
      <ErrorNote error={error} />
      {approvals.map((item) => (
        <ApprovalCard key={item.id} approval={item} data={data} mutate={mutate} />
      ))}
      {questions.map((item) => (
        <UserQuestionCard key={item.id} question={item} data={data} mutate={mutate} />
      ))}
      {!!children.length && (
        <section>
          <h4 className="mb-3 flex items-center gap-2 text-xs font-semibold text-slate-500">
            <Activity size={14} />
            成员任务
          </h4>
          <div className="grid gap-2">
            {children.map((item) => (
              <button
                key={item.id}
                className="flex items-center gap-2 rounded-lg border border-slate-200 bg-white p-3 text-left hover:bg-slate-50"
                onClick={() => onSelect?.(item.id)}
              >
                <Avatar small bot={data.bots.find((bot) => bot.id === item.botId)} />
                <div className="min-w-0 flex-1">
                  <p className="mb-1 truncate text-xs font-medium text-slate-800">
                    {data.bots.find((bot) => bot.id === item.botId)?.name ?? '成员'}
                  </p>
                  <p className="mb-2 line-clamp-2 text-pretty text-xs leading-5 text-slate-700">
                    {recordTaskTitle(item)}
                  </p>
                  <Badge status={item.status}>{taskRecordStatus(item, data.processes ?? [])}</Badge>
                </div>
                <ChevronRight size={14} className="text-slate-400" />
              </button>
            ))}
          </div>
        </section>
      )}
      {task.result && (
        <details className="min-w-0 rounded-xl border border-slate-200 bg-white p-4">
          <summary className="cursor-pointer text-sm font-medium text-slate-700">交付说明</summary>
          <div className="mt-3 min-w-0 text-sm leading-6 text-slate-700">
            <Markdown>{task.result}</Markdown>
          </div>
        </details>
      )}
      {!!artifacts.length && (
        <section>
          <h4 className="mb-3 flex items-center gap-2 text-xs font-semibold text-slate-500">
            <FileText size={14} />
            成果
          </h4>
          <div className="grid gap-2">
            {artifacts.map((item) => (
              <ArtifactItem
                key={item.id}
                artifact={item}
                reviewConversations={data.conversations}
                mutate={mutate}
                dense
              />
            ))}
          </div>
        </section>
      )}
      {!!runs.length && (
        <section
          aria-label="工作过程"
          className="min-w-0 rounded-xl border border-slate-200 bg-white p-4"
        >
          <h4 className="mb-3 text-sm font-medium text-slate-700">工作过程</h4>
          <div className="grid min-w-0 gap-3">
            {runs.map((run) => (
              <RunRecords
                key={run.id}
                run={run}
                task={task}
                recent={data.events}
                defaultOpen={run.id === latestRun?.id}
              />
            ))}
          </div>
        </section>
      )}
      {!!processes.length && (
        <details className="min-w-0 rounded-xl border border-slate-200 bg-white p-4">
          <summary className="cursor-pointer text-sm font-medium text-slate-700">
            技术详情 · 命令参数与输出
          </summary>
          <div className="mt-3">
            <CommandRecords processes={processes} />
          </div>
        </details>
      )}
    </div>
  );
}
