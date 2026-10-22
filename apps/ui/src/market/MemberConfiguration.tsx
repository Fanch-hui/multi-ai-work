import type { Snapshot } from '../../../../src/domain/types.js';
import type { AgentPreset } from '../../../../src/domain/market.js';
import { DEFAULT_COMPACTION_THRESHOLD } from '../../../../src/domain/context-settings.js';
import type { Mutate } from '../store.js';
import { Button, Field, inputClass } from '../components.js';
import { BotTools } from '../BotTools.js';
import { AntigravityPermissionsGuide, NativeContextGuide } from '../NativeContextGuide.js';
import { AvatarPicker } from '../AvatarPicker.js';
import { ContextBudgetFields } from '../ContextBudgetFields.js';
import { ReasoningField } from '../ReasoningField.js';
import { MemoryModeField, MemberColorField, MemberSkillsField } from '../BotSettingsFields.js';
import type { PresetMemberDraft } from './memberSettings.js';

export function MemberConfiguration({
  data,
  value,
  change,
  includeName = false,
  mutate,
  preset,
  configureConnection,
}: {
  data: Snapshot;
  value: PresetMemberDraft;
  change: (fields: Partial<PresetMemberDraft>) => void;
  includeName?: boolean;
  mutate: Mutate;
  preset?: AgentPreset;
  configureConnection?: () => void;
}) {
  const connections = data.connections.filter((item) => item.status === 'ready');
  const connection = connections.find((item) => item.id === value.connectionId);
  const model = connection?.models.find((item) => item.id === value.model);
  const native = connection?.provider === 'qoder' || connection?.provider === 'antigravity';
  const update = change;
  return (
    <div className="grid gap-4">
      {includeName && (
        <>
          <AvatarPicker
            value={value.avatar || 'cat'}
            onChange={(avatar) => update({ avatar })}
            mutate={mutate}
          />
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="成员名称">
              <input
                required
                className={inputClass}
                value={value.name || ''}
                onChange={(event) => update({ name: event.target.value })}
              />
            </Field>
            <Field label="职责">
              <input
                required
                className={inputClass}
                value={value.role || ''}
                onChange={(event) => update({ role: event.target.value })}
              />
            </Field>
          </div>
          {preset && (
            <Field label="预设工作指令">
              <textarea rows={5} readOnly className={inputClass} value={preset.instructions} />
            </Field>
          )}
          <Field label="个人补充要求" hint="更新预设时保留，适合补充你的工作习惯和交付偏好。">
            <textarea
              rows={3}
              className={inputClass}
              value={value.personalInstructions || ''}
              onChange={(event) => update({ personalInstructions: event.target.value })}
            />
          </Field>
        </>
      )}
      <div className="grid items-start gap-4 sm:grid-cols-2">
        <div className="grid gap-2">
          <Field label="连接">
            <select
              required
              className={inputClass}
              value={value.connectionId}
              onChange={(event) =>
                update({ connectionId: event.target.value, model: '', reasoning: undefined })
              }
            >
              <option value="">选择连接</option>
              {connections.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
          </Field>
          {configureConnection && (
            <Button type="button" className="justify-self-start" onClick={configureConnection}>
              添加连接
            </Button>
          )}
        </div>
        <Field label="模型">
          {connection?.models.length ? (
            <select
              required
              className={inputClass}
              value={value.model}
              onChange={(event) => update({ model: event.target.value, reasoning: undefined })}
            >
              <option value="">选择模型</option>
              {connection.models.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
          ) : (
            <input
              required
              className={inputClass}
              value={value.model}
              placeholder="模型 ID"
              onChange={(event) => update({ model: event.target.value, reasoning: undefined })}
            />
          )}
        </Field>
        <ReasoningField
          provider={connection?.provider}
          model={model}
          value={value.reasoning || ''}
          onChange={(reasoning) => update({ reasoning: reasoning || undefined })}
        />
        <MemoryModeField
          value={value.memoryMode ?? 'propose'}
          change={(memoryMode) => update({ memoryMode })}
        />
        {!native && (
          <ContextBudgetFields
            provider={connection?.provider}
            model={model}
            contextWindow={String(value.contextWindow ?? '')}
            onContextWindowChange={(contextWindow) => update({ contextWindow })}
            compactionThreshold={String(value.compactionThreshold ?? DEFAULT_COMPACTION_THRESHOLD)}
            onCompactionThresholdChange={(compactionThreshold) => update({ compactionThreshold })}
          />
        )}
      </div>
      {connection && native && <NativeContextGuide connection={connection} />}
      {includeName && (
        <MemberColorField value={value.color || '#2563eb'} change={(color) => update({ color })} />
      )}
      {connection?.provider === 'antigravity' && <AntigravityPermissionsGuide />}
      <BotTools
        data={data}
        toolNames={value.toolNames}
        approvalMode={value.approvalMode}
        toolConnectionIds={value.toolConnectionIds}
        qoderServices={value.qoderServices}
        onQoderServicesChange={
          connection?.provider === 'qoder'
            ? (qoderServices) => update({ qoderServices })
            : undefined
        }
        onPermissionsChange={update}
        onConnectionsChange={(toolConnectionIds) => update({ toolConnectionIds })}
      />
      {includeName && (
        <MemberSkillsField
          data={data}
          value={value.skillIds ?? []}
          change={(skillIds) => update({ skillIds })}
        />
      )}
    </div>
  );
}
