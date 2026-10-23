import { useState } from 'react';
import { Check, Send, X } from 'lucide-react';
import type { ConnectorDraftView } from '../../../../src/domain/connector-drafts.js';
import { draftFieldValue, withDraftField } from '../../../../src/domain/connector-drafts.js';
import { Button, Confirm, ErrorNote, Field, Modal, inputClass } from '../components.js';
import type { Mutate } from '../store.js';
import { errorMessage } from '../api.js';
import { ModalPresence } from '../ModalPresence.js';
import { useResource } from '../local-work/useResource.js';

const statusLabels = {
  draft: '待确认',
  approved: '已确认，等待发送',
  sending: '正在发送',
  sent: '已发送',
  failed: '发送失败',
  unknown: '需要核查',
  cancelled: '已取消',
};

export function ConnectorDraftsPanel({
  conversationId,
  mutate,
  compact = false,
}: {
  conversationId?: string;
  mutate: Mutate;
  compact?: boolean;
}) {
  const resource = useResource<ConnectorDraftView[]>(
    'connectorDrafts.list',
    conversationId ? { conversationId } : {},
  );
  const active =
    resource.value?.filter((draft) => !['sent', 'cancelled'].includes(draft.status)) ?? [];
  const history =
    resource.value?.filter((draft) => ['sent', 'cancelled'].includes(draft.status)) ?? [];
  if (compact && !active.length && !resource.error) return null;
  return (
    <section className="grid min-w-0 gap-3" aria-label="外发草稿">
      {!compact && (
        <div>
          <h3 className="text-sm font-semibold">外发草稿</h3>
          <p className="mt-1 text-xs text-slate-500">
            核对收件人和内容后确认，发送沿用成员的当前授权与审批。
          </p>
        </div>
      )}
      <ErrorNote error={resource.error} />
      {active.map((draft) => (
        <DraftCard
          key={`${draft.id}:${draft.revision}`}
          draft={draft}
          mutate={mutate}
          changed={resource.reload}
        />
      ))}
      {!compact && history.length > 0 && (
        <details>
          <summary className="cursor-pointer text-sm text-slate-500">
            发送历史（{history.length}）
          </summary>
          <div className="mt-3 grid gap-3">
            {history.map((draft) => (
              <DraftCard key={draft.id} draft={draft} mutate={mutate} changed={resource.reload} />
            ))}
          </div>
        </details>
      )}
      {!compact && !active.length && !history.length && (
        <p className="text-sm text-slate-500">让成员先准备邮件或消息草稿，确认后再发送。</p>
      )}
    </section>
  );
}

