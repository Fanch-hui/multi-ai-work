import { useRef, useState, type FormEvent } from 'react';
import type { ArtifactReview } from '../../../../src/domain/artifact-review.js';
import type { Artifact, Conversation, Task } from '../../../../src/domain/types.js';
import type { Mutate } from '../store.js';
import { errorMessage } from '../api.js';
import { Badge, Button, ErrorNote, Field, inputClass, Modal, timeLabel } from '../components.js';
import { useResource } from './useResource.js';

export function ArtifactReviewActions({
  artifacts,
  conversationId,
  mutate,
  compact = false,
  conversations,
}: {
  conversations?: Conversation[];
  artifacts: Artifact[];
  conversationId?: string;
  mutate: Mutate;
  compact?: boolean;
}) {
  const [open, setOpen] = useState(false);
  if (
    !artifacts.length ||
    artifacts.some(
      (artifact) => artifact.source === 'user-attachment' || artifact.purpose === 'intermediate',
    )
  )
    return null;
  return (
    <>
      <Button
        variant="ghost"
        className={compact ? 'min-h-7 px-2 text-xs' : ''}
        onClick={() => setOpen(true)}
      >
        审阅{artifacts.length > 1 ? ` ${artifacts.length} 个成果` : '与修改'}
      </Button>
      {open && (
        <ArtifactReviewDialog
          key={artifacts.map((artifact) => artifact.id).join(',')}
          artifacts={artifacts}
          conversationId={conversationId ?? artifacts[0].conversationId}
          mutate={mutate}
          close={() => setOpen(false)}
          conversations={conversations}
        />
      )}
    </>
  );
}
function ArtifactReviewDialog({
  artifacts,
  conversationId,
  mutate,
  close,
  conversations,
}: {
  conversations?: Conversation[];
  artifacts: Artifact[];
  conversationId: string;
  mutate: Mutate;
  close: () => void;
}) {
  const [selectedIds, setSelectedIds] = useState(
    artifacts.slice(0, 10).map((artifact) => artifact.id),
  );
  const [feedback, setFeedback] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const requestIds = useRef(new Map<string, string>());
  const submitting = useRef(false);
  const selected = artifacts.filter((artifact) => selectedIds.includes(artifact.id));
  const deletedSources = conversations
    ? selected.filter(
        (artifact) => !conversations.some((room) => room.id === artifact.conversationId),
      )
    : [];
  const transfer = deletedSources.length > 0;
  const mixedSources = transfer && deletedSources.length !== selected.length;
  const destinations = conversations?.filter((room) => !room.archived) ?? [];
  const [destination, setDestination] = useState(
    destinations.some((room) => room.id === conversationId) ? conversationId : '',
  );
  const [transferred, setTransferred] = useState(false);
  const targetConversation = transfer ? destination : conversationId;
  const archived = conversations?.find((room) => room.id === targetConversation)?.archived;
  const disabled = busy || !selectedIds.length || mixedSources || !targetConversation || !!archived;
  const history = useResource<
    (ArtifactReview & {
      reviewInputArtifactIds?: string[];
      reworkTask?: Pick<Task, 'id' | 'status' | 'conversationId'>;
    })[]
  >(
    'reviews.list',
    artifacts.length === 1
      ? { artifactId: artifacts[0].id, conversationId: targetConversation }
      : { conversationId: targetConversation },
    !!targetConversation && (!transfer || transferred),
  );
  async function submit(outcome: 'accept' | 'requestChanges', event?: FormEvent) {
    event?.preventDefault();
    if (submitting.current || disabled) return;
    submitting.current = true;
    setBusy(true);
    setError('');
    setNotice('');
    const key = JSON.stringify({
      outcome,
      selectedIds: [...selectedIds].sort(),
      feedback,
      conversationId: targetConversation,
      transfer,
    });
    const requestId = requestIds.current.get(key) ?? crypto.randomUUID();
    requestIds.current.set(key, requestId);
    try {
      const review = await mutate<ArtifactReview>(`reviews.${outcome}`, {
        conversationId: targetConversation,
        ...(transfer && { transfer: true }),
        artifactIds: selectedIds,
        feedback,
        requestId,
      });
      requestIds.current.delete(key);
      setNotice(
        outcome === 'accept'
          ? '已接受所选版本。'
          : `修改要求已保存${review.reworkTaskId ? '，团队将继续处理' : ''}。`,
      );
      setFeedback('');
      if (transfer) setTransferred(true);
      history.reload();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }
  const ids = new Set(artifacts.map((artifact) => artifact.id));
  const reviews = history.value?.filter((review) => reviewMatchesArtifacts(review, ids)) ?? [];
  return (
    <Modal
      open
      onOpenChange={(open) => {
        if (!open && !busy) close();
      }}
      title="成果审阅"
      wide
    >
      <p className="mb-3 text-xs leading-5 text-slate-500">
        接受和修改意见针对所选文件的当前版本保存，每次最多选择 10 个成果。
      </p>
      <fieldset
        disabled={busy}
        className="max-h-40 space-y-2 overflow-y-auto rounded-lg bg-slate-50 p-3"
      >
        <legend className="sr-only">选择审阅成果</legend>
        {artifacts.map((artifact) => (
          <label key={artifact.id} className="flex items-start gap-2 text-sm text-slate-700">
            <input
              type="checkbox"
              checked={selectedIds.includes(artifact.id)}
              disabled={!selectedIds.includes(artifact.id) && selectedIds.length >= 10}
              onChange={(event) =>
                setSelectedIds(
                  event.target.checked
                    ? [...selectedIds, artifact.id]
                    : selectedIds.filter((id) => id !== artifact.id),
                )
              }
            />
            <span className="break-all">
              {artifact.name}
              <span className="ml-2 text-xs text-slate-400">{timeLabel(artifact.createdAt)}</span>
            </span>
          </label>
        ))}
      </fieldset>
      {transfer && (
        <div className="mt-4 space-y-2">
          <p className="text-sm text-amber-800">
            成果的原会话已删除。请选择接收后续工作的会话，所选成果将显式交给该会话处理。
          </p>
          <Field label="接收会话">
            <select
              value={destination}
              disabled={busy}
              className={inputClass}
              onChange={(event) => {
                setDestination(event.target.value);
                setTransferred(false);
              }}
            >
              <option value="">选择有效会话</option>
              {destinations.map((room) => (
                <option key={room.id} value={room.id}>
                  {room.name}
                </option>
              ))}
            </select>
          </Field>
          {mixedSources && (
            <p className="text-xs text-amber-800">请分别处理来源已删除和来源仍存在的成果。</p>
          )}
        </div>
      )}
      {archived && (
        <p className="mt-3 text-sm text-amber-800">此会话已归档，请先在设置中恢复后再审阅。</p>
      )}
      <form className="mt-4 space-y-3" onSubmit={(event) => void submit('requestChanges', event)}>
        <Field label="修改意见" hint="说明需要调整的内容，团队会结合所选版本继续工作。">
          <textarea
            rows={3}
            maxLength={20000}
            className={inputClass}
            value={feedback}
            disabled={busy}
            onChange={(event) => setFeedback(event.target.value)}
          />
        </Field>
        <ErrorNote error={error} />
        {notice && (
          <p role="status" className="text-sm text-blue-700">
            {notice}
          </p>
        )}
        <div className="flex flex-wrap justify-end gap-2">
          <Button type="button" disabled={disabled} onClick={() => void submit('accept')}>
            接受所选版本
          </Button>
          <Button type="submit" variant="primary" disabled={disabled || !feedback.trim()}>
            {busy ? '提交中…' : '要求修改'}
          </Button>
        </div>
      </form>
      <details className="mt-5 border-t border-slate-100 pt-4">
        <summary className="cursor-pointer text-sm font-medium text-slate-600">
          审阅历史 · {reviews.length}
        </summary>
        <ErrorNote error={history.error} />
        {history.loading && !history.value && (
          <p role="status" className="mt-3 text-xs text-slate-500">
            读取审阅记录…
          </p>
        )}
        <ol className="mt-3 space-y-3">
          {reviews.map((review) => (
            <li key={review.id} className="rounded-lg bg-slate-50 p-3">
              <p className="text-xs font-medium text-slate-700">
                {reviewLabel(review)} · {timeLabel(review.createdAt)}
              </p>
              <p className="mt-1 break-words text-xs text-slate-500">
                {review.targets.map((target) => target.name).join('、')}
              </p>
              {review.feedback && (
                <p className="mt-2 whitespace-pre-wrap break-words text-sm text-slate-600">
                  {review.feedback}
                </p>
              )}
              {review.reworkTaskId && (
                <div className="mt-2 flex items-center gap-2 text-xs text-blue-600">
                  <span>返工任务</span>
                  {review.reworkTask ? (
                    <Badge status={review.reworkTask.status} />
                  ) : (
                    <span>已创建</span>
                  )}
                </div>
              )}
            </li>
          ))}
        </ol>
      </details>
    </Modal>
  );
}
export function reviewLabel(review: ArtifactReview) {
  if (review.outcome === 'changes_requested') return '要求修改';
  if (review.reviewer === 'user' && review.outcome === 'accepted') return '用户已接受';
  return 'AI 复核通过';
}

export function sameReviewTask(artifacts: Artifact[], tasks: Task[]) {
  const taskMap = new Map(tasks.map((task) => [task.id, task]));
  const roots = artifacts.map((artifact) => {
    let task = artifact.taskId ? taskMap.get(artifact.taskId) : undefined;
    const seen = new Set<string>();
    while (task?.parentId && !seen.has(task.id)) {
      seen.add(task.id);
      const parent = taskMap.get(task.parentId);
      if (!parent) return undefined;
      task = parent;
    }
    return task?.id;
  });
  return roots.length > 0 && !!roots[0] && roots.every((root) => root === roots[0]);
}

export function reviewMatchesArtifacts(
  review: Pick<ArtifactReview, 'targets'> & { reviewInputArtifactIds?: string[] },
  artifactIds: ReadonlySet<string>,
) {
  return (
    review.targets.some((target) => artifactIds.has(target.artifactId)) ||
    !!review.reviewInputArtifactIds?.some((id) => artifactIds.has(id))
  );
}
