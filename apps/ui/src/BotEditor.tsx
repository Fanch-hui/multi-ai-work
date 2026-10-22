import { useState, type FormEvent } from 'react';
import { Archive } from 'lucide-react';
import type { Bot, Snapshot } from '../../../src/domain/types.js';
import type { Mutate } from './store.js';
import { errorMessage } from './api.js';
import { Button, Confirm, ErrorNote, Field, Modal, cn, inputClass } from './components.js';
import { BotTools } from './BotTools.js';
import { fullToolNames } from '../../../src/domain/tool-permissions.js';
import { enabledQoderServices } from '../../../src/domain/qoder-services.js';
import { AntigravityPermissionsGuide, NativeContextGuide } from './NativeContextGuide.js';
import { AvatarPicker } from './AvatarPicker.js';
import { isChiefProvider } from '../../../src/domain/chief-provider.js';
import { DEFAULT_COMPACTION_THRESHOLD } from '../../../src/domain/context-settings.js';
import { ContextBudgetFields } from './ContextBudgetFields.js';
import { ReasoningField } from './ReasoningField.js';
import {
  isReasoningSupported,
  reasoningConfiguration,
} from '../../../src/domain/model-reasoning.js';
import { MemoryModeField, MemberColorField, MemberSkillsField } from './BotSettingsFields.js';
export function BotEditor({
  bot,
  data,
  mutate,
  close,
  configureConnection,
}: {
  bot?: Bot;
  data: Snapshot;
  mutate: Mutate;
  close: () => void;
  configureConnection?: () => void;
}) {
  const [name, setName] = useState(bot?.name || '');
  const [role, setRole] = useState(bot?.role || '');
  const [personalInstructions, setPersonalInstructions] = useState(bot?.personalInstructions || '');
  const [detached, setDetached] = useState<Bot>();
  const preset = detached ? undefined : bot?.preset;
  const [instructions, setInstructions] = useState(bot?.instructions || '');
  const main = bot?.id === data.settings.mainBotId;
  const readyConnections = data.connections.filter(
    (item) => item.status === 'ready' && (!main || isChiefProvider(item.provider)),
  );
  const [connectionId, setConnection] = useState(bot?.connectionId || '');
  const [model, setModel] = useState(bot?.model || '');
  const [reasoning, setReasoning] = useState(bot?.reasoning || '');
  const [contextWindow, setContextWindow] = useState(bot?.contextWindow?.toString() || '');
  const [compactionThreshold, setCompactionThreshold] = useState(
    String(bot?.compactionThreshold ?? DEFAULT_COMPACTION_THRESHOLD),
  );
  const [avatar, setAvatar] = useState(bot?.avatar || (main ? 'owl' : 'cat'));
  const [color, setColor] = useState(bot?.color || '#047857');
  const [memoryMode, setMemory] = useState<Bot['memoryMode']>(
    bot?.memoryMode === 'off' ? 'off' : 'propose',
  );
  const [toolNames, setTools] = useState(bot?.toolNames || fullToolNames(main));
  const [approvalMode, setApprovalMode] = useState<NonNullable<Bot['approvalMode']>>(
    bot?.approvalMode || 'auto',
  );
  const [toolConnectionIds, setToolConnections] = useState(bot?.toolConnectionIds || []);
  const [qoderServices, setQoderServices] = useState(bot?.qoderServices);
  const [skillIds, setSkills] = useState(bot?.skillIds || []);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const connection = readyConnections.find((item) => item.id === connectionId);
  const native = connection?.provider === 'antigravity' || connection?.provider === 'qoder';
  const selectedModel = connection?.models.find((item) => item.id === model);
  const reasoningOptions = reasoningConfiguration(connection?.provider, selectedModel);
  const showReasoningHelp = reasoningOptions.fallback || reasoningOptions.options.length > 0;
  const selectedReasoning = isReasoningSupported(connection?.provider, selectedModel, reasoning)
    ? reasoning
    : '';
  async function save(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      await mutate(main ? 'chief.configure' : 'bots.save', {
        input: {
          ...(main ? { id: bot?.id, outputReserve: bot?.outputReserve } : detached || bot),
          name,
          ...(!main && {
            role,
            instructions: preset ? preset.baseInstructions : instructions,
            personalInstructions: preset ? personalInstructions : undefined,
          }),
          connectionId,
          model,
          reasoning: selectedReasoning || undefined,
          contextWindow: !native && contextWindow ? Number(contextWindow) : undefined,
          compactionThreshold: !native ? Number(compactionThreshold) : undefined,
          avatar,
          color,
          memoryMode,
          toolNames,
          approvalMode,
          toolConnectionIds,
          ...(!main && {
            qoderServices:
              connection?.provider === 'qoder'
                ? enabledQoderServices({ qoderServices, toolNames })
                : qoderServices,
          }),
          skillIds,
        },
      });
      close();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }
  const getEditorTitle = () => {
    if (main) {
      return '配置主智能体';
    }
    if (bot) {
      return `编辑 ${bot.name}`;
    }
    return '新建智能体';
  };
  const getSaveLabel = () => {
    if (busy) {
      return '保存中…';
    }
    if (main) {
      return '保存 Chief';
    }
    return '保存智能体';
  };
  return (
    <Modal open onOpenChange={(open) => !open && close()} title={getEditorTitle()} wide>
      <form className="grid gap-4" onSubmit={(event) => void save(event)}>
        <AvatarPicker value={avatar} onChange={setAvatar} mutate={mutate} />
        <div className={cn('grid gap-4', !main && 'sm:grid-cols-2')}>
          <Field label="名称">
            <input
              className={inputClass}
              value={name}
              onChange={(event) => setName(event.target.value)}
              required
              placeholder="例如：Chief"
            />
          </Field>
          {!main && (
            <Field label="职责">
              <input
                className={inputClass}
                value={role}
                onChange={(event) => setRole(event.target.value)}
                required
                placeholder="例如：协调与成果审核"
              />
            </Field>
          )}
        </div>
        {!main && (
          <Field label={preset ? '预设工作指令' : '工作指令'}>
            <textarea
              className={inputClass}
              rows={5}
              value={preset ? preset.baseInstructions : instructions}
              readOnly={!!preset}
              onChange={(event) => setInstructions(event.target.value)}
              placeholder="说明工作目标、交付标准和协作方式"
            />
          </Field>
        )}
        {preset && (
          <>
            <Field label="个人补充要求" hint="更新预设时保留，适合补充你的工作习惯和交付偏好。">
              <textarea
                className={inputClass}
                rows={3}
                value={personalInstructions}
                onChange={(event) => setPersonalInstructions(event.target.value)}
              />
            </Field>
            <Confirm
              title="转为自定义成员？"
              description="保留当前指令和技能，之后可以自由编辑，并停止跟随预设更新。"
              actionLabel="转换"
              onConfirm={async () => {
                if (!bot) return;
                const next = await mutate<Bot>('market.detach', { botId: bot.id });
                setDetached(next);
                setInstructions(next.instructions);
                setPersonalInstructions('');
              }}
            >
              <Button type="button" variant="ghost" className="justify-self-start">
                转为自定义成员
              </Button>
            </Confirm>
          </>
        )}
        <div className="grid items-start gap-4 sm:grid-cols-2">
          <Field label="连接">
            <select
              className={inputClass}
              value={connectionId}
              onChange={(event) => {
                setConnection(event.target.value);
                setModel('');
                setReasoning('');
              }}
              required
            >
              <option value="">选择连接</option>
              {readyConnections.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="模型">
            {connection?.models.length ? (
              <select
                required
                className={inputClass}
                value={model}
                onChange={(event) => {
                  setModel(event.target.value);
                  setReasoning('');
                }}
              >
                <option value="">选择模型</option>
                {connection?.models.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </select>
            ) : (
              <input
                className={inputClass}
                required
                value={model}
                placeholder="输入服务支持的模型 ID"
                onChange={(event) => {
                  setModel(event.target.value);
                  setReasoning('');
                }}
              />
            )}
          </Field>
          <ReasoningField
            provider={connection?.provider}
            model={selectedModel}
            value={reasoning}
            onChange={setReasoning}
          />
          {showReasoningHelp && (
            <p className="-mt-3 text-xs text-slate-500">
              {native ? '推理强度将在下次任务或运行时生效。' : '推理强度将在下一次模型请求时生效。'}
            </p>
          )}
          <MemoryModeField value={memoryMode} change={setMemory} />
          {!native && (
            <ContextBudgetFields
              provider={connection?.provider}
              model={selectedModel}
              contextWindow={contextWindow}
              onContextWindowChange={setContextWindow}
              compactionThreshold={compactionThreshold}
              onCompactionThresholdChange={setCompactionThreshold}
              outputReserve={bot?.outputReserve}
            />
          )}
        </div>
        {native && connection && <NativeContextGuide connection={connection} />}
        {!readyConnections.length && (
          <div className="flex items-center justify-between gap-3 rounded-lg bg-slate-50 p-3">
            <p className="text-sm text-slate-500">先连接并登录模型供应商。</p>
            {configureConnection && (
              <Button
                type="button"
                onClick={() => {
                  close();
                  configureConnection();
                }}
              >
                添加连接
              </Button>
            )}
          </div>
        )}
        <MemberColorField value={color} change={setColor} />
        {connection?.provider === 'antigravity' && <AntigravityPermissionsGuide />}
        <BotTools
          chief={main}
          data={data}
          toolNames={toolNames}
          approvalMode={approvalMode}
          toolConnectionIds={toolConnectionIds}
          onPermissionsChange={(value) => {
            setTools(value.toolNames);
            setApprovalMode(value.approvalMode);
          }}
          onConnectionsChange={setToolConnections}
          qoderServices={qoderServices}
          onQoderServicesChange={
            !main && connection?.provider === 'qoder' ? setQoderServices : undefined
          }
        />
        <MemberSkillsField data={data} value={skillIds} change={setSkills} />
        <ErrorNote error={error} />
        <div className="mt-2 flex justify-between gap-3">
          {bot && !bot.archived && !main ? (
            <Confirm
              title={`归档 ${bot.name}？`}
              description="此成员将不再出现在新会话中，历史记录继续保留。"
              actionLabel="归档"
              onConfirm={async () => {
                await mutate('bots.archive', { id: bot.id });
                close();
              }}
            >
              <Button type="button" variant="ghost">
                <Archive size={16} />
                归档
              </Button>
            </Confirm>
          ) : (
            <span />
          )}
          <div className="flex gap-2">
            <Button type="button" onClick={close}>
              取消
            </Button>
            <Button
              variant="primary"
              disabled={
                busy ||
                connection?.status !== 'ready' ||
                !model.trim() ||
                (!!connection.models.length && !selectedModel)
              }
            >
              {getSaveLabel()}
            </Button>
          </div>
        </div>
      </form>
    </Modal>
  );
}
