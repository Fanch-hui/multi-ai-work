import { useEffect, useState, type FormEvent } from 'react';
import { FolderPlus } from 'lucide-react';
import type { Conversation, Snapshot, Workspace } from '../../../src/domain/types.js';
import type { Mutate } from './store.js';
import { choosePath, errorMessage } from './api.js';
import { Button, ErrorNote, Field, Modal, activeTask, inputClass } from './components.js';
import { isChiefProvider } from '../../../src/domain/chief-provider.js';
import { isReasoningSupported } from '../../../src/domain/model-reasoning.js';
import { ReasoningField } from './ReasoningField.js';

export function ChiefConversationEditor({
  data,
  mutate,
  close,
  created,
  configureChief,
  conversation,
}: {
  data: Snapshot;
  mutate: Mutate;
  close: () => void;
  created?: (id: string) => void;
  configureChief: () => void;
  conversation?: Conversation;
}) {
  const chief = data.bots.find((bot) => bot.id === data.settings.mainBotId);
  const connection = data.connections.find((item) => item.id === chief?.connectionId);
  const [name, setName] = useState('');
  const [model, setModel] = useState(conversation?.model || chief?.model || '');
  const [reasoning, setReasoning] = useState(
    (conversation?.model ? conversation.reasoning : chief?.reasoning) || '',
  );
  const [workspaceId, setWorkspace] = useState(
    data.conversations.find((item) => item.id === data.settings.mainConversationId)?.workspaceId ||
      data.workspaces[0]?.id ||
      '',
  );
  const [busy, setBusy] = useState(false);
  const [loadingCatalog, setLoadingCatalog] = useState(!!conversation);
  const [error, setError] = useState('');
  const modelInfo = connection?.models.find((item) => item.id === model);
  const selectedReasoning = isReasoningSupported(connection?.provider, modelInfo, reasoning)
    ? reasoning
    : '';
  const ready =
    !!chief &&
    (!!conversation || !!chief.model?.trim()) &&
    connection?.status === 'ready' &&
    isChiefProvider(connection.provider);
  const running =
    !!conversation &&
    data.tasks.some(
      (task) =>
        task.conversationId === conversation.id &&
        task.kind !== 'memory-review' &&
        activeTask(task.status),
    );
  const editing = !!conversation;
  useEffect(() => {
    if (!editing) return;
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
  }, [mutate, editing]);
  async function addDirectory() {
    setBusy(true);
    setError('');
    try {
      const path = await choosePath('directory');
      if (path) {
        const existing = data.workspaces.find((item) => item.path === path);
        if (existing) {
          setWorkspace(existing.id);
          return;
        }
        const result = await mutate<Workspace>('workspaces.add', {
          name: path.split(/[\\/]/).filter(Boolean).at(-1) || '工作目录',
          path,
          writable: true,
        });
        setWorkspace(result.id);
      }
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }
  async function save(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const result = await mutate<{ id: string }>(
        conversation ? 'chief.conversations.update' : 'chief.conversations.create',
        {
          ...(conversation
            ? { id: conversation.id, model, reasoning: selectedReasoning }
            : { name: name.trim() || '新对话', workspaceId }),
        },
      );
      if (!conversation) created?.(result.id);
      close();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      open
      onOpenChange={(open) => !open && close()}
      title={conversation ? '对话设置' : '新对话'}
    >
      <form className="grid gap-5" onSubmit={(event) => void save(event)}>
        {!conversation && (
          <Field label="会话名称">
            <input
              className={inputClass}
              maxLength={120}
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="新对话"
            />
          </Field>
        )}
        {ready ? (
          <>
            {conversation && (
              <>
                <Field label="模型">
                  {connection.models.length ? (
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
            )}
            {!conversation && (
              <>
                <Field label="工作区">
                  <div className="flex gap-2">
                    <select
                      required
                      className={inputClass}
                      value={workspaceId}
                      onChange={(event) => setWorkspace(event.target.value)}
                    >
                      <option value="">选择目录</option>
                      {data.workspaces.map((item) => (
                        <option key={item.id} value={item.id}>
                          {item.name}
                        </option>
                      ))}
                    </select>
                    <Button
                      type="button"
                      disabled={busy}
                      onClick={() => void addDirectory()}
                      aria-label="添加工作目录"
                      title="添加工作目录"
                    >
                      <FolderPlus size={17} />
                    </Button>
                  </div>
                </Field>
                {data.workspaces.find((item) => item.id === workspaceId) && (
                  <p
                    className="-mt-3 truncate text-xs text-slate-400"
                    title={data.workspaces.find((item) => item.id === workspaceId)?.path}
                  >
                    {data.workspaces.find((item) => item.id === workspaceId)?.path}
                  </p>
                )}
              </>
            )}
            {running && <p className="text-sm text-slate-500">先停止当前工作，再修改对话设置。</p>}
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
              running ||
              !ready ||
              !(conversation ? model : chief?.model)?.trim() ||
              (!conversation && !workspaceId)
            }
          >
            {busy ? '保存中…' : conversation ? '保存' : '开始对话'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
