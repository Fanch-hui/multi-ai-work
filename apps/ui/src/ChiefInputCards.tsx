import { useState } from 'react';
import type { ChiefInput } from '../../../src/domain/chief-work.js';
import type { Snapshot } from '../../../src/domain/types.js';
import type { Mutate } from './store.js';
import { Button, ErrorNote, inputClass } from './components.js';
import { errorMessage } from './api.js';

export function ChiefInputCards({ data, mutate }: { data: Snapshot; mutate: Mutate }) {
  const inputs =
    data.chief?.inputs.filter((input) =>
      ['pending', 'routing', 'clarification', 'failed'].includes(input.status),
    ) ?? [];
  if (!inputs.length) return null;
  return (
    <div className="grid min-w-0 gap-3" aria-label="待确认的工作事项">
      {inputs.map((input) => (
        <ChiefInputCard key={input.id} input={input} data={data} mutate={mutate} />
      ))}
    </div>
  );
}

function ChiefInputCard({
  input,
  data,
  mutate,
}: {
  input: ChiefInput;
  data: Snapshot;
  mutate: Mutate;
}) {
  const [answer, setAnswer] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const contexts =
    data.chief?.contexts.filter(
      (context) =>
        !input.candidateContextIds?.length || input.candidateContextIds.includes(context.id),
    ) ?? [];
  async function act(method: string, fields: Record<string, unknown> = {}) {
    setBusy(true);
    setError('');
    try {
      await mutate(method, { id: input.id, ...fields });
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }
  const waiting = input.status === 'pending' || input.status === 'routing';
  const content =
    input.content ?? data.messages.find((item) => item.id === input.messageId)?.content;
  const prompt = input.status === 'failed' ? input.error : input.question;
  return (
    <section className="min-w-0 rounded-xl border border-slate-200 bg-white p-4">
      {content && (
        <p className="mb-2 line-clamp-2 text-xs leading-5 text-slate-400" aria-label="待确认消息">
          {content}
        </p>
      )}
      <p className="text-sm text-slate-700" role={waiting ? 'status' : undefined}>
        {waiting ? '正在确认这条消息所属的事项…' : prompt || '这条消息需要确认所属事项。'}
      </p>
      {input.status === 'clarification' && (
        <div className="mt-3 grid gap-3">
          <div className="flex flex-wrap gap-2">
            {contexts.map((context) => (
              <Button
                key={context.id}
                disabled={busy}
                onClick={() => void act('chief.inputs.resolve', { contextId: context.id })}
              >
                {context.title}
                {data.workspaces.find((item) => item.id === context.workspaceId)?.name &&
                  ` · ${data.workspaces.find((item) => item.id === context.workspaceId)!.name}`}
              </Button>
            ))}
            <Button
              disabled={busy}
              onClick={() => void act('chief.inputs.resolve', { newContext: true })}
            >
              作为新事项
            </Button>
          </div>
          <form
            className="flex gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              if (answer.trim()) void act('chief.inputs.resolve', { answer: answer.trim() });
            }}
          >
            <input
              className={inputClass}
              aria-label="补充事项说明"
              placeholder="补充说明"
              value={answer}
              onChange={(event) => setAnswer(event.target.value)}
              disabled={busy}
            />
            <Button disabled={busy || !answer.trim()}>提交</Button>
          </form>
        </div>
      )}
      <ErrorNote error={error} />
      <div className="mt-3 flex gap-2">
        {input.status === 'failed' && (
          <Button disabled={busy} onClick={() => void act('chief.inputs.retry')}>
            重试
          </Button>
        )}
        <Button variant="ghost" disabled={busy} onClick={() => void act('chief.inputs.cancel')}>
          取消这条消息
        </Button>
      </div>
    </section>
  );
}
