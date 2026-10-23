import { useRef, useState } from 'react';
import { CalendarClock, Plus } from 'lucide-react';
import type { Routine, RoutineOccurrence } from '../../../../src/domain/routines.js';
import type { Snapshot, Task } from '../../../../src/domain/types.js';
import type { Mutate } from '../store.js';
import { errorMessage } from '../api.js';
import { Badge, Button, Empty, ErrorNote, Modal, timeLabel } from '../components.js';
import { useResource } from './useResource.js';
import { RoutineEditor } from './RoutineEditor.js';

export function routineScheduleLabel(routine: Routine) {
  if (routine.schedule.kind === 'once') return `指定时间 · ${timeLabel(routine.schedule.at)}`;
  const days = ['日', '一', '二', '三', '四', '五', '六'];
  const frequency =
    routine.schedule.kind === 'daily'
      ? '每日'
      : `每周${routine.schedule.weekdays.map((day) => days[day]).join('、')}`;
  return `${frequency} ${routine.schedule.time} · ${routine.timeZone}`;
}

export function Routines({
  data,
  mutate,
  close,
  onSelectConversation,
}: {
  data: Snapshot;
  mutate: Mutate;
  close: () => void;
  onSelectConversation: (id: string) => void;
}) {
  const resource = useResource<Routine[]>('routines.list');
  const [editing, setEditing] = useState<Routine | 'new'>();
  const [history, setHistory] = useState<Routine>();
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const action = useRef(false);
  const requestIds = useRef(new Map<string, string>());
  async function execute(routine: Routine, method: 'routines.setEnabled' | 'routines.runNow') {
    if (action.current) return;
    action.current = true;
    setBusy(routine.id);
    setError('');
    const key = `${method}:${routine.id}`;
    const requestId = requestIds.current.get(key) ?? crypto.randomUUID();
    requestIds.current.set(key, requestId);
    try {
      await mutate(method, { id: routine.id, enabled: !routine.enabled, requestId });
      requestIds.current.delete(key);
      resource.reload();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      action.current = false;
      setBusy('');
    }
  }
  return (
    <>
      <Modal
        open
        onOpenChange={(open) => {
          if (!open) close();
        }}
        title="例行工作"
        wide
      >
        <div className="mb-4 flex items-center justify-between gap-3">
          <p className="text-sm text-slate-500">按时执行，结果保存在专属对话。</p>
          <Button onClick={() => setEditing('new')}>
            <Plus size={15} />
            新建
          </Button>
        </div>
        <ErrorNote error={resource.error || error} />
        {resource.loading && !resource.value && (
          <p role="status" className="py-6 text-sm text-slate-500">
            读取例行工作…
          </p>
        )}
        {resource.value?.length === 0 && (
          <Empty title="安排一项持续工作" description="让团队定期整理资料、生成报告或跟进项目。" />
        )}
        <div className="space-y-3">
          {resource.value?.map((routine) => (
            <article key={routine.id} className="rounded-xl border border-slate-200 p-4">
              <div className="flex items-center gap-2">
                <CalendarClock size={16} className="text-blue-500" />
                <h3 className="min-w-0 flex-1 truncate text-sm font-semibold">{routine.name}</h3>
                <span className="text-xs text-slate-500">
                  {routine.enabled ? '已启用' : '已暂停'}
                </span>
              </div>
              <p className="mt-2 text-xs leading-5 text-slate-500">
                {data.bots.find((bot) => bot.id === routine.botId)?.name ?? '负责人已失效'} ·{' '}
                {routineScheduleLabel(routine)}
              </p>
              <p className="mt-1 text-xs text-slate-500">
                {routine.nextRunAt
                  ? `下次执行：${timeLabel(routine.nextRunAt)}`
                  : '暂无后续执行时间'}
                {routine.pendingAt && ' · 等待上一轮结束后补跑'}
              </p>
              <ErrorNote error={routine.error} />
              <div className="mt-3 flex flex-wrap gap-2">
                <Button disabled={!!busy} onClick={() => void execute(routine, 'routines.runNow')}>
                  {busy === routine.id ? '处理中…' : '立即执行'}
                </Button>
                <Button
                  disabled={!!busy}
                  onClick={() => void execute(routine, 'routines.setEnabled')}
                >
                  {routine.enabled ? '暂停' : '启用'}
                </Button>
                <Button onClick={() => setEditing(routine)}>编辑</Button>
                <Button onClick={() => setHistory(routine)}>运行历史</Button>
                <Button
                  variant="ghost"
                  onClick={() => {
                    close();
                    onSelectConversation(routine.conversationId);
                  }}
                >
                  查看对话
                </Button>
              </div>
            </article>
          ))}
        </div>
      </Modal>
      {editing && (
        <RoutineEditor
          key={editing === 'new' ? 'new' : editing.id}
          routine={editing === 'new' ? undefined : editing}
          data={data}
          mutate={mutate}
          close={() => setEditing(undefined)}
          saved={resource.reload}
        />
      )}
      {history && <RoutineHistory routine={history} close={() => setHistory(undefined)} />}
    </>
  );
}
function RoutineHistory({ routine, close }: { routine: Routine; close: () => void }) {
  const resource = useResource<(RoutineOccurrence & { task?: Task })[]>('routines.history', {
    id: routine.id,
  });
  return (
    <Modal
      open
      onOpenChange={(open) => {
        if (!open) close();
      }}
      title={`${routine.name} · 运行历史`}
    >
      <ErrorNote error={resource.error} />
      {resource.loading && !resource.value && (
        <p role="status" className="text-sm text-slate-500">
          读取历史…
        </p>
      )}
      {resource.value?.length === 0 && <p className="text-sm text-slate-500">尚未执行。</p>}
      <ol className="space-y-3">
        {resource.value?.map((item) => (
          <li key={item.id} className="rounded-lg border border-slate-200 p-3">
            <div className="flex items-center justify-between gap-2">
              <span className="text-sm">{timeLabel(item.scheduledAt)}</span>
              {item.task && <Badge status={item.task.status} />}
            </div>
            <p className="mt-1 text-xs text-slate-500">
              {item.source === 'manual' ? '手动执行' : '定时执行'} · 规则版本 {item.revision}
            </p>
            {item.reason && <p className="mt-2 text-xs text-amber-700">{item.reason}</p>}
          </li>
        ))}
      </ol>
    </Modal>
  );
}
