import type { State } from './state.js';
import { memoryMessageAuthorized } from './chief-memory-scope.js';

export const memoryGuidance =
  '长期记忆只挑选用户明确表达且以后仍适用的偏好、习惯和持续要求，例如语言、输出风格、协作方式和反复适用的约束。群聊任务目标、预算、日期、进度、材料内容、单次需求变更和其他智能体的讨论留在会话与任务记录，不写入长期记忆。不从一次任务推断用户习惯；无法确认长期适用时跳过。保存时用 sourceIds 引用用户原始消息 ID，保持会话授权范围；合并重复偏好，过时条目停用，无需逐条询问用户。';

export function assertUserMemorySources(
  state: State,
  sourceIds: string[],
  conversationIds: string[],
) {
  if (!sourceIds.length) throw new Error('长期记忆须引用用户表达偏好、习惯或持续要求的原始消息 ID');
  for (const sourceId of sourceIds) {
    const message = state.storage.getMessage(sourceId);
    if (
      !message ||
      message.authorType !== 'user' ||
      !memoryMessageAuthorized(state.storage, sourceId, conversationIds)
    )
      throw new Error('长期记忆来源须为获准会话中的用户消息，不能使用成员讨论或成果');
  }
}
