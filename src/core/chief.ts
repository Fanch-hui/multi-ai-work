import { randomUUID } from 'node:crypto';
import type { Bot, Conversation, Settings, Workspace } from '../domain/types.js';
import type { Storage } from './storage.js';
import {
  chiefToolNames,
  fullToolNames,
  taskPlanToolNames,
  taskControlToolNames,
} from '../domain/tool-permissions.js';

export const chiefTools = chiefToolNames;
export const chiefRole = '团队管家';
export const chiefInstructions =
  '你是用户在 multi-AI work 的专属管家，也是团队主管。温和、简洁、主动负责，理解目标并跟进到交付。用户始终在一个连续主对话里交流，问候、能力询问、追问和补充自然接续前文。主对话负责交流、查阅、安排和控制工作；制作修改文件、命令及多步骤执行用 start_work 启动你自己的独立后台工作，返回后简短告知安排，主对话继续可用。先用 list_work 查看已有工作；活动工作补充用 send_task_input，停止用 stop_task，已结束的工作通过 start_work 的 workId 续做。后台工作中可直接执行，需要团队时用 list_bots 了解成员并 create_task_group，只邀请相关成员。新工作没提项目使用工作成果；点名项目匹配不到或有重名时先自然提问确认，续做沿用原项目。你可查阅全部已授权项目，成员仅使用派发任务的项目和资料。需要旧细节先用 recall_work，再用 read_work_history 展开相关原文与成果。缺少关键信息用 ask_user，已明确的事直接推进，执行方式遵从用户设置。维护自己的及团队公共记忆。依据实际工具、任务状态和交付文件汇报，失败及未知结果如实说明。';

export function publicBot(bot: Bot, chiefId?: string): Bot {
  return bot.id === chiefId ? { ...bot, role: '', instructions: '' } : bot;
}

export function ensureMainTeam(storage: Storage, settings: Settings): Settings {
  return storage.transaction(() => {
    let chief = settings.mainBotId ? storage.get<Bot>('bots', settings.mainBotId) : undefined;
    if (!chief) {
      chief = {
        id: randomUUID(),
        name: 'Chief',
        role: chiefRole,
        connectionId: '',
        model: '',
        instructions: chiefInstructions,
        color: '#3b82f6',
        toolNames: fullToolNames(true),
        approvalMode: 'auto',
        skillIds: [],
        toolConnectionIds: [],
        memoryMode: 'propose',
        revision: 1,
        archived: false,
      };
      storage.put('bots', chief);
    }
    if (!storage.metadata('chief-management-v1')) {
      const defaultFileTools = ['read_file', 'read_artifact', 'write_artifact'];
      chief = {
        ...chief,
        toolNames: [
          ...new Set([
            ...chief.toolNames.filter((tool) => !defaultFileTools.includes(tool)),
            ...chiefTools,
          ]),
        ],
        instructions: chief.instructions.startsWith('你是用户的主智能体。')
          ? chiefInstructions
          : chief.instructions,
        revision: chief.revision + 1,
      };
      storage.put('bots', chief);
      storage.setMetadata('chief-management-v1', true);
    }
    if (!storage.metadata('chief-history-tools-v1')) {
      chief = {
        ...chief,
        toolNames: [...new Set([...chief.toolNames, 'recall_work', 'read_work_history'])],
        revision: chief.revision + 1,
      };
      storage.put('bots', chief);
      storage.setMetadata('chief-history-tools-v1', true);
    }
    if (!storage.metadata('chief-memory-management-v2')) {
      chief = {
        ...chief,
        toolNames: [...new Set([...chief.toolNames, ...chiefTools])],
        instructions: chief.instructions.startsWith('你是整个 App 的主管与用户对接者。')
          ? chiefInstructions
          : chief.instructions,
        revision: chief.revision + 1,
      };
      storage.put('bots', chief);
      storage.setMetadata('chief-memory-management-v2', true);
    }
    if (!storage.metadata('chief-work-tools-v1')) {
      chief = {
        ...chief,
        toolNames: [...new Set([...chief.toolNames, ...chiefTools])],
        revision: chief.revision + 1,
      };
      storage.put('bots', chief);
      storage.setMetadata('chief-work-tools-v1', true);
    }
    if (!storage.metadata('chief-background-tools-v1')) {
      if (chief.toolNames.includes('create_task_group')) {
        chief = {
          ...chief,
          toolNames: [...new Set([...chief.toolNames, 'start_work', 'list_work'])],
          revision: chief.revision + 1,
        };
        storage.put('bots', chief);
      }
      storage.setMetadata('chief-background-tools-v1', true);
    }
    if (!storage.metadata('chief-task-plans-v1')) {
      if (
        chief.toolNames.includes('delegate_task') ||
        chief.toolNames.includes('create_task_group')
      ) {
        chief = {
          ...chief,
          toolNames: [...new Set([...chief.toolNames, ...taskPlanToolNames])],
          revision: chief.revision + 1,
        };
        storage.put('bots', chief);
      }
      storage.setMetadata('chief-task-plans-v1', true);
    }
    if (!storage.metadata('chief-task-control-v1')) {
      if (
        chief.toolNames.includes('delegate_task') ||
        chief.toolNames.includes('create_task_group')
      ) {
        chief = {
          ...chief,
          toolNames: [...new Set([...chief.toolNames, ...taskControlToolNames])],
          revision: chief.revision + 1,
        };
        storage.put('bots', chief);
      }
      storage.setMetadata('chief-task-control-v1', true);
    }
    if (chief.role !== chiefRole || chief.instructions !== chiefInstructions) {
      chief = {
        ...chief,
        role: chiefRole,
        instructions: chiefInstructions,
        revision: chief.revision + 1,
      };
      storage.put('bots', chief);
    }
    const current = settings.mainConversationId
      ? storage.get<Conversation>('conversations', settings.mainConversationId)
      : undefined;
    const room =
      current?.purpose === 'chief' &&
      current.kind === 'private' &&
      !current.archived &&
      (!current.chiefRole || current.chiefRole === 'home')
        ? current
        : storage
            .all<Conversation>('conversations')
            .filter(
              (item) =>
                item.purpose === 'chief' &&
                item.kind === 'private' &&
                !item.archived &&
                (!item.chiefRole || item.chiefRole === 'home'),
            )
            .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
    const workspace =
      storage.get<Workspace>('workspaces', room?.workspaceId ?? '') ??
      storage.all<Workspace>('workspaces')[0];
    const main: Conversation =
      room?.purpose === 'chief' && room.kind === 'private' && !room.archived
        ? room
        : {
            id: randomUUID(),
            name: chief.name,
            kind: 'private',
            purpose: 'chief',
            chiefId: chief.id,
            memberIds: [chief.id],
            workspaceId: workspace.id,
            createdAt: new Date().toISOString(),
          };
    if (main.id !== room?.id) storage.put('conversations', main);
    const updated = { ...settings, mainBotId: chief.id, mainConversationId: main.id };
    if (JSON.stringify(settings) !== JSON.stringify(updated))
      storage.setMetadata('settings', updated);
    return updated;
  });
}
