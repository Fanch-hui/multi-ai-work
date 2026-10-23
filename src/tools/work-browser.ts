import { z } from 'zod';
import type { ToolExecutionContext } from '../domain/tools.js';

const id = z.string().min(1).max(200);
const tool = (name: string, description: string, schema: z.ZodObject) => ({
  description,
  schema,
  available: (context: ToolExecutionContext) => !!context.executeBrowser,
  execute: (args: Record<string, unknown>, context: ToolExecutionContext) =>
    context.executeBrowser!(name, args, context),
});

export function createBrowserTools() {
  return {
    browser_open: tool(
      'browser_open',
      '省略profileId列出获准配置；指定profileId打开工作浏览器，返回本任务会话和标签。同配置占用时等待空闲。',
      z.object({ profileId: id.optional(), url: z.string().max(8000).optional() }),
    ),
    browser_snapshot: tool(
      'browser_snapshot',
      '读取当前工作页面与元素引用，可选截图；上传下载资料保持原任务授权。操作前使用最新revision。',
      z.object({ sessionId: id, tabId: id.optional(), screenshot: z.boolean().optional() }),
    ),
    browser_action: tool(
      'browser_action',
      '操作刚刚观察的页面。使用快照revision及元素ref；上传使用获准artifactId或工作区path。登录与验证请求人工接管。',
      z.object({
        sessionId: id,
        tabId: id.optional(),
        revision: id,
        action: z.enum(['click', 'fill', 'press', 'select', 'scroll', 'back', 'upload']),
        ref: id.optional(),
        text: z.string().max(100000).optional(),
        key: z.string().max(100).optional(),
        x: z.number().finite().optional(),
        y: z.number().finite().optional(),
        deltaY: z.number().finite().optional(),
        artifactId: id.optional(),
        path: z.string().max(8000).optional(),
      }),
    ),
    browser_tabs: tool(
      'browser_tabs',
      '列出、选择或关闭本任务的浏览器标签。',
      z.object({
        sessionId: id,
        operation: z.enum(['list', 'select', 'close']).default('list'),
        tabId: id.optional(),
      }),
    ),
    browser_handoff: tool(
      'browser_handoff',
      '请用户接管工作浏览器完成登录、验证或人工步骤；保存进度并等待用户交回。',
      z.object({ sessionId: id, reason: z.string().trim().min(1).max(2000) }),
    ),
  };
}
