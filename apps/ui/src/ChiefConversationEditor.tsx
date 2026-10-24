import { useEffect, useState, type FormEvent } from 'react';
import type { Conversation, Snapshot } from '../../../src/domain/types.js';
import type { Mutate } from './store.js';
import { errorMessage } from './api.js';
import { Button, ErrorNote, Field, Modal, activeTask, inputClass } from './components.js';
import { isChiefProvider } from '../../../src/domain/chief-provider.js';
import { isReasoningSupported } from '../../../src/domain/model-reasoning.js';
import { ReasoningField } from './ReasoningField.js';

export function ChiefConversationEditor({
  data,
  mutate,
  close,
  configureChief,
  conversation,
}: {
  data: Snapshot;
  mutate: Mutate;
  close: () => void;
  configureChief: () => void;
  conversation: Conversation;
}) {
  const chief = data.bots.find((bot) => bot.id === data.settings.mainBotId);
  const connection = data.connections.find((item) => item.id === chief?.connectionId);
  const [model, setModel] = useState(conversation?.model || chief?.model || '');
  const [reasoning, setReasoning] = useState(
    (conversation?.model ? conversation.reasoning : chief?.reasoning) || '',
  );
  const [busy, setBusy] = useState(false);
  const [loadingCatalog, setLoadingCatalog] = useState(true);
  const [error, setError] = useState('');
  const modelInfo = connection?.models.find((item) => item.id === model);
  const reasoningSupported = isReasoningSupported(connection?.provider, modelInfo, reasoning);
  const ready = !!chief && connection?.status === 'ready' && isChiefProvider(connection.provider);
  const running = data.tasks.some(
    (task) =>
      task.conversationId === conversation.id &&
      task.kind !== 'memory-review' &&
      activeTask(task.status),
  );
  const managed = connection?.provider === 'chatgpt' || connection?.provider === 'custom';
  const canSaveReasoningDuringRun =
    running && managed && model === (conversation?.model ?? chief?.model);
  useEffect(() => {
    let active = true;
    void mutate('chief.conversations.catalog')
      .catch((cause) => {
        if (active) setError(errorMessage(cause));
      })
      .finally(() => {
        if (active) setLoadingCatalog(false);
      });
    return () => {
      active = false;
    };
  }, [mutate]);
  async function save(event: FormEvent) {
    event.preventDefault();
    if (!reasoningSupported) {
      setError('当前推理强度不受所选模型支持。请选择默认或有效档位后保存。');
      return;
    }
    setBusy(true);
    setError('');
    try {
      await mutate('chief.conversations.update', { id: conversation.id, model, reasoning });
      close();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal open onOpenChange={(open) => !open && close()} title="管家模型设置">
      <form className="grid gap-5" onSubmit={(event) => void save(event)}>
        {ready ? (
          <>
            <>
              <Field label="模型">
                {connection.models.length ? (
                  <select
                    required
                    className={inputClass}
                    value={model}
                    disabled={running}
                    onChange={(event) => {
                      setModel(event.target.value);
                      setReasoning('');
                    }}
                  >
                    <option value="">选择模型</option>
                    {connection.models.map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.name || item.id}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input
                    required
                    className={inputClass}
                    value={model}
                    disabled={running}
                    onChange={(event) => {
                      setModel(event.target.value);
                      setReasoning('');
                    }}
                    placeholder="模型 ID"
                  />
                )}
              </Field>
              <ReasoningField
                provider={connection.provider}
                model={modelInfo}
                value={reasoning}
                onChange={setReasoning}
                disabled={loadingCatalog}
              />
            </>
            {running && (
              <p className="text-sm text-slate-500">
                {canSaveReasoningDuringRun
                  ? '推理强度将在下一次模型请求时生效，当前回复和工具操作继续完成。'
                  : '先停止当前工作，再修改对话设置。'}
              </p>
            )}
          </>
        ) : (
          <div className="rounded-xl bg-slate-50 p-4">
            <p className="mb-3 text-sm text-slate-500">先为管家选择一个可用连接和模型。</p>
            <Button
              type="button"
              onClick={() => {
                close();
                configureChief();
              }}
            >
              配置管家
            </Button>
          </div>
        )}
        <ErrorNote error={error} />
        <div className="flex justify-end gap-2">
          <Button type="button" onClick={close}>
            取消
          </Button>
          <Button
            variant="primary"
            disabled={
              busy ||
              loadingCatalog ||
              (running && !canSaveReasoningDuringRun) ||
              !ready ||
              !model.trim()
            }
          >
            {busy ? '保存中…' : '保存'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
