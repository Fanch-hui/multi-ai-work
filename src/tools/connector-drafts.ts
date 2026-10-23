import { z } from 'zod';
import type { ToolExecutionContext } from '../domain/tools.js';

const id = z.string().trim().min(1).max(200);
export function createConnectorDraftTools() {
  const available = (context: ToolExecutionContext) => !!context.connectorDrafts;
  return {
    create_connector_draft: {
      description:
        '为邮件、群消息等外部发送创建可编辑草稿，待用户确认后发送。connectionId 和 toolName 必须来自当前授权连接目录，arguments 使用该工具的真实参数。fields 用参数路径标明 recipient（收件人或频道）与 body（正文），可选 subject 等。认证信息只在连接器设置。创建完成后请告知用户在草稿卡片确认。',
      schema: z.object({
        connectionId: id,
        toolName: id,
        title: z.string().trim().min(1).max(200),
        arguments: z.record(z.string(), z.unknown()),
        fields: z
          .array(
            z.object({
              path: z.array(id).min(1).max(8),
              label: z.string().trim().min(1).max(100),
              kind: z.enum(['recipient', 'subject', 'body', 'text', 'list']),
            }),
          )
          .min(2)
          .max(30),
        requestId: id.optional(),
      }),
      available,
      execute: (args: Record<string, unknown>, context: ToolExecutionContext) =>
        context.connectorDrafts!('create', args, context),
    },
    send_connector_draft: {
      description:
        '发送用户已确认的外发草稿。只传 draft ID，Core 使用确认版本的固定参数、当前连接授权和执行审批，返回真实发送结果；结果未知先核查。',
      schema: z.object({ id }),
      available,
      execute: (args: Record<string, unknown>, context: ToolExecutionContext) =>
        context.connectorDrafts!('send', args, context),
    },
    get_connector_draft: {
      description: '查看当前成员、当前会话的一份外发草稿及真实发送状态。',
      schema: z.object({ id }),
      available,
      execute: (args: Record<string, unknown>, context: ToolExecutionContext) =>
        context.connectorDrafts!('get', args, context),
    },
  };
}
