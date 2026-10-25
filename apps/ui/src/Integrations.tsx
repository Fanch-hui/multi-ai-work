import { ModalPresence } from './ModalPresence.js';
import { ToolEditor } from './ToolEditor.js';
import { useState, type FormEvent } from 'react';
import { Plus, Plug, Trash2, Pencil, Play, FileCode2, FolderOpen } from 'lucide-react';
import type { Snapshot, ToolConnection } from '../../../src/domain/types.js';
import { httpSearchConfiguration } from '../../../src/domain/tool-connection.js';
import type { Mutate } from './store.js';
import { choosePath, errorMessage } from './api.js';
import {
  Badge,
  Button,
  Confirm,
  Empty,
  ErrorNote,
  Field,
  Modal,
  inputClass,
} from './components.js';
import { sharedSkills } from './skill-lists.js';
export function Integrations({ data, mutate }: { data: Snapshot; mutate: Mutate }) {
  const [editing, setEditing] = useState<ToolConnection | 'new'>();
  const [importOpen, setImport] = useState(false);
  const [path, setPath] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const skills = sharedSkills(data.skills);
  const searchServices = data.toolConnections.filter(
    (item) =>
      item.enabled &&
      (item.kind === 'search' ||
        item.searchBackend === 'tavily' ||
        item.toolNames.includes('tavily-search')),
  );
  async function setDefaultSearch(id: string) {
    setBusy('search-default');
    setError('');
    try {
      await mutate('settings.save', { input: { defaultSearchConnectionId: id || null } });
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy('');
    }
  }
  async function probe(id: string) {
    setBusy(id);
    setError('');
    try {
      await mutate('tools.probe', { id });
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy('');
    }
  }
  async function importSkill(event: FormEvent) {
    event.preventDefault();
    setBusy('skill');
    setError('');
    try {
      await mutate('skills.import', { path });
      setImport(false);
      setPath('');
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy('');
    }
  }
  async function browse() {
    try {
      const value = await choosePath('file');
      if (value) setPath(value);
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }
  return (
    <div className="grid gap-8">
      <section>
        <div className="mb-5 flex items-center justify-between">
          <h2 className="text-balance text-base font-semibold">外部工具</h2>
          <Button variant="primary" onClick={() => setEditing('new')}>
            <Plus size={16} />
            添加工具
          </Button>
        </div>
        <ErrorNote error={error} />
        {!!searchServices.length && (
          <div className="mb-4 rounded-xl border border-slate-200 bg-white p-4">
            <Field
              label="默认搜索服务"
              hint="智能体仅能使用已授权的连接；只有一个已授权服务时会自动使用。"
            >
              <select
                className={inputClass}
                value={data.settings.defaultSearchConnectionId || ''}
                disabled={!!busy}
                onChange={(event) => void setDefaultSearch(event.target.value)}
              >
                <option value="">自动选择</option>
                {searchServices.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </select>
            </Field>
          </div>
        )}
        {data.toolConnections.length ? (
          <div className="grid gap-3">
            {data.toolConnections.map((item) => {
              const getTransportLabel = () => {
                if (item.kind === 'search') {
                  return `HTTP ${httpSearchConfiguration(item).method}`;
                }
                if (item.transport === 'http') {
                  return 'HTTP';
                }
                return 'stdio';
              };
              return (
                <article key={item.id} className="rounded-xl border border-slate-200 bg-white p-5">
                  <div className="flex items-start justify-between">
                    <div className="flex items-center gap-3">
                      <Plug className="text-slate-400" size={20} />
                      <div>
                        <h3 className="font-semibold">{item.name}</h3>
                        <p className="mt-1 text-xs text-slate-500">
                          {item.kind === 'search' ? '搜索' : 'MCP'} · {getTransportLabel()} ·{' '}
                          {item.enabled ? '已启用' : '未启用'}
                        </p>
                      </div>
                    </div>
                    <Badge status={item.status} />
                  </div>
                  <p
                    className="mt-3 truncate font-mono text-xs text-slate-500"
                    title={item.url || item.command}
                  >
                    {item.url || item.command}
                  </p>
                  {item.error && (
                    <p className="mt-3 text-pretty text-sm text-red-700">{item.error}</p>
                  )}
                  {!!item.toolNames.length && (
                    <details className="mt-3 text-xs text-slate-500">
                      <summary className="cursor-pointer">
                        {item.toolNames.length} 项可用工具
                      </summary>
                      <div className="mt-2 flex flex-wrap gap-2">
                        {item.toolNames.map((name) => (
                          <code key={name} className="rounded bg-slate-100 px-2 py-1">
                            {name}
                          </code>
                        ))}
                      </div>
                    </details>
                  )}
                  {(item.kind === 'search' ||
                    item.searchBackend === 'tavily' ||
                    item.toolNames.includes('tavily-search')) && (
                    <p className="mt-3 text-xs text-blue-700">
                      {data.settings.defaultSearchConnectionId === item.id
                        ? '默认搜索服务'
                        : '可用于网页搜索'}{' '}
                      ·{' '}
                      {item.kind === 'search'
                        ? `HTTP ${httpSearchConfiguration(item).method}`
                        : 'Tavily MCP'}
                    </p>
                  )}
                  <div className="mt-4 flex gap-2">
                    <Button disabled={!!busy} onClick={() => void probe(item.id)}>
                      <Play size={14} />
                      {busy === item.id ? '检测中…' : '检测工具'}
                    </Button>
                    <Button variant="ghost" onClick={() => setEditing(item)}>
                      <Pencil size={14} />
                      编辑
                    </Button>
                    <Confirm
                      title={`删除 ${item.name}？`}
                      description="此工具连接将被移除，智能体配置需同步调整。"
                      actionLabel="删除"
                      onConfirm={() => mutate('tools.delete', { id: item.id })}
                    >
                      <Button variant="ghost" aria-label={`删除${item.name}`} className="ml-auto">
                        <Trash2 size={15} />
                      </Button>
                    </Confirm>
                  </div>
                </article>
              );
            })}
          </div>
        ) : (
          <Empty
            compact
            title="添加工作工具"
            description="连接外部 MCP，让成员使用搜索、代码项目和其他服务。"
            action={
              <Button onClick={() => setEditing('new')}>
                <Plus size={16} />
                添加工具
              </Button>
            }
          />
        )}
      </section>
      <section>
        <div className="mb-5 flex items-center justify-between">
          <div>
            <h2 className="text-balance text-base font-semibold">Skills</h2>
            <p className="mt-1 text-sm text-slate-500">
              Office 技能随应用提供；导入的技能可在智能体设置中启用。
            </p>
          </div>
          <Button onClick={() => setImport(true)}>
            <Plus size={16} />
            导入 Skill
          </Button>
        </div>
        {skills.length ? (
          <div className="grid gap-3">
            {skills.map((item) => (
              <div
                key={item.id}
                className="flex items-center gap-3 rounded-xl border border-slate-200 bg-white p-4"
              >
                <FileCode2 size={20} className="shrink-0 text-slate-400" />
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-semibold">{item.name}</p>
                  <p className="mt-1 truncate text-xs text-slate-500" title={item.path}>
                    {item.path}
                  </p>
                </div>
                {!item.bundled && (
                  <Confirm
                    title={`删除 ${item.name}？`}
                    description="从工作台移除此 Skill，原始文件继续保留。"
                    actionLabel="删除"
                    onConfirm={() => mutate('skills.delete', { id: item.id })}
                  >
                    <Button variant="ghost" aria-label={`删除${item.name}`}>
                      <Trash2 size={15} />
                    </Button>
                  </Confirm>
                )}
              </div>
            ))}
          </div>
        ) : (
          <Empty
            compact
            title="尚未导入 Skill"
            action={<Button onClick={() => setImport(true)}>导入 SKILL.md</Button>}
          />
        )}
      </section>
      <ModalPresence show={!!editing}>
        {editing && (
          <ToolEditor
            key={typeof editing === 'string' ? 'new' : editing.id}
            tool={editing === 'new' ? undefined : editing}
            mutate={mutate}
            close={() => setEditing(undefined)}
          />
        )}
      </ModalPresence>
      <Modal open={importOpen} onOpenChange={setImport} title="导入 Skill">
        <form onSubmit={(event) => void importSkill(event)} className="grid gap-4">
          <Field label="SKILL.md 路径">
            <div className="flex gap-2">
              <input
                required
                className={inputClass}
                value={path}
                onChange={(event) => setPath(event.target.value)}
                placeholder="/path/to/SKILL.md"
              />
              <Button type="button" aria-label="选择 Skill 文件" onClick={() => void browse()}>
                <FolderOpen size={16} />
              </Button>
            </div>
          </Field>
          <ErrorNote error={error} />
          <div className="flex justify-end">
            <Button variant="primary" disabled={busy === 'skill'}>
              {busy === 'skill' ? '导入中…' : '导入'}
            </Button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
