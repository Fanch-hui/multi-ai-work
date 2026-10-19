import { describe, expect, it } from 'vitest';
import { writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ModelMessage, RunContext } from '../src/domain/provider.js';
import type { Bot, Task, ToolConnection } from '../src/domain/types.js';
import {
  estimateModelMessagesTokens,
  type ModelHistoryEntry,
} from '../src/runtime/model-history.js';
import { remoteToolAlias } from '../src/tools/mcp-catalog.js';
import { eventually, setup } from './core-harness.js';

async function localCatalog(directory: string) {
  const require = createRequire(import.meta.url);
  const moduleUrl = (name: string) => pathToFileURL(require.resolve(name)).href;
  const script = join(directory, 'compaction-mcp.mjs');
  await writeFile(
    script,
    `
    import { Server } from ${JSON.stringify(moduleUrl('@modelcontextprotocol/sdk/server/index.js'))};
    import { StdioServerTransport } from ${JSON.stringify(moduleUrl('@modelcontextprotocol/sdk/server/stdio.js'))};
    import { ListToolsRequestSchema } from ${JSON.stringify(moduleUrl('@modelcontextprotocol/sdk/types.js'))};
    const server = new Server({ name: 'compaction-catalog', version: '1' }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [
      { name: 'lookup', description: 'Read a record', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } }
    ] }));
    await server.connect(new StdioServerTransport());
  `,
  );
  return script;
}

async function turn(
  core: Awaited<ReturnType<typeof setup>>['core'],
  conversationId: string,
  content: string,
) {
  const taskId = core.tasks.send({ conversationId, content }).taskIds[0];
  await eventually(
    () =>
      ['completed', 'failed'].includes(core.state.storage.get<Task>('tasks', taskId)?.status ?? ''),
    10000,
  );
  const task = core.state.storage.get<Task>('tasks', taskId)!;
  expect(task.status, task.error).toBe('completed');
}

describe('带 MCP 目录的手动压缩', () => {
  it('压缩与后续多轮使用同一工具目录及摘要，撤销连接后重新校验上下文', async () => {
    const requests: Pick<RunContext, 'contextSignature' | 'messages' | 'tools'>[] = [];
    const summary = '早期项目资料已整理，继续保留最新要求';
    const { core, root, connection } = await setup(async (context) => {
      if (context.runId.includes(':summary:')) {
        expect(context.tools).toEqual([]);
        await expect(context.executeTool('call_mcp', {}, 'summary-call')).rejects.toThrow(
          '摘要任务不执行工具',
        );
        return { text: summary };
      }
      requests.push({
        contextSignature: context.contextSignature,
        messages: context.messages,
        tools: context.tools,
      });
      return {
        text: '完成',
        messages: [
          ...context.messages,
          { role: 'user', content: context.prompt },
          { role: 'assistant', content: '完成' },
        ] as ModelMessage[],
      };
    });
    const tool = await core.entities.saveTool({
      name: '本地资料目录',
      kind: 'mcp',
      enabled: true,
      transport: 'stdio',
      command: process.execPath,
      args: [await localCatalog(root)],
    });
    await core.request('chief.configure', {
      input: {
        connectionId: connection.id,
        model: 'test',
        contextWindow: 80000,
        memoryMode: 'propose',
        toolConnectionIds: [tool.id],
      },
    });
    const roomId = core.state.settings().mainConversationId!;
    await turn(core, roomId, 'EARLY_HISTORY_TOKEN '.repeat(1000));
    await turn(core, roomId, '最新要求保留原文');
    const remote = remoteToolAlias(tool, 'lookup');
    expect(requests.at(-1)!.tools.some((item) => item.name === remote)).toBe(true);
    const signature = requests.at(-1)!.contextSignature;
    const previousTokens = estimateModelMessagesTokens(requests.at(-1)!.messages);
    const compact = (await core.request('conversations.compact', { id: roomId })) as Task;
    await eventually(
      () =>
        ['completed', 'failed'].includes(
          core.state.storage.get<Task>('tasks', compact.id)?.status ?? '',
        ),
      10000,
    );
    expect(core.state.storage.get<Task>('tasks', compact.id)).toMatchObject({
      status: 'completed',
      contextCompactionOutcome: 'compressed',
    });
    expect(core.state.storage.get<ToolConnection>('tool_connections', tool.id)?.status).toBe(
      'ready',
    );
    expect(
      core.state.storage.get<ToolConnection>('tool_connections', tool.id)?.error,
    ).toBeUndefined();
    const binding = core.state.snapshot().bindings.find((item) => item.conversationId === roomId)!;
    expect(core.state.storage.metadata(`history-validity:${binding.id}`)).toMatchObject({
      signature,
    });
    for (const content of ['压缩后继续', '再次继续']) {
      await turn(core, roomId, content);
      const request = requests.at(-1)!;
      expect(request.contextSignature).toBe(signature);
      expect(request.tools.some((item) => item.name === remote)).toBe(true);
      expect(JSON.stringify(request.messages)).toContain(summary);
      expect(JSON.stringify(request.messages)).toContain('最新要求保留原文');
      expect(JSON.stringify(request.messages)).not.toContain('EARLY_HISTORY_TOKEN');
      expect(estimateModelMessagesTokens(request.messages)).toBeLessThan(previousTokens / 2);
    }
    const chief = core.state.storage.get<Bot>('bots', core.state.settings().mainBotId!)!;
    core.entities.saveBot({ ...chief, toolConnectionIds: [] });
    await turn(core, roomId, '撤销连接后继续');
    expect(requests.at(-1)!.tools.some((item) => item.name === remote)).toBe(false);
    expect(JSON.stringify(requests.at(-1)!.messages)).not.toContain(summary);
    const original = core.state.storage
      .messages(roomId)
      .find((message) => message.authorType === 'user')!;
    const rebuilt = core.state.storage.metadata<ModelHistoryEntry[]>(`history:${binding.id}`)!;
    expect(
      rebuilt.find((entry) => entry.message.content.includes('EARLY_HISTORY_TOKEN')),
    ).toMatchObject({ messageId: original.id, sequence: original.sequence });
    const compactAgain = (await core.request('conversations.compact', { id: roomId })) as Task;
    await eventually(
      () =>
        ['completed', 'failed'].includes(
          core.state.storage.get<Task>('tasks', compactAgain.id)?.status ?? '',
        ),
      10000,
    );
    expect(core.state.storage.get<Task>('tasks', compactAgain.id)).toMatchObject({
      status: 'completed',
      contextCompactionOutcome: 'compressed',
    });
    await turn(core, roomId, '重建并压缩后继续');
    expect(JSON.stringify(requests.at(-1)!.messages)).toContain(summary);
    expect(JSON.stringify(requests.at(-1)!.messages)).not.toContain('EARLY_HISTORY_TOKEN');
  });
});
