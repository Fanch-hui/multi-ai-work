import { useRef, useState, type FormEvent } from 'react';
import type { Routine, RoutineSchedule } from '../../../../src/domain/routines.js';
import type { Snapshot } from '../../../../src/domain/types.js';
import type { Mutate } from '../store.js';
import { errorMessage } from '../api.js';
import { Button, ErrorNote, Field, inputClass, Modal } from '../components.js';

export function RoutineEditor({
  routine,
  data,
  mutate,
  close,
  saved,
}: {
  routine?: Routine;
  data: Snapshot;
  mutate: Mutate;
  close: () => void;
  saved: () => void;
}) {
  const localZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const initialDate =
    routine?.schedule.kind === 'once'
      ? new Date(routine.schedule.at)
      : new Date(Date.now() + 3_600_000);
  const localDate = new Date(initialDate.getTime() - initialDate.getTimezoneOffset() * 60_000)
    .toISOString()
    .slice(0, 16);
  const [name, setName] = useState(routine?.name ?? '');
  const [botId, setBotId] = useState(routine?.botId ?? data.settings.mainBotId ?? '');
  const [workspaceId, setWorkspaceId] = useState(
    routine?.workspaceId ?? data.workspaces[0]?.id ?? '',
  );
  const [goal, setGoal] = useState(routine?.goal ?? '');
  const [expectedOutput, setExpectedOutput] = useState(routine?.expectedOutput ?? '');
  const [kind, setKind] = useState<RoutineSchedule['kind']>(routine?.schedule.kind ?? 'weekly');
  const [at, setAt] = useState(localDate);
  const [time, setTime] = useState(
    routine?.schedule.kind !== 'once' ? (routine?.schedule.time ?? '09:00') : '09:00',
  );
  const [weekdays, setWeekdays] = useState(
    routine?.schedule.kind === 'weekly' ? routine.schedule.weekdays : [1],
  );
  const [timeZone, setTimeZone] = useState(routine?.timeZone ?? localZone);
  const [missedRunPolicy, setMissedRunPolicy] = useState(routine?.missedRunPolicy ?? 'latest');
  const [inputs, setInputs] = useState(routine?.inputArtifactIds ?? []);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const submitting = useRef(false);
  const availableInputs = data.artifacts.filter(
    (artifact) =>
      inputs.includes(artifact.id) ||
      (artifact.purpose !== 'intermediate' &&
        !artifact.superseded &&
        data.conversations.some(
          (room) => room.id === artifact.conversationId && room.memberIds.includes(botId),
        )),
  );
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (submitting.current) return;
    submitting.current = true;
    setBusy(true);
    setError('');
    try {
      let schedule: RoutineSchedule = { kind: 'daily', time };
      if (kind === 'once') schedule = { kind, at: new Date(at).toISOString() };
      if (kind === 'weekly') schedule = { kind, time, weekdays };
      await mutate('routines.save', {
        input: {
          id: routine?.id,
          name,
          botId,
          workspaceId,
          goal,
          expectedOutput,
          inputArtifactIds: inputs,
          schedule,
          timeZone: kind === 'once' ? localZone : timeZone,
          missedRunPolicy,
          enabled: routine?.enabled ?? true,
        },
      });
      saved();
      close();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }
  return (
    <Modal
      open
      onOpenChange={(open) => {
        if (!open && !busy) close();
      }}
      title={routine ? '编辑例行工作' : '新建例行工作'}
      wide
    >
      <form onSubmit={(event) => void submit(event)} className="grid gap-4">
        <Field label="名称">
          <input
            required
            value={name}
            onChange={(event) => setName(event.target.value)}
            className={inputClass}
          />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label="负责人"
            hint={routine ? '负责人固定；其他成员的工作请新建例行工作。' : undefined}
          >
            <select
              required
              disabled={!!routine}
              value={botId}
              onChange={(event) => {
                setBotId(event.target.value);
                setInputs([]);
              }}
              className={inputClass}
            >
              <option value="">选择成员</option>
              {data.bots
                .filter((bot) => !bot.archived || bot.id === botId)
                .map((bot) => (
                  <option key={bot.id} value={bot.id}>
                    {bot.name}
                  </option>
                ))}
            </select>
          </Field>
          <Field label="工作区">
            <select
              required
              disabled={!!routine}
              value={workspaceId}
              onChange={(event) => setWorkspaceId(event.target.value)}
              className={inputClass}
            >
              <option value="">选择工作区</option>
              {data.workspaces.map((workspace) => (
                <option key={workspace.id} value={workspace.id}>
                  {workspace.name}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <Field label="工作目标">
          <textarea
            required
            rows={3}
            value={goal}
            onChange={(event) => setGoal(event.target.value)}
            className={inputClass}
          />
        </Field>
        <Field label="交付要求">
          <textarea
            rows={2}
            value={expectedOutput}
            onChange={(event) => setExpectedOutput(event.target.value)}
            className={inputClass}
          />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="执行规则">
            <select
              value={kind}
              onChange={(event) => setKind(event.target.value as RoutineSchedule['kind'])}
              className={inputClass}
            >
              <option value="once">指定时间 / 延后执行</option>
              <option value="daily">每日</option>
              <option value="weekly">每周</option>
            </select>
          </Field>
          {kind === 'once' ? (
            <Field label="执行时间" hint={`按本机时区 ${localZone} 输入。`}>
              <input
                required
                type="datetime-local"
                value={at}
                onChange={(event) => setAt(event.target.value)}
                className={inputClass}
              />
            </Field>
          ) : (
            <Field label="执行时间">
              <input
                required
                type="time"
                value={time}
                onChange={(event) => setTime(event.target.value)}
                className={inputClass}
              />
            </Field>
          )}
        </div>
        {kind === 'weekly' && (
          <fieldset>
            <legend className="mb-2 text-sm font-medium text-slate-700">每周执行日</legend>
            <div className="flex flex-wrap gap-3">
              {['日', '一', '二', '三', '四', '五', '六'].map((day, index) => (
                <label key={day} className="flex items-center gap-1.5 text-sm">
                  <input
                    type="checkbox"
                    checked={weekdays.includes(index)}
                    onChange={(event) =>
                      setWeekdays(
                        event.target.checked
                          ? [...weekdays, index].sort()
                          : weekdays.filter((value) => value !== index),
                      )
                    }
                  />
                  周{day}
                </label>
              ))}
            </div>
          </fieldset>
        )}
        {kind !== 'once' && (
          <Field label="时区" hint="使用 IANA 时区，例如 Asia/Shanghai 或 America/New_York。">
            <input
              required
              value={timeZone}
              onChange={(event) => setTimeZone(event.target.value)}
              className={inputClass}
            />
          </Field>
        )}
        <Field label="电脑休眠或退出期间错过执行">
          <select
            value={missedRunPolicy}
            onChange={(event) => setMissedRunPolicy(event.target.value as 'latest' | 'skip')}
            className={inputClass}
          >
            <option value="latest">恢复后合并补跑最近一次</option>
            <option value="skip">跳过错过的执行</option>
          </select>
        </Field>
        <details className="rounded-lg border border-slate-200 p-3">
          <summary className="cursor-pointer text-sm text-slate-600">
            输入资料 · {inputs.length} 份
          </summary>
          <div className="mt-3 max-h-40 space-y-2 overflow-y-auto">
            {availableInputs.map((artifact) => (
              <label key={artifact.id} className="flex items-center gap-2 text-xs text-slate-600">
                <input
                  type="checkbox"
                  checked={inputs.includes(artifact.id)}
                  disabled={!inputs.includes(artifact.id) && inputs.length >= 50}
                  onChange={(event) =>
                    setInputs(
                      event.target.checked
                        ? [...inputs, artifact.id]
                        : inputs.filter((id) => id !== artifact.id),
                    )
                  }
                />
                {artifact.name}
              </label>
            ))}
          </div>
        </details>
        <p className="text-xs leading-5 text-slate-500">
          关闭窗口后可在托盘继续运行；电脑休眠或 App 退出后暂停执行。
        </p>
        <ErrorNote error={error} />
        <div className="flex justify-end gap-2">
          <Button type="button" disabled={busy} onClick={close}>
            取消
          </Button>
          <Button
            type="submit"
            variant="primary"
            disabled={busy || (kind === 'weekly' && !weekdays.length)}
          >
            {busy ? '保存中…' : '保存'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
