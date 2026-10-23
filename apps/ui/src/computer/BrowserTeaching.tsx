import { useEffect, useRef, useState } from 'react';
import type { BrowserTeachingDraft } from '../../../../src/domain/browser-teaching.js';
import { Button, ErrorNote, Field, inputClass, Modal } from '../components.js';
import { errorMessage, request } from '../api.js';
import type { Mutate } from '../store.js';
import type { WorkSkillDraft } from '../../../../src/domain/work-skills.js';
export function BrowserTeaching({ sessionId, mutate }: { sessionId: string; mutate: Mutate }) {
  const [draft, setDraft] = useState<BrowserTeachingDraft | null>(null);
  const [name, setName] = useState('浏览器工作流程');
  const [content, setContent] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  const savingDraft = useRef('');
  const submitting = useRef(false);
  useEffect(() => {
    if (draft?.status !== 'recording') return;
    let alive = true;
    const timer = setInterval(() => {
      void request<BrowserTeachingDraft>('teaching.status', { sessionId })
        .then((value) => {
          if (alive) setDraft(value);
        })
        .catch((cause) => {
          if (alive) setError(errorMessage(cause));
        });
    }, 2000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [draft?.status, sessionId]);
  function review(value: BrowserTeachingDraft) {
    setDraft(value);
    savingDraft.current = '';
    setName(value.name);
    setContent(
      `按以下步骤完成工作，输入内容由本次任务提供。登录或验证请用户接管。\n\n${value.steps.map((step, index) => `${index + 1}. ${step.instruction}`).join('\n')}`,
    );
    setReviewing(true);
  }
  async function run(method: string) {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      const value = await mutate<BrowserTeachingDraft>(method, { sessionId });
      setDraft(value);
      if (value.status === 'draft') review(value);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }
  async function save() {
    if (submitting.current) return;
    submitting.current = true;
    setBusy(true);
    setError('');
    try {
      const input = { name, content, description: '由浏览器示范整理的工作流程' };
      if (!savingDraft.current) {
        const draft = await mutate<WorkSkillDraft>('workSkills.draft', { input });
        savingDraft.current = draft.id;
      }
      await mutate('workSkills.save', { id: savingDraft.current, input });
      setReviewing(false);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }
  return (
    <>
      <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500">
        <Button
          disabled={busy}
          onClick={() =>
            void run(draft?.status === 'recording' ? 'teaching.stop' : 'teaching.start')
          }
        >
          {draft?.status === 'recording' ? '停止示范并审阅' : '示范一次，保存技能'}
        </Button>
        {draft?.status === 'recording' && (
          <span role="status">正在记录操作步骤 · {draft.steps.length} 步 · 最长 10 分钟</span>
        )}
        {draft?.status === 'draft' && <Button onClick={() => review(draft)}>审阅示范草稿</Button>}
      </div>
      <ErrorNote error={reviewing ? '' : error} />
      {reviewing && (
        <Modal
          open
          title="审阅示范技能"
          wide
          onOpenChange={(open) => {
            if (!open && !busy) setReviewing(false);
          }}
        >
          <div className="space-y-4">
            <p className="text-sm text-slate-500">
              记录仅保留页面路径与操作目标，输入值由执行任务时提供。可在保存前修改步骤。
            </p>
            <Field label="技能名称">
              <input
                className={inputClass}
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
            </Field>
            <Field label="执行步骤">
              <textarea
                className={`${inputClass} min-h-72`}
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
              {busy ? '保存中…' : '保存为技能'}
            </Button>
          </div>
        </Modal>
      )}
    </>
  );
}