function DraftCard({
  draft,
  mutate,
  changed,
}: {
  draft: ConnectorDraftView;
  mutate: Mutate;
  changed: () => void;
}) {
  const [args, setArgs] = useState(draft.arguments);
  const [json, setJson] = useState(JSON.stringify(draft.arguments, null, 2));
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [reconciling, setReconciling] = useState(false);
  const editable = ['draft', 'failed'].includes(draft.status);
  const canContinue =
    draft.status === 'approved' &&
    ['failed', 'cancelled', 'interrupted', 'completed'].includes(draft.dispatchStatus ?? '');
  async function run(action: () => Promise<unknown>) {
    setError('');
    setBusy(true);
    try {
      await action();
      changed();
    } catch (cause) {
      setError(errorMessage(cause));
      throw cause;
    } finally {
      setBusy(false);
    }
  }
  function parsed() {
    const value: unknown = JSON.parse(json);
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new Error('工具参数需为 JSON 对象');
    return value as Record<string, unknown>;
  }
  function updateField(path: string[], value: string | string[]) {
    try {
      const next = withDraftField(args, path, value);
      setArgs(next);
      setJson(JSON.stringify(next, null, 2));
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }
  async function confirm() {
    let revision = draft.revision;
    if (editable && JSON.stringify(parsed()) !== JSON.stringify(draft.arguments)) {
      const saved = await mutate<ConnectorDraftView>('connectorDrafts.update', {
        id: draft.id,
        revision,
        arguments: parsed(),
      });
      revision = saved.revision;
    }
    await mutate('connectorDrafts.confirm', {
      id: draft.id,
      revision,
      requestId: crypto.randomUUID(),
    });
  }
  return (
    <article className="min-w-0 rounded-xl border border-blue-100 bg-white p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h4 className="break-words text-sm font-semibold">{draft.title}</h4>
          <p className="mt-1 text-xs text-slate-500">
            {draft.connectionName} · {draft.botName} · 版本 {draft.revision}
          </p>
        </div>
        <span
          className={`text-xs ${draft.status === 'unknown' || draft.status === 'failed' ? 'text-amber-700' : 'text-slate-500'}`}
        >
          {statusLabels[draft.status]}
        </span>
      </div>
      <div className="mt-3 grid gap-3">
        {draft.fields.map((field) => {
          const value = draftFieldValue(args, field.path);
          const list = Array.isArray(value);
          const text = list ? value.join('\n') : String(value ?? '');
          return (
            <Field
              key={JSON.stringify(field.path)}
              label={field.label}
              hint={list ? '每行一项。' : undefined}
            >
              {field.kind === 'body' || list ? (
                <textarea
                  className={inputClass}
                  rows={field.kind === 'body' ? 5 : 2}
                  value={text}
                  readOnly={!editable}
                  onChange={(event) =>
                    updateField(
                      field.path,
                      list ? event.target.value.split('\n') : event.target.value,
                    )
                  }
                />
              ) : (
                <input
                  className={inputClass}
                  value={text}
                  readOnly={!editable}
                  onChange={(event) => updateField(field.path, event.target.value)}
                />
              )}
            </Field>
          );
        })}
      </div>
      <details className="mt-3 text-xs">
        <summary className="cursor-pointer text-slate-500">完整工具参数 · {draft.toolName}</summary>
        <textarea
          aria-label="完整工具参数"
          spellCheck={false}
          className={`${inputClass} mt-2 font-mono text-xs`}
          rows={6}
          value={json}
          readOnly={!editable}
          onChange={(event) => {
            setJson(event.target.value);
            try {
              const next: unknown = JSON.parse(event.target.value);
              if (next && typeof next === 'object' && !Array.isArray(next))
                setArgs(next as Record<string, unknown>);
            } catch {
              /* 保留正在编辑的 JSON。 */
            }
          }}
        />
      </details>
      <ErrorNote error={error || draft.error || draft.sendBlockedReason || ''} />
      {draft.result && (
        <details className="mt-3 text-xs">
          <summary className="cursor-pointer text-slate-500">实际发送结果</summary>
          <pre className="mt-2 max-h-52 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-slate-50 p-3">
            {draft.result}
          </pre>
        </details>
      )}
      <div className="mt-3 flex flex-wrap justify-end gap-2">
        {editable && (
          <>
            <Button
              disabled={busy}
              onClick={() =>
                void run(() =>
                  mutate('connectorDrafts.cancel', { id: draft.id, revision: draft.revision }),
                ).catch(() => {})
              }
            >
              <X size={14} />
              取消草稿
            </Button>
            <Button
              disabled={busy}
              onClick={() =>
                void run(() =>
                  mutate('connectorDrafts.update', {
                    id: draft.id,
                    revision: draft.revision,
                    arguments: parsed(),
                  }),
                ).catch(() => {})
              }
            >
              保存修改
            </Button>
          </>
        )}
        {(editable || canContinue) && (
          <Confirm
            title={`确认发送“${draft.title}”？`}
            description={`通过 ${draft.connectionName} 的 ${draft.toolName} 发送卡片中确认的参数。`}
            actionLabel="确认发送"
            onConfirm={() => run(confirm)}
          >
            <Button variant="primary" disabled={busy || !!draft.sendBlockedReason}>
              <Send size={14} />
              {canContinue ? '继续发送' : '确认发送'}
            </Button>
          </Confirm>
        )}
        {draft.status === 'sent' && (
          <span className="flex items-center gap-1 text-xs text-green-700">
            <Check size={14} />
            发送完成
          </span>
        )}
        {draft.status === 'unknown' && (
          <Button onClick={() => setReconciling(true)}>我已核查外部结果</Button>
        )}
      </div>
      <ModalPresence show={reconciling}>
        {reconciling && (
          <ReconcileDraft
            save={(outcome, note) =>
              run(() =>
                mutate('connectorDrafts.reconcile', {
                  id: draft.id,
                  revision: draft.revision,
                  outcome,
                  note,
                }),
              ).then(() => setReconciling(false))
            }
            close={() => setReconciling(false)}
          />
        )}
      </ModalPresence>
    </article>
  );
}

function ReconcileDraft({
  save,
  close,
}: {
  save: (outcome: string, note: string) => Promise<unknown>;
  close: () => void;
}) {
  const [outcome, setOutcome] = useState('sent');
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <Modal open onOpenChange={(open) => !open && close()} title="核查发送结果">
      <div className="grid gap-4">
        <p className="text-sm text-slate-500">先在目标应用核实消息或邮件，再记录实际结果。</p>
        <Field label="核查结果">
          <select
            className={inputClass}
            value={outcome}
            onChange={(event) => setOutcome(event.target.value)}
          >
            <option value="sent">已发送成功</option>
            <option value="not_sent">确认未发送，重新准备草稿</option>
          </select>
        </Field>
        <Field label="核查说明">
          <textarea
            className={inputClass}
            rows={3}
            value={note}
            onChange={(event) => setNote(event.target.value)}
            placeholder="例如：已在目标频道找到该消息。"
          />
        </Field>
        <ErrorNote error={error} />
        <div className="flex justify-end gap-2">
          <Button onClick={close}>取消</Button>
          <Button
            variant="primary"
            disabled={busy || !note.trim()}
            onClick={() => {
              setBusy(true);
              void save(outcome, note)
                .catch((cause) => setError(errorMessage(cause)))
                .finally(() => setBusy(false));
            }}
          >
            保存核查结果
          </Button>
        </div>
      </div>
    </Modal>
  );
}
