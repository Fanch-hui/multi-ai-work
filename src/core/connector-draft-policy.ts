import { z } from 'zod';
import { toolConfiguration } from '../domain/tool-connection.js';
import type { ConnectorDraft, ConnectorDraftField } from '../domain/connector-drafts.js';
import { draftFieldValue } from '../domain/connector-drafts.js';
import type { ToolExecutionContext } from '../domain/tools.js';
import type { Bot, Conversation, ToolConnection } from '../domain/types.js';
import type { State } from './state.js';
import { required } from './errors.js';

export const draftFieldSchema = z.object({
  path: z.array(z.string().trim().min(1).max(100)).min(1).max(8),
  label: z.string().trim().min(1).max(100),
  kind: z.enum(['recipient', 'subject', 'body', 'text', 'list']),
});

export function connectorConfiguration(state: State, connection: ToolConnection) {
  return JSON.stringify([
    toolConfiguration(connection),
    state.storage.metadata(`connector-account-revision:${connection.id}`) ?? 0,
  ]);
}

export function draftSendBlockedReason(state: State, botId: string): string | undefined {
  const bot = state.storage.get<Bot>('bots', botId);
  if (!bot?.toolNames.includes('send_connector_draft'))
    return '请到“我的团队”的成员配置中，在工具权限里启用连接器草稿的发送权限。';
}

export function validateDraftArguments(
  args: Record<string, unknown>,
  fields: ConnectorDraftField[],
) {
  if (JSON.stringify(args).length > 120_000) throw new Error('草稿内容超过 120,000 字符');
  function inspect(value: unknown, depth = 0) {
    if (depth > 16) throw new Error('草稿参数层级过深');
    if (!value || typeof value !== 'object') return;
    for (const [key, item] of Object.entries(value)) {
      if (
        /^(?:__proto__|prototype|constructor|authorization|cookie|password|secret|token|api[_-]?key|access[_-]?token|refresh[_-]?token)$/i.test(
          key,
        )
      )
        throw new Error('认证信息请在连接器设置中配置');
      inspect(item, depth + 1);
    }
  }
  inspect(args);
  if (
    !fields.some((field) => field.kind === 'recipient') ||
    !fields.some((field) => field.kind === 'body')
  )
    throw new Error('草稿需标明收件人或目标位置，以及正文');
  const paths = fields.map((field) => JSON.stringify(field.path));
  if (new Set(paths).size !== paths.length) throw new Error('草稿字段路径重复');
  for (const field of fields) {
    const value = draftFieldValue(args, field.path);
    if (
      !(
        typeof value === 'string' ||
        (Array.isArray(value) && value.every((item) => typeof item === 'string'))
      )
    )
      throw new Error(`草稿字段“${field.label}”需对应文本或文本列表`);
    if (
      ['recipient', 'body'].includes(field.kind) &&
      (!value.length ||
        (typeof value === 'string' ? !value.trim() : !value.every((item) => item.trim())))
    )
      throw new Error(`请填写${field.label}`);
  }
}

export function draftConnection(
  state: State,
  botId: string,
  conversationId: string,
  connectionId: string,
  toolName: string,
): ToolConnection {
  const bot = required(state.storage.get<Bot>('bots', botId), '智能体不存在');
  const room = state.storage.get<Conversation>('conversations', conversationId);
  if (bot.archived || !room || room.archived || !room.memberIds.includes(botId))
    throw new Error('草稿所属成员或会话已不可用');
  if (!bot.toolNames.includes('call_mcp') || !bot.toolConnectionIds?.includes(connectionId))
    throw new Error('成员未获准使用此连接器');
  const connection = required(
    state.storage.get<ToolConnection>('tool_connections', connectionId),
    '连接器不存在',
  );
  if (!connection.enabled || connection.kind === 'search')
    throw new Error('此连接器未启用外部工具');
  if (!connection.toolNames.includes(toolName))
    throw new Error('工具不在连接器目录中，请先检测连接');
  return connection;
}

export function assertDraftContext(
  state: State,
  draft: ConnectorDraft,
  context: ToolExecutionContext,
) {
  context.signal.throwIfAborted();
  context.assertAuthorized?.();
  if (draft.botId !== context.botId || draft.conversationId !== context.conversation.id)
    throw new Error('草稿不属于当前成员与会话');
  const connection = draftConnection(
    state,
    draft.botId,
    draft.conversationId,
    draft.connectionId,
    draft.toolName,
  );
  if (draft.connectionConfiguration !== connectorConfiguration(state, connection))
    throw new Error('连接器配置已更改，请重新创建草稿并确认');
  return connection;
}
