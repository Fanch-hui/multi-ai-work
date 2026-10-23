import { useRef, useState } from 'react';
import type { WorkSkillDraft } from '../../../../src/domain/work-skills.js';
import type { Mutate } from '../store.js';
import { errorMessage } from '../api.js';
import { Button, ErrorNote, Field, inputClass, Modal } from '../components.js';

export function SkillDraftCard({
  draft,
  mutate,
  refresh,
}: {
  draft: WorkSkillDraft;
  mutate: Mutate;
  refresh: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(draft.name);
  const [description, setDescription] = useState(draft.description);
  const [content, setContent] = useState(draft.content);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const submitting = useRef(false);
  async function save(discard = false) {
    if (submitting.current) return;
    submitting.current = true;
    setBusy(true);
    setError('');
    try {
      await mutate(discard ? 'workSkills.discard' : 'workSkills.save', {
        id: draft.id,
        ...(!discard && { input: { name, description, content } }),
      });
      setEditing(false);
      refresh();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }
  return (
    <article className="rounded-lg bg-white p-3">
      <p className="text-sm font-medium">{draft.name}</p>
      <p className="mt-1 text-xs leading-5 text-slate-500">{draft.description}</p>
      <div className="mt-2 flex gap-2">
        <Button disabled={busy} onClick={() => setEditing(true)}>
          审阅并保存
        </Button>
        <Button disabled={busy} onClick={() => void save(true)}>
          丢弃
        </Button>
      </div>
      <ErrorNote error={editing ? '' : error} />
      {editing && (
        <Modal
          open
          wide
          title="审阅工作技能"
          onOpenChange={(open) => {
            if (!open && !busy) setEditing(false);
          }}
        >
          <div className="space-y-3">
            <Field label="名称">
              <input
                className={inputClass}
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
            </Field>
            <Field label="用途说明">
              <input
                className={inputClass}
                value={description}
                onChange={(event) => setDescription(event.target.value)}
              />
            </Field>
            <Field label="执行步骤">
              <textarea
                className={`${inputClass} min-h-64`}
                value={content}
                onChange={(event) => setContent(event.target.value)}
              />
            </Field>
            <ErrorNote error={error} />
            <Button
              variant="primary"
              disabled={busy || !name.trim() || !content.trim()}
              onClick={() => void save()}
            >
              保存技能
            </Button>
          </div>
        </Modal>
      )}
    </article>
  );
}
