import { useRef, useState } from 'react';
import type { Snapshot, Skill } from '../../../../src/domain/types.js';
import type { WorkSkillDraft } from '../../../../src/domain/work-skills.js';
import type { Mutate } from '../store.js';
import { errorMessage } from '../api.js';
import { Button, ErrorNote, Modal } from '../components.js';
import { useResource } from '../local-work/useResource.js';
import { downloadLocalJson } from './downloads.js';

export function WorkSkills({
  data,
  mutate,
  close,
}: {
  data: Snapshot;
  mutate: Mutate;
  close: () => void;
}) {
  const action = useRef(false);
  const drafts = useResource<WorkSkillDraft[]>('workSkills.list');
  const [editing, setEditing] = useState<{
    id?: string;
    skillId?: string;
    name: string;
    description: string;
    content: string;
  }>();
  const [selected, setSelected] = useState<Skill>();
  const [botIds, setBotIds] = useState<string[]>([]);
  const [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const personal = data.skills.filter(
    (skill) => !skill.bundled && !skill.presetOnly && !skill.missing,
  );
  async function act(operation: () => Promise<unknown>) {
    if (action.current) return;
    action.current = true;
    setBusy(true);
    setError('');
    try {
      await operation();
      drafts.reload();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      action.current = false;
      setBusy(false);
    }
  }
  return (
    <>
      <Modal
        open
        onOpenChange={(open) => {
          if (!open) close();
        }}
        title="工作技能"
        wide
      >
        <p className="mb-4 text-sm text-slate-500">
          在聊天中说“把刚才的流程保存成技能”，审阅草稿后保存；也可直接编写。
        </p>
        <ErrorNote error={error || drafts.error} />
        <Button onClick={() => setEditing({ name: '', description: '', content: '' })}>
          新建技能
        </Button>
        <label className="mt-4 block text-sm">
          导入个人技能 JSON
          <input
            type="file"
            accept=".json,application/json"
            disabled={busy}
            className="mt-2 block w-full text-xs"
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = '';
              if (!file) return;
              void act(async () => {
                if (file.size > 24 * 1024 * 1024) throw new Error('技能文件上限为 24 MiB');
                await mutate('workSkills.import', { content: await file.text() });
              });
            }}
          />
        </label>
        <h3 className="mt-5 mb-2 text-sm font-semibold">待审阅草稿</h3>
        <div className="space-y-2">
          {drafts.value
            ?.filter((draft) => !draft.skillId)
            .map((draft) => (
              <article key={draft.id} className="rounded-xl border border-slate-200 p-3">
                <strong className="text-sm">{draft.name}</strong>
                <p className="my-2 text-xs text-slate-500">{draft.description}</p>
                <div className="flex gap-2">
                  <Button onClick={() => setEditing(draft)}>审阅与编辑</Button>
                  <Button
                    disabled={busy}
                    onClick={() => void act(() => mutate('workSkills.discard', { id: draft.id }))}
                  >
                    丢弃
                  </Button>
                </div>
              </article>
            ))}
        </div>
        <h3 className="mt-5 mb-2 text-sm font-semibold">个人技能</h3>
        <div className="space-y-2">
          {personal.map((skill) => (
            <article key={skill.id} className="rounded-xl border border-slate-200 p-3">
              <strong className="text-sm">{skill.name}</strong>
              <p className="my-2 text-xs text-slate-500">{skill.description}</p>
              <div className="flex flex-wrap gap-2">
                <Button
                  onClick={() =>
                    setEditing({
                      skillId: skill.id,
                      name: skill.name,
                      description: skill.description ?? '',
                      content: skill.content,
                    })
                  }
                >
                  编辑
                </Button>
                <Button
                  onClick={() => {
                    setSelected(skill);
                    setBotIds([]);
                  }}
                >
                  绑定成员
                </Button>
                <Button
                  disabled={busy}
                  onClick={() =>
                    void act(async () => {
                      const result = await mutate<{ name: string; content: string }>(
                        'workSkills.export',
                        { skillId: skill.id },
                      );
                      downloadLocalJson(result);
                    })
                  }
                >
                  导出技能
                </Button>
              </div>
            </article>
          ))}
        </div>
      </Modal>
      {editing && (
        <Modal
          open
          onOpenChange={(open) => {
            if (!open) setEditing(undefined);
          }}
          title="编辑工作技能"
          wide
        >
          <div className="space-y-3">
            <label className="block text-sm">
              名称
              <input
                className="mt-1 w-full rounded-lg border p-2"
                value={editing.name}
                onChange={(event) => setEditing({ ...editing, name: event.target.value })}
              />
            </label>
            <label className="block text-sm">
              用途说明
              <input
                className="mt-1 w-full rounded-lg border p-2"
                value={editing.description}
                onChange={(event) => setEditing({ ...editing, description: event.target.value })}
              />
            </label>
            <label className="block text-sm">
              技能内容
              <textarea
                className="mt-1 h-72 w-full rounded-lg border p-2 font-mono text-xs"
                value={editing.content}
                onChange={(event) => setEditing({ ...editing, content: event.target.value })}
              />
            </label>
            <ErrorNote error={error} />
            <Button
              disabled={busy || !editing.name.trim() || !editing.content.trim()}
              onClick={() =>
                void act(async () => {
                  await mutate('workSkills.save', {
                    id: editing.id,
                    skillId: editing.skillId,
                    input: {
                      name: editing.name,
                      description: editing.description,
                      content: editing.content,
                    },
                  });
                  setEditing(undefined);
                })
              }
            >
              保存技能
            </Button>
          </div>
        </Modal>
      )}
      {selected && (
        <Modal
          open
          onOpenChange={(open) => {
            if (!open) setSelected(undefined);
          }}
          title={`绑定技能：${selected.name}`}
        >
          <p className="mb-3 text-sm text-slate-500">
            为成员提供技能说明，工具与外部连接仍使用成员现有授权。
          </p>
          <div className="space-y-2">
            {data.bots
              .filter((bot) => !bot.archived)
              .map((bot) => (
                <label key={bot.id} className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={botIds.includes(bot.id)}
                    onChange={(event) =>
                      setBotIds(
                        event.target.checked
                          ? [...botIds, bot.id]
                          : botIds.filter((id) => id !== bot.id),
                      )
                    }
                  />
                  {bot.name}
                </label>
              ))}
          </div>
          <ErrorNote error={error} />
          <Button
            disabled={busy || !botIds.length}
            onClick={() =>
              void act(async () => {
                await mutate('workSkills.bind', { skillId: selected.id, botIds });
                setSelected(undefined);
              })
            }
          >
            绑定所选成员
          </Button>
        </Modal>
      )}
    </>
  );
}
