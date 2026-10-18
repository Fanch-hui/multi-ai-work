import { useState, type FormEvent } from 'react';
import { ArrowRight, FolderPlus } from 'lucide-react';
import type { Connection, Snapshot, Workspace } from '../../../src/domain/types.js';
import { DEFAULT_COMPACTION_THRESHOLD } from '../../../src/domain/context-settings.js';
import type { Mutate } from './store.js';
import { Button, ErrorNote, Field, inputClass } from './components.js';
import { choosePath, errorMessage } from './api.js';
import { ContextBudgetFields } from './ContextBudgetFields.js';
import { ReasoningField } from './ReasoningField.js';
import { isReasoningSupported } from '../../../src/domain/model-reasoning.js';

export function OnboardingProfile({ data, connection, mutate, busy, onSubmit }: {
  data: Snapshot; connection: Connection; mutate: Mutate; busy: boolean;
  onSubmit: (input: Record<string, unknown>) => Promise<void>;
}) {
  const chief = data.bots.find(bot => bot.id === data.settings.mainBotId);
  const [name, setName] = useState(chief?.name || 'Chief');
  const [model, setModel] = useState('');
  const [reasoning, setReasoning] = useState('');
  const [contextWindow, setContextWindow] = useState(chief?.contextWindow?.toString() || '');
  const [compactionThreshold, setCompactionThreshold] = useState(String(chief?.compactionThreshold ?? DEFAULT_COMPACTION_THRESHOLD));
  const [workspaceId, setWorkspace] = useState(data.workspaces[0]?.id || '');
  const [choosing, setChoosing] = useState(false);
  const [error, setError] = useState('');
  const modelInfo = connection.models.find(item => item.id === model);
  const selectedReasoning = isReasoningSupported(connection.provider, modelInfo, reasoning) ? reasoning : '';
  async function addDirectory() {
    setChoosing(true); setError('');
    try {
      const path = await choosePath('directory');
      if (!path) return;
      const workspace = await mutate<Workspace>('workspaces.add', {
        name: path.split(/[\\/]/).filter(Boolean).at(-1) || '工作目录', path, writable: true,
      });
      setWorkspace(workspace.id);
    } catch (cause) { setError(errorMessage(cause)); }
    finally { setChoosing(false); }
  }
  function submit(event: FormEvent) {
    event.preventDefault();
    void onSubmit({ name, connectionId: connection.id, model, reasoning: selectedReasoning, workspaceId,
      contextWindow: contextWindow ? Number(contextWindow) : undefined, compactionThreshold: Number(compactionThreshold) });
  }
  return <form onSubmit={submit} className="grid gap-4">
    <fieldset disabled={busy || choosing} className="grid min-w-0 gap-4">
      <Field label="管家的名字"><input autoComplete="off" className={inputClass} required maxLength={120} value={name} onChange={event => setName(event.target.value)} /></Field>
      <Field label="模型">{connection.models.length ? <select className={inputClass} required value={model} onChange={event => { setModel(event.target.value); setReasoning(''); }}>
        <option value="">选择一个模型</option>{connection.models.map(item => <option key={item.id} value={item.id}>{item.name || item.id}</option>)}
      </select> : <input className={inputClass} required placeholder="输入服务支持的模型 ID" value={model} onChange={event => { setModel(event.target.value); setReasoning(''); }} />}</Field>
      <ReasoningField provider={connection.provider} model={modelInfo} value={reasoning} onChange={setReasoning} />
      <div className="grid items-start gap-4 sm:grid-cols-2"><ContextBudgetFields provider={connection.provider}
        model={modelInfo} contextWindow={contextWindow} onContextWindowChange={setContextWindow}
        compactionThreshold={compactionThreshold} onCompactionThresholdChange={setCompactionThreshold} /></div>
      <Field label="工作目录" hint="管家在这里处理资料并保存成果。"><div className="flex gap-2">
        <select className={inputClass} required value={workspaceId} onChange={event => setWorkspace(event.target.value)}>
          {data.workspaces.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
        </select><Button type="button" className="size-10 shrink-0 p-0" aria-label="选择工作目录" onClick={() => void addDirectory()}><FolderPlus size={17} /></Button>
      </div></Field>
      <p className="-mt-2 break-all text-xs text-slate-400">{data.workspaces.find(item => item.id === workspaceId)?.path}</p>
    </fieldset>
    <ErrorNote error={error} />
    <Button variant="primary" className="mt-1 h-10" disabled={busy || choosing || !name.trim() || !model.trim() || !workspaceId}>
      {busy ? '正在准备…' : '继续'}{!busy && <ArrowRight size={16} />}
    </Button>
  </form>;
}
