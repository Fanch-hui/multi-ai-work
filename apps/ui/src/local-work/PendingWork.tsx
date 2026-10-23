import { useState } from 'react';
import type { Snapshot } from '../../../../src/domain/types.js';
import type { TaskWait } from '../../../../src/domain/task-wait.js';
import type { Mutate } from '../store.js';
import { Button, ErrorNote, Modal } from '../components.js';
import { ApprovalCard } from '../TaskDetail.js';
import { UserQuestionCard } from '../UserQuestionCard.js';
import { useResource } from './useResource.js';
import { TaskWaitCard } from './TaskWaitCard.js';
import { ComputerPanel } from '../computer/ComputerPanel.js';

export function PendingWork({
  data,
  mutate,
  close,
  onSelectConversation,
}: {
  data: Snapshot;
  mutate: Mutate;
  close: () => void;
  onSelectConversation: (id: string, openBrowser?: boolean) => void;
}) {
  const waits = useResource<TaskWait[]>('waits.list');
  const [computerOpen, setComputerOpen] = useState(false);
  const questions = data.questions.filter((question) => question.status === 'pending');
  const approvals = data.approvals.filter((approval) => approval.status === 'pending');
  const pending =
    waits.value?.filter(
      (wait) =>
        wait.status === 'pending' &&
        wait.kind !== 'browser-resource' &&
        wait.kind !== 'computer-resource',
    ) ?? [];
  const count = questions.length + approvals.length + pending.length;
  function jump(id: string, openBrowser = false) {
    close();
    onSelectConversation(id, openBrowser);
  }
  if (computerOpen)
    return <ComputerPanel data={data} mutate={mutate} close={() => setComputerOpen(false)} />;
  return (
    <Modal
      open
      onOpenChange={(open) => {
        if (!open) close();
      }}
      title={`待我处理${count ? ` · ${count}` : ''}`}
      wide
    >
      <ErrorNote error={waits.error} />
      {!count && !waits.loading && (
        <p className="py-6 text-center text-sm text-slate-500">当前没有需要处理的事项。</p>
      )}
      <div className="space-y-4">
        {questions.map((question) => (
          <section key={question.id}>
            <ContextLink id={question.conversationId} data={data} jump={jump} />
            <UserQuestionCard question={question} data={data} mutate={mutate} hideResolved />
          </section>
        ))}
        {approvals.map((approval) => {
          const task = data.tasks.find((item) => item.id === approval.taskId);
          return (
            <section key={approval.id}>
              {task && <ContextLink id={task.conversationId} data={data} jump={jump} />}
              <ApprovalCard approval={approval} data={data} mutate={mutate} />
            </section>
          );
        })}
        {pending.map((wait) => (
          <section key={wait.id}>
            <ContextLink id={wait.conversationId} data={data} jump={jump} />
            <TaskWaitCard
              wait={wait}
              mutate={mutate}
              onBrowser={() => jump(wait.conversationId, true)}
              onComputer={() => setComputerOpen(true)}
              resolved={waits.reload}
            />
          </section>
        ))}
      </div>
    </Modal>
  );
}
function ContextLink({
  id,
  data,
  jump,
}: {
  id: string;
  data: Snapshot;
  jump: (id: string) => void;
}) {
  return (
    <Button className="mb-1 px-0 text-xs" variant="ghost" onClick={() => jump(id)}>
      {data.conversations.find((item) => item.id === id)?.name ?? '查看所属对话'} →
    </Button>
  );
}
