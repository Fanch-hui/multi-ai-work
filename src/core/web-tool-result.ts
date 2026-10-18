import type { Bot } from '../domain/types.js';
import type { ToolExecutionContext } from '../domain/tools.js';
import type { State } from './state.js';
import { ContextReferences } from './context-references.js';
import { webResultPreview } from '../tools/web-preview.js';

export async function prepareWebToolResult(state: State, context: ToolExecutionContext, bot: Bot,
  name: string, args: Record<string, unknown>, result: unknown): Promise<unknown> {
  if (!bot.toolNames.includes('read_artifact')) return result;
  const preview = webResultPreview(name, args, result);
  if (!preview) return result;
  const original = typeof result === 'string' ? result : JSON.stringify(result);
  if (JSON.stringify(preview).length + 512 >= original.length) return result;
  const references = new ContextReferences(state, { runId: context.runId, task: context.task, bot,
    room: context.conversation, toolNames: bot.toolNames, signal: context.signal });
  try {
    const reference = await references.preserveToolOutput({ role: 'tool', content: original });
    if (!reference) return result;
    return { ...preview, previewOnly: true, originalLength: original.length,
      fullResult: { tool: 'read_artifact', arguments: { artifactId: reference.id, offset: 0, limit: 12000 } },
      instruction: '这是资料摘录，完整工具结果已保存。需要精确引用、更多结果或正文时，用 fullResult 分页读取。' };
  } catch {
    context.signal.throwIfAborted();
    return result;
  }
}
