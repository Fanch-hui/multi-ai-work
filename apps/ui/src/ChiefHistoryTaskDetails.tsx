import { useState } from 'react';
import type { ChiefHistoryTaskRead } from '../../../src/domain/chief-history-tasks.js';
import type { Snapshot } from '../../../src/domain/types.js';
import type { Mutate } from './store.js';
import { Badge, Button, ErrorNote, timeLabel } from './components.js';
import { useResource } from './local-work/useResource.js';
import { TaskDetail } from './TaskDetail.js';
import { MessageArtifacts } from './MessageArtifacts.js';

export function ChiefHistoryTaskDetails({
  contextId,
  data,
  mutate,
}: {
  contextId: string;
  data: Snapshot;
  mutate: Mutate;
}) {
  const [partId, setPart] = useState<string>();
  const [cursors, setCursors] = useState<number[]>([]);
  const [taskId, setTask] = useState<string>();
  const resource = useResource<ChiefHistoryTaskRead>('chief.history.tasks.read', {
    contextId,
    partId,
    before: cursors.at(-1),
    limit: 40,
  });
  const value = resource.value;
  const tasks = [
    ...data.tasks.filter((task) => !value?.tasks.some((item) => item.id === task.id)),
    ...(value?.tasks ?? []),
  ];
  const scopedData = { ...data, tasks };
  const selected = value?.tasks.find((task) => task.id === taskId);
  return (
    <section
      aria-label="历史任务详情"
      className="mt-3 grid min-w-0 gap-4 border-t border-slate-100 pt-3"
    >
      <ErrorNote error={resource.error} />
      {resource.loading && (
        <p role="status" className="text-xs text-slate-500">
          正在读取执行上下文…
        </p>
      )}
      {resource.error && <Button onClick={resource.reload}>重新读取</Button>}
      {value && (
        <>
          <label className="grid gap-2 text-xs text-slate-500">
            执行上下文
            <select
              aria-label="选择执行上下文"
              className="min-w-0 rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700"
              value={value.part.id}
              onChange={(event) => {
                setPart(event.target.value);
                setCursors([]);
                setTask(undefined);
              }}
            >
              {value.parts.map((part, index) => (
                <option key={part.id} value={part.id}>
                  第 {index + 1} 段 · {timeLabel(part.createdAt)}
                </option>
              ))}
            </select>
          </label>
          <section aria-label="指令来源" className="grid min-w-0 gap-2">
            <h3 className="text-xs font-medium text-slate-600">指令来源</h3>
            {value.instructions.map((instruction) => (
              <article
                key={instruction.messageId}
                className="min-w-0 rounded-lg bg-blue-50/60 p-3"
                data-instruction-context-id={instruction.contextId}
              >
                <p className="text-xs text-slate-500">
                  来源：{instruction.contextTitle} · {timeLabel(instruction.createdAt)}
                </p>
                <p className="mt-1 whitespace-pre-wrap break-words text-sm text-slate-700">
                  {instruction.content || '附件指令'}
                </p>
                <div className="mt-2 flex flex-wrap gap-2">
                  {instruction.taskIds.map((id) => {
                    const task = value.tasks.find((item) => item.id === id);
                    return (
                      task && (
                        <Button key={id} variant="ghost" onClick={() => setTask(id)}>
                          查看任务：{task.goal}
                        </Button>
                      )
                    );
                  })}
                </div>
              </article>
            ))}
            {!value.instructions.length && (
              <p className="text-xs text-slate-500">这一页没有关联的用户指令。</p>
            )}
          </section>
          {value.part.handoff && (
            <details className="min-w-0">
              <summary className="cursor-pointer text-xs text-slate-500">上下文交接</summary>
              <p className="mt-2 whitespace-pre-wrap break-words text-sm text-slate-600">
                {value.part.handoff}
              </p>
            </details>
          )}
          <section aria-label="执行上下文消息" className="grid min-w-0 gap-3">
            {!!value.nextBefore && (
              <Button
                disabled={resource.loading}
                onClick={() => setCursors([...cursors, value.nextBefore!])}
              >
                更早消息
              </Button>
            )}
            <div className="grid max-h-96 min-w-0 gap-3 overflow-auto">
              {value.messages.map((message) => {
                const bot = data.bots.find((item) => item.id === message.authorBotId);
                const author =
                  bot?.name ?? { user: '你', bot: '管家', system: '系统' }[message.authorType];
                const room = data.conversations.find((item) => item.id === message.conversationId);
                return (
                  <article
                    key={message.id}
                    data-context-message-id={message.id}
                    className="min-w-0 rounded-lg bg-slate-50 p-3"
                  >
                    <p className="text-xs text-slate-500">
                      {author} · {timeLabel(message.createdAt)}
                    </p>
                    <p className="mt-1 whitespace-pre-wrap break-words text-sm leading-6 text-slate-700">
                      {message.content}
                    </p>
                    {room && (
                      <MessageArtifacts
                        ids={message.artifactIds}
                        user={message.authorType === 'user'}
                        conversation={room}
                        data={scopedData}
                        mutate={mutate}
                      />
                    )}
                  </article>
                );
              })}
              {!value.messages.length && <p className="text-xs text-slate-500">这一段暂无消息。</p>}
            </div>
            {cursors.length > 0 && (
              <Button disabled={resource.loading} onClick={() => setCursors(cursors.slice(0, -1))}>
                较新消息
              </Button>
            )}
          </section>
          {value.tasks.length > 0 && (
            <details className="min-w-0">
              <summary className="cursor-pointer text-xs text-slate-500">
                任务记录 · {value.tasks.length} 项
              </summary>
              <div className="mt-2 grid min-w-0 gap-2">
                {value.tasks.map((task) => (
                  <Button
                    key={task.id}
                    className="justify-start text-left"
                    onClick={() => setTask(task.id)}
                  >
                    <span className="min-w-0 flex-1 truncate">{task.goal}</span>
                    <Badge status={task.status} />
                  </Button>
                ))}
              </div>
            </details>
          )}
          {selected && (
            <div className="min-w-0">
              <Button variant="ghost" onClick={() => setTask(undefined)}>
                收起任务详情
              </Button>
              <TaskDetail
                key={selected.id}
                task={selected}
                data={scopedData}
                mutate={mutate}
                onSelect={setTask}
              />
            </div>
          )}
        </>
      )}
    </section>
  );
}
