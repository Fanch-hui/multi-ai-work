import type { Snapshot, Task } from '../../../../src/domain/types.js';
import type { WorkSkillDraft } from '../../../../src/domain/work-skills.js';
import type { Routine } from '../../../../src/domain/routines.js';
import type { CollaborationRequest } from '../../../../src/domain/collaboration.js';
import type { Mutate } from '../store.js';
import { Button, ErrorNote } from '../components.js';
import { useResource } from '../local-work/useResource.js';
import { RoutineWorkCard } from './RoutineWorkCard.js';
import { SkillDraftCard } from './SkillDraftCard.js';
import { ConnectorDraftsPanel } from '../connectors/ConnectorDraftsPanel.js';

export function conversationSkillDrafts(drafts: WorkSkillDraft[], conversationId: string) {
  return drafts.filter((draft) => draft.sourceConversationId === conversationId && !draft.skillId);
}

export function activeCollaborations(requests: CollaborationRequest[]) {
  return requests.filter((item) => item.status === 'requested' || item.status === 'assigned');
}

export function recentCollaborations(requests: CollaborationRequest[]) {
  return requests
    .filter((item) => item.status !== 'requested' && item.status !== 'assigned')
    .sort((first, second) => second.updatedAt.localeCompare(first.updatedAt))
    .slice(0, 3);
}

export function WorkCards({
  data,
  conversationId,
  mutate,
  onSelectConversation,
}: {
  data: Snapshot;
  conversationId: string;
  mutate: Mutate;
  onSelectConversation: (id: string) => void;
}) {
  const skills = useResource<WorkSkillDraft[]>('workSkills.list');
  const routines = useResource<Routine[]>('routines.list');
  const collaboration = useResource<(CollaborationRequest & { task?: Task })[]>(
    'collaboration.list',
    { conversationId },
  );
  const drafts = conversationSkillDrafts(skills.value ?? [], conversationId);
  const schedules =
    routines.value?.filter((routine) => routine.conversationId === conversationId) ?? [];
  const requests = activeCollaborations(collaboration.value ?? []);
  const history = recentCollaborations(collaboration.value ?? []);
  return (
    <div className="space-y-2" aria-label="会话工作卡片">
      <ErrorNote error={skills.error || routines.error || collaboration.error} />
      <ConnectorDraftsPanel conversationId={conversationId} mutate={mutate} compact />
      {drafts.length > 0 && (
        <details className="rounded-lg border border-blue-100 bg-blue-50/60 p-3">
          <summary className="cursor-pointer text-xs font-medium text-blue-800">
            {drafts.length} 份工作技能待审阅
          </summary>
          <div className="mt-3 space-y-2">
            {drafts.map((draft) => (
              <SkillDraftCard
                key={draft.id}
                draft={draft}
                mutate={mutate}
                refresh={skills.reload}
              />
            ))}
          </div>
        </details>
      )}
      {schedules.map((routine) => (
        <RoutineWorkCard
          key={routine.id}
          routine={routine}
          mutate={mutate}
          refresh={routines.reload}
        />
      ))}
      {requests.length > 0 && (
        <details className="rounded-lg border border-slate-200 bg-white p-3">
          <summary className="cursor-pointer text-xs font-medium text-slate-700">
            {requests.length} 项成员协作进行中
          </summary>
          <div className="mt-3 space-y-3">
            {requests.map((item) => {
              const source = data.bots.find((bot) => bot.id === item.sourceBotId)?.name ?? '成员';
              const target = data.bots.find((bot) => bot.id === item.targetBotId)?.name ?? '成员';
              const task = data.tasks.find((task) => task.id === item.targetTaskId);
              return (
                <article key={item.id} className="text-xs text-slate-600">
                  <p className="font-medium">
                    {source} → {target} · {collaborationStatus(item)}
                  </p>
                  <p className="mt-1 line-clamp-2 leading-5">{item.goal}</p>
                  {task && (
                    <Button
                      className="mt-1 px-0 text-xs"
                      variant="ghost"
                      onClick={() => onSelectConversation(task.conversationId)}
                    >
                      查看协作对话 →
                    </Button>
                  )}
                </article>
              );
            })}
          </div>
        </details>
      )}
      {history.length > 0 && (
        <details className="rounded-lg border border-slate-100 bg-white p-3">
          <summary className="cursor-pointer text-xs text-slate-500">
            最近协作结果 · {history.length}
          </summary>
          <div className="mt-2 space-y-2">
            {history.map((item) => (
              <article key={item.id} className="text-xs text-slate-600">
                <p className="line-clamp-2">{item.goal}</p>
                <p className="mt-1 text-slate-500">
                  {collaborationOutcome(item.status)}
                  {item.feedback ? ` · ${item.feedback}` : ''}
                  {item.deliveryError && ` · 回传待处理：${item.deliveryError}`}
                </p>
              </article>
            ))}
          </div>
        </details>
      )}
    </div>
  );
}

function collaborationOutcome(status: CollaborationRequest['status']) {
  if (status === 'completed') return '已完成并回传';
  if (status === 'declined') return '主管未安排';
  return '执行失败';
}

function collaborationStatus(item: CollaborationRequest) {
  if (item.awaitingTaskResume) return '等待继续原任务';
  return item.status === 'requested' ? '等待主管安排' : '已交接';
}
