import { useState } from 'react';
import type { Bot, Snapshot } from '../../../../src/domain/types.js';
import type { PresetInstallation } from '../../../../src/domain/market.js';
import { errorMessage } from '../api.js';
import { Button, ErrorNote, Modal, activeTask, Field, inputClass } from '../components.js';
import type { Mutate } from '../store.js';

export function UpdatePreset({
  installation,
  previous,
  bots,
  data,
  mutate,
  close,
  applied,
}: {
  installation: PresetInstallation;
  previous: PresetInstallation[];
  bots: Bot[];
  data: Snapshot;
  mutate: Mutate;
  close: () => void;
  applied: () => void;
}) {
  const [comparison, setComparison] = useState(previous[0]?.id || '');
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [results, setResults] = useState<{ botId: string; error?: string }[]>([]);
  async function apply() {
    setBusy(true);
    setError('');
    try {
      const result = await mutate<{ botId: string; error?: string }[]>('market.update', {
        installationId: installation.id,
        botIds: selected,
      });
      setResults(result);
      setSelected(result.filter((item) => item.error).map((item) => item.botId));
      applied();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }
  const before = previous.find((item) => item.id === comparison)?.preset;
  const after = installation.preset;
  return (
    <Modal
      open
      title={`更新 ${after.name}`}
      onOpenChange={(open) => !open && !busy && close()}
      description={`应用版本 ${after.version}，个人配置、补充要求与记忆继续保留。`}
      wide
    >
      <p className="text-sm leading-6 text-slate-500">
        {after.releaseNotes || '更新岗位指令和配套技能。'}
      </p>
      {previous.length > 1 && (
        <div className="mt-4">
          <Field label="对比已使用版本">
            <select
              className={inputClass}
              value={comparison}
              onChange={(event) => setComparison(event.target.value)}
            >
              {previous.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.preset.version}
                </option>
              ))}
            </select>
          </Field>
        </div>
      )}
      <div className="my-5 grid gap-3 sm:grid-cols-2">
        {[
          { title: '当前版本', preset: before },
          { title: '新版本', preset: after },
        ].map((column) => (
          <div key={column.title} className="min-w-0 rounded-xl bg-slate-50 p-4">
            <h3 className="text-sm font-medium">
              {column.title} {column.preset?.version}
            </h3>
            <p className="mt-2 text-xs leading-5 text-slate-500">
              {column.preset?.role || '当前成员职责'}
            </p>
            <p className="mt-2 text-xs leading-5 text-slate-500">
              技能：{column.preset?.skills.map((skill) => skill.name).join('、') || '参见成员配置'}
            </p>
            <p className="mt-2 text-xs leading-5 text-slate-500">
              依赖：
              {column.preset?.dependencies.map((item) => item.label).join('、') || '无额外依赖'}
            </p>
            <details className="mt-3 text-xs">
              <summary className="cursor-pointer">工作指令</summary>
              <p className="mt-2 whitespace-pre-wrap leading-5 text-slate-600">
                {column.preset?.instructions || bots[0]?.preset?.baseInstructions}
              </p>
            </details>
          </div>
        ))}
      </div>
      <div className="grid gap-3">
        {bots.map((bot) => {
          const running = data.tasks.some(
            (task) => task.botId === bot.id && activeTask(task.status),
          );
          const result = results.find((item) => item.botId === bot.id);
          return (
            <label key={bot.id} className="flex items-start gap-3 text-sm text-slate-700">
              <input
                className="mt-1"
                type="checkbox"
                disabled={busy || running || (!!result && !result.error)}
                checked={selected.includes(bot.id)}
                onChange={(event) =>
                  setSelected((values) =>
                    event.target.checked
                      ? [...values, bot.id]
                      : values.filter((id) => id !== bot.id),
                  )
                }
              />
              <span>
                {bot.name}
                <span className="ml-2 text-xs text-slate-400">
                  {bot.preset?.version} → {after.version}
                  {running ? ' · 请先结束当前任务' : ''}
                  {result && !result.error ? ' · 已更新' : ''}
                </span>
                {result?.error && (
                  <span role="alert" className="mt-1 block text-xs text-red-600">
                    {result.error}
                  </span>
                )}
              </span>
            </label>
          );
        })}
      </div>
      <div className="mt-4">
        <ErrorNote error={error} />
      </div>
      <div className="mt-5 flex justify-end gap-2">
        <Button disabled={busy} onClick={close}>
          关闭
        </Button>
        <Button variant="primary" disabled={busy || !selected.length} onClick={() => void apply()}>
          {busy ? '更新中…' : '应用到所选成员'}
        </Button>
      </div>
    </Modal>
  );
}
