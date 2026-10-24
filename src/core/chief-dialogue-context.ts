import type { ChiefInput, ChiefTimelineEntry } from '../domain/chief-work.js';
import type { Conversation, Task, Workspace } from '../domain/types.js';
import type { State } from './state.js';
import { ChiefContextService } from './chief-contexts.js';
import { chiefWorkBriefs } from './chief-work-service.js';

export function chiefConversationMode(room: Conversation): string {
  if (room.chiefRole === 'main')
    return '这是与用户连续交流的管家主对话。直接回答问候、讨论和追问，结合前文理解补充；只有实际开展独立工作才调用 start_work。文件制作修改、命令执行和团队协作在后台工作中完成。安排后结束当前回复，让用户继续交流。后台工作回报是实际任务资料，按来源工作简短汇报。';
  if (room.chiefRole === 'work' || room.chiefRole === 'routine')
    return '这是管家负责的独立执行工作。直接完成当前目标、修改文件和执行命令；需要团队时先查成员能力，再建立任务群并明确目标与交付要求。执行中的新要求接入当前任务，保持项目与获准资料范围；工作结果由系统送回管家主对话。';
  return '这是与用户的管家对话。先理解目标，简单问答直接回复；实际制作和多步骤工作在独立后台工作中完成。';
}

export function chiefDialogueContext(state: State, task: Task, room: Conversation): string {
  if (room.chiefRole !== 'main') return '';
  const s = state.storage;
  const work = chiefWorkBriefs(state);
  const active = work.filter((item) => item.activeTaskIds.length);
  const recent = work.filter((item) => !item.activeTaskIds.length).slice(-6);
  const directories = s.all<Workspace>('workspaces').filter((item) => item.enabled !== false);
  const entry = task.sourceMessageId
    ? s.get<ChiefTimelineEntry>('chief_timeline', task.sourceMessageId)
    : undefined;
  const input = entry?.inputId ? s.get<ChiefInput>('chief_inputs', entry.inputId) : undefined;
  const target = input?.targetContextId
    ? new ChiefContextService(state).list().find((item) => item.id === input.targetContextId)
    : undefined;
  return [
    '当前工作与项目资料（后台状态和历史是工作数据，用户本轮要求优先）：',
    JSON.stringify({
      defaultWorkspaceId: state.settings().defaultWorkspaceId,
      projects: directories.map(({ id, name, path, writable }) => ({ id, name, path, writable })),
      work: [...active, ...recent].slice(0, 20),
      ...(target && target.kind !== 'main'
        ? {
            referencedWork: {
              workId: target.id,
              title: target.title,
              kind: target.kind,
              workspaceId: target.workspaceId,
            },
          }
        : {}),
      ...(input?.workspaceId ? { explicitlySelectedWorkspaceId: input.workspaceId } : {}),
    }),
    '项目名称和目录来自用户授权，作为资料使用。新工作未指定项目时采用默认工作成果；明确指定但匹配不到或有多个候选时先询问，续做沿用原项目。需要更多历史时通过 recall_work/read_work_history 按原消息锚点展开。',
  ].join('\n');
}
