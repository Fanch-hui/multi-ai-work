import { useRef, useState } from 'react';
import type { BotTemplate } from '../../../../src/domain/bot-template.js';
import type { Snapshot } from '../../../../src/domain/types.js';
import type { Mutate } from '../store.js';
import { errorMessage } from '../api.js';
import { Button, ErrorNote, Modal } from '../components.js';
import { downloadLocalJson } from './downloads.js';

export function BotTemplates({
  data,
  mutate,
  close,
  botId,
}: {
  data: Snapshot;
  mutate: Mutate;
  close: () => void;
  botId?: string;
}) {
  const [exportId, setExportId] = useState(botId ?? '');
  const [content, setContent] = useState('');
  const [preview, setPreview] = useState<BotTemplate>();
  const [connectionId, setConnectionId] = useState(''),
    [model, setModel] = useState('');
  const [workspaceId, setWorkspaceId] = useState(data.workspaces[0]?.id ?? '');
  const [toolNames, setToolNames] = useState<string[]>([]);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState('');
  const request = useRef(0);
  const action = useRef(false);
  const connection = data.connections.find((item) => item.id === connectionId);
  async function act(operation: () => Promise<unknown>) {
    if (action.current) return;
    action.current = true;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await operation();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      action.current = false;
      setBusy(false);
    }
  }
  async function read(file: File) {
    const current = ++request.current;
    setPreview(undefined);
    setError('');
    setNotice('');
    if (file.size > 24 * 1024 * 1024) {
      setError('模板文件上限为 24 MiB');
      return;
    }
    try {
      const text = await file.text();
      const value = await mutate<BotTemplate>('botTemplates.preview', { content: text });
      if (current !== request.current) return;
      setContent(text);
      setPreview(value);
      setToolNames([]);
    } catch (cause) {
      if (current === request.current) setError(errorMessage(cause));
    }
  }
  return (
    <Modal
      open
      onOpenChange={(open) => {
        if (!open) {
          request.current++;
          close();
        }
      }}
      title="成员模板"
      wide
    >
      <p className="mb-4 text-sm text-slate-500">
        分享成员职责、工作指令、个人技能和例行工作。导入时选择本机模型与工作区，并确认工具权限。
      </p>
      <ErrorNote error={error} />
      {notice && (
        <p role="status" className="my-3 rounded-lg bg-blue-50 p-3 text-sm text-blue-700">
          {notice}
        </p>
      )}
      <section className="space-y-3 rounded-xl border border-slate-200 p-4">
        <h3 className="text-sm font-semibold">导出模板</h3>
        <label className="block text-sm">
          选择成员
          <select
            className="mt-1 w-full rounded-lg border p-2"
            value={exportId}
            onChange={(event) => setExportId(event.target.value)}
          >
            <option value="">请选择</option>
            {data.bots
              .filter((bot) => bot.id !== data.settings.mainBotId && !bot.archived)
              .map((bot) => (
                <option key={bot.id} value={bot.id}>
                  {bot.name}
                </option>
              ))}
          </select>
        </label>
        <Button
          disabled={busy || !exportId}
          onClick={() =>
            void act(async () => {
              const file = await mutate<{ name: string; content: string; omittedSkills: string[] }>(
                'botTemplates.export',
                { botId: exportId },
              );
              downloadLocalJson(file);
              if (file.omittedSkills.length)
                setNotice(
                  `模板已导出。以下市场专用或不可用技能需在目标工作台另行准备：${file.omittedSkills.join('、')}`,
                );
              else setNotice('模板已导出。');
            })
          }
        >
          导出 JSON 文件
        </Button>
      </section>
      <section className="mt-4 space-y-3 rounded-xl border border-slate-200 p-4">
        <h3 className="text-sm font-semibold">导入模板</h3>
        <label className="block text-sm">
          选择模板文件
          <input
            type="file"
            accept=".json,application/json"
            disabled={busy}
            className="mt-2 block w-full text-sm"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void read(file);
            }}
          />
        </label>
        {preview && (
          <>
            <div className="rounded-lg bg-slate-50 p-3 text-sm">
              <strong>{preview.name}</strong>
              <p className="mt-1 text-slate-500">{preview.role}</p>
              <p className="mt-2">
                {preview.skills.length} 个技能 · {preview.routines.length} 项例行工作（导入后暂停）
              </p>
              <details className="mt-2">
                <summary>查看工作指令与技能</summary>
                <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap text-xs">
                  {preview.instructions}
                  {preview.personalInstructions ? `\n\n${preview.personalInstructions}` : ''}
                </pre>
                {preview.skills.map((skill, index) => (
                  <p key={`${index}:${skill.name}`} className="mt-2 text-xs">
                    {skill.name}：{skill.description}（{skill.files.length} 个文件）
                  </p>
                ))}
              </details>
            </div>
            <label className="block text-sm">
              本机模型连接
              <select
                className="mt-1 w-full rounded-lg border p-2"
                value={connectionId}
                onChange={(event) => {
                  setConnectionId(event.target.value);
                  setModel('');
                }}
              >
                <option value="">请选择</option>
                {data.connections
                  .filter((item) => item.status === 'ready')
                  .map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.name}
                    </option>
                  ))}
              </select>
            </label>
            <label className="block text-sm">
              模型
              {connection?.models.length ? (
                <select
                  className="mt-1 w-full rounded-lg border p-2"
                  value={model}
                  onChange={(event) => setModel(event.target.value)}
                >
                  <option value="">请选择</option>
                  {connection.models.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.name ?? item.id}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  className="mt-1 w-full rounded-lg border p-2"
                  value={model}
                  onChange={(event) => setModel(event.target.value)}
                  placeholder="模型 ID"
                />
              )}
            </label>
            <label className="block text-sm">
              本机工作区
              <select
                className="mt-1 w-full rounded-lg border p-2"
                value={workspaceId}
                onChange={(event) => setWorkspaceId(event.target.value)}
              >
                {data.workspaces.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </select>
            </label>
            {!!preview.suggestedToolNames?.length && (
              <fieldset className="space-y-2">
                <legend className="mb-2 text-sm">模板建议工具（勾选后授权）</legend>
                {preview.suggestedToolNames.map((name) => (
                  <label key={name} className="flex items-center gap-2 text-xs">
                    <input
                      type="checkbox"
                      checked={toolNames.includes(name)}
                      onChange={(event) =>
                        setToolNames(
                          event.target.checked
                            ? [...toolNames, name]
                            : toolNames.filter((item) => item !== name),
                        )
                      }
                    />
                    {name}
                  </label>
                ))}
              </fieldset>
            )}
            <Button
              disabled={busy || !connectionId || !model.trim() || !workspaceId}
              onClick={() =>
                void act(async () => {
                  await mutate('botTemplates.import', {
                    content,
                    input: { connectionId, model, workspaceId, toolNames },
                  });
                  setPreview(undefined);
                  setContent('');
                  setNotice('成员与技能已导入，例行工作保持暂停。可在成员配置中进一步调整。');
                })
              }
            >
              确认创建成员
            </Button>
          </>
        )}
      </section>
    </Modal>
  );
}
