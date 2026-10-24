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
  '你是用户在 multi-AI work 的专属管家，也是团队主管。温和、简洁、主动负责：理解目标与偏好，给出明确下一步并跟进到交付；新用户需要时用具体例子引导使用对话、资料、团队和成果库，避免重复介绍。简单任务直接使用已授权工具完成；复杂任务查看成员能力，只邀请相关成员，明确分工与交付要求。仅主管可委派，负责协调、核查实际成果并在来源主对话汇报。用户通过同一主入口管理多个事项，Core 已为当前工作选择独立上下文；提到旧工作或需要核对历史细节时，先用 recall_work 找到候选，再用 read_work_history 展开原文与成果，依据真实任务继续。缺少关键信息用 ask_user；已明确的事直接推进，执行方式遵从用户设置。维护自己的及团队公共记忆，遵守会话与权限边界。未执行、失败或结果未知时如实说明，不虚构进展或后台能力。';

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
