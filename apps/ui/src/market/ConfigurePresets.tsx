import { useState, type FormEvent } from 'react';
import type { Snapshot } from '../../../../src/domain/types.js';
import type { PresetInstallation, PresetMemberResult } from '../../../../src/domain/market.js';
import type { Mutate } from '../store.js';
import { errorMessage } from '../api.js';
import { Button, ErrorNote, Modal, cn } from '../components.js';
import { MemberConfiguration } from './MemberConfiguration.js';
import { initialMemberSettings, memberRequestConfiguration, shareMemberSettings, type PresetMemberDraft } from './memberSettings.js';

export function ConfigurePresets({ installations, data, mutate, close, created, configureConnection }: {
  installations: PresetInstallation[]; data: Snapshot; mutate: Mutate; close: () => void;
  created: () => void; configureConnection: () => void;
}) {
  const [ids] = useState(() => Object.fromEntries(installations.map(item => [item.id, crypto.randomUUID()])));
  const [configurations, setConfigurations] = useState<Record<string, PresetMemberDraft>>(() => Object.fromEntries(
    installations.map(item => [item.id, initialMemberSettings(item.preset)])));
  const [activeId, setActiveId] = useState(installations[0]?.id);
  const [results, setResults] = useState<PresetMemberResult[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const succeeded = (id: string) => results.find(item => item.requestId === ids[id])?.botId;
  const remaining = installations.filter(item => !succeeded(item.id));
  const active = remaining.find(item => item.id === activeId) || remaining[0];
  const valid = remaining.every(item => {
    const value = configurations[item.id];
    const connection = data.connections.find(entry => entry.id === value.connectionId && entry.status === 'ready');
    return !!value.name?.trim() && !!value.role?.trim() && !!connection && !!value.model.trim()
      && (!connection.models.length || connection.models.some(model => model.id === value.model));
  });
  async function submit(event: FormEvent) {
    event.preventDefault(); if (!valid || busy || !remaining.length) return;
    setBusy(true); setError('');
    try {
      const next = await mutate<PresetMemberResult[]>('market.members.create', { items: remaining.map(item => ({
        requestId: ids[item.id], installationId: item.id, configuration: memberRequestConfiguration(configurations[item.id]) })) });
      setResults(values => [...values.filter(value => !next.some(item => item.requestId === value.requestId)), ...next]);
      created();
      if (next.every(item => item.botId)) close();
    } catch (cause) { setError(errorMessage(cause)); }
    finally { setBusy(false); }
  }
  return <Modal open onOpenChange={open => !open && !busy && close()} title={installations.length === 1 ? `雇佣 ${installations[0].preset.name}` : `雇佣 ${installations.length} 位成员`} wide>
    <form noValidate className="grid gap-5" onSubmit={event => void submit(event)}>
      {remaining.length > 1 && <div className="flex flex-wrap gap-2" aria-label="选择要配置的成员">
        {remaining.map(item => <Button type="button" key={item.id} disabled={busy} aria-pressed={active?.id === item.id}
          className={cn(active?.id === item.id && 'border-blue-200 bg-blue-50 text-blue-700')} onClick={() => setActiveId(item.id)}>{item.preset.name}</Button>)}
      </div>}
      {active && <fieldset disabled={busy} className="grid min-w-0 gap-4">
        <MemberConfiguration key={active.id} data={data} value={configurations[active.id]} includeName mutate={mutate} preset={active.preset}
          change={fields => setConfigurations(values => ({ ...values, [active.id]: { ...values[active.id], ...fields } }))} />
        {remaining.length > 1 && <Button type="button" className="justify-self-start" onClick={() => setConfigurations(values =>
          Object.fromEntries(Object.entries(values).map(([id, value]) => [id, remaining.some(item => item.id === id)
            ? shareMemberSettings(value, values[active.id]) : value])))}>将当前模型与权限用于其他成员</Button>}
        {active.preset.dependencies.some(dependency => dependency.required) && <p className="text-xs text-slate-500">必需能力：{active.preset.dependencies.filter(dependency => dependency.required).map(dependency => dependency.label).join('、')}</p>}
      </fieldset>}
      {!data.connections.some(item => item.status === 'ready') && <div className="flex items-center justify-between rounded-lg bg-slate-50 p-3 text-sm text-slate-500">
        先添加并检测模型连接。<Button type="button" onClick={() => { close(); configureConnection(); }}>添加连接</Button>
      </div>}
      {results.length > 0 && <div className="grid gap-2 text-sm">{installations.map(item => {
        const result = results.find(value => value.requestId === ids[item.id]);
        return result && <p key={item.id} className={result.error ? 'text-red-600' : 'text-blue-700'} role={result.error ? 'alert' : undefined}>
          {item.preset.name} · {result.error || '已加入团队'}
        </p>;
      })}</div>}
      <ErrorNote error={error} />
      <div className="flex justify-end gap-2"><Button type="button" disabled={busy} onClick={close}>{remaining.length ? '取消' : '完成'}</Button>
        {!!remaining.length && <Button variant="primary" disabled={busy || !valid}>{busy ? '雇佣中…' : results.length ? '重试未完成成员' : installations.length === 1 ? '完成雇佣' : `雇佣 ${remaining.length} 位成员`}</Button>}
      </div>
    </form>
  </Modal>;
}
