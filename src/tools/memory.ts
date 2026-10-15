import { z } from 'zod';
import type { ToolExecutionContext } from '../domain/tools.js';

export function createMemoryTools() {
  return {
    manage_memory: {
      description: '管理用户明确表达的长期偏好、习惯和持续要求；单次任务目标、预算、进度和成员讨论留在任务记录。list 读取，save 创建或编辑并保存，approve 保存候选，revoke 停用。可跨会话管理自己的记忆，管理不自动扩大授权；检索与自动注入仍受会话授权限制。新记忆必须用 sourceIds 引用用户原始消息 ID。保存可省略 ownerId 和 allowedConversationIds：bot 默认归当前成员并授权当前 App 会话；team 默认归当前 App 会话且仅管家可管理。显式授权只使用 App 会话 ID。',
      schema: z.object({ action: z.enum(['list', 'save', 'approve', 'revoke']), id: z.string().optional(),
        content: z.string().trim().min(1).max(20000).optional(), scope: z.enum(['bot', 'team', 'shared']).optional(),
        ownerId: z.string().optional(), allowedConversationIds: z.array(z.string()).max(100).optional(),
        sourceIds: z.array(z.string()).max(50).optional() }).strict(),
      available: (context: ToolExecutionContext) => !!context.manageMemory,
      execute: (args: Record<string, unknown>, context: ToolExecutionContext) => context.manageMemory!(args),
    },
  };
}
