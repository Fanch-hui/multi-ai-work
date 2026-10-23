import { z } from 'zod';
import type { ToolExecutionContext } from '../domain/tools.js';
const identifier = z.string().min(1).max(200);
const tool = (name: string, description: string, schema: z.ZodObject) => ({
  description,
  schema,
  available: (context: ToolExecutionContext) => !!context.executeComputer,
  execute: (args: Record<string, unknown>, context: ToolExecutionContext) =>
    context.executeComputer!(name, args, context),
});
export function createComputerTools() {
  return {
    computer_apps: tool(
      'computer_apps',
      '列出用户授权给当前成员的正在运行的桌面应用。',
      z.object({}),
    ),
    computer_observe: tool(
      'computer_observe',
      '观察获准应用的窗口，返回版本和控件引用；可选仅此窗口截图。敏感输入和登录请请求人工接管。',
      z.object({
        bundleId: identifier,
        windowId: z.number().int().positive().optional(),
        screenshot: z.boolean().optional(),
      }),
    ),
    computer_action: tool(
      'computer_action',
      '使用刚观察到的 revision 和控件 ref 操作窗口。每次操作后重新观察；不支持的控件请人工接管。',
      z.object({
        revision: identifier,
        action: z.enum(['click', 'fill', 'press', 'scroll']),
        ref: identifier.optional(),
        text: z.string().max(20000).optional(),
        key: z
          .enum([
            'Enter',
            'Tab',
            'Escape',
            'ArrowLeft',
            'ArrowRight',
            'ArrowDown',
            'ArrowUp',
            'Backspace',
            'Space',
            'Meta+A',
            'Meta+S',
            'Meta+F',
            'Meta+Z',
            'Meta+Shift+Z',
          ])
          .optional(),
        deltaY: z.number().int().min(-1200).max(1200).optional(),
      }),
    ),
    computer_handoff: tool(
      'computer_handoff',
      '请用户接管共享电脑完成登录或应用不支持的人工步骤，交回后重新观察。',
      z.object({ reason: z.string().trim().min(1).max(2000) }),
    ),
  };
}
