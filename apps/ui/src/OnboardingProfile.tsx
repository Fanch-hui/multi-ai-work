import { useState, type FormEvent } from 'react';
import { ArrowRight } from 'lucide-react';
import type { Connection, Snapshot } from '../../../src/domain/types.js';
import { DEFAULT_COMPACTION_THRESHOLD } from '../../../src/domain/context-settings.js';
import type { Mutate } from './store.js';
import { Button, ErrorNote, Field, inputClass } from './components.js';
import { AvatarPicker } from './AvatarPicker.js';
import { ContextBudgetFields } from './ContextBudgetFields.js';
import { ReasoningField } from './ReasoningField.js';
import { isReasoningSupported } from '../../../src/domain/model-reasoning.js';

export function OnboardingProfile({
  data,
  connection,
  mutate,
  busy,
  onSubmit,
}: {
  data: Snapshot;
  connection: Connection;
  mutate: Mutate;
  busy: boolean;
  onSubmit: (input: Record<string, unknown>) => Promise<void>;
}) {
  const chief = data.bots.find((bot) => bot.id === data.settings.mainBotId);
  const [name, setName] = useState(chief?.name || 'Chief');
  const [avatar, setAvatar] = useState(chief?.avatar || 'owl');
  const [model, setModel] = useState('');
  const [reasoning, setReasoning] = useState('');
  const [contextWindow, setContextWindow] = useState(chief?.contextWindow?.toString() || '');
  const [compactionThreshold, setCompactionThreshold] = useState(
    String(chief?.compactionThreshold ?? DEFAULT_COMPACTION_THRESHOLD),
  );
  const [error, setError] = useState('');
  const modelInfo = connection.models.find((item) => item.id === model);
  const reasoningSupported = isReasoningSupported(connection.provider, modelInfo, reasoning);
  function submit(event: FormEvent) {
    event.preventDefault();
    if (!reasoningSupported) {
      setError('当前推理强度不受所选模型支持。请选择默认或有效档位后继续。');
      return;
    }
    void onSubmit({
      name,
      avatar,
      connectionId: connection.id,
      model,
      reasoning,
      workspaceId: data.settings.defaultWorkspaceId,
      contextWindow: contextWindow ? Number(contextWindow) : undefined,
      compactionThreshold: Number(compactionThreshold),
    });
  }
  return (
    <form onSubmit={submit} className="grid gap-4">
      <fieldset disabled={busy} className="grid min-w-0 gap-4">
        <AvatarPicker value={avatar} onChange={setAvatar} mutate={mutate} />
        <Field label="管家的名字">
          <input
            autoComplete="off"
            className={inputClass}
            required
            maxLength={120}
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </Field>
        <Field label="模型">
          {connection.models.length ? (
            <select
              className={inputClass}
              required
              value={model}
              onChange={(event) => {
                setModel(event.target.value);
                setReasoning('');
              }}
            >
              <option value="">选择一个模型</option>
              {connection.models.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name || item.id}
                </option>
              ))}
            </select>
          ) : (
            <input
              className={inputClass}
              required
              placeholder="输入服务支持的模型 ID"
              value={model}
              onChange={(event) => {
                setModel(event.target.value);
                setReasoning('');
              }}
            />
          )}
        </Field>
        <ReasoningField
          provider={connection.provider}
          model={modelInfo}
          value={reasoning}
          onChange={setReasoning}
        />
        <div className="grid items-start gap-4 sm:grid-cols-2">
          <ContextBudgetFields
            provider={connection.provider}
            model={modelInfo}
            contextWindow={contextWindow}
            onContextWindowChange={setContextWindow}
            compactionThreshold={compactionThreshold}
            onCompactionThresholdChange={setCompactionThreshold}
          />
        </div>
      </fieldset>
      <ErrorNote error={error} />
      <Button
        variant="primary"
        className="mt-1 h-10"
        disabled={busy || !name.trim() || !model.trim()}
      >
        {busy ? '正在准备…' : '继续'}
        {!busy && <ArrowRight size={16} />}
      </Button>
    </form>
  );
}
