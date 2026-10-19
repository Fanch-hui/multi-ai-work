import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { startHttp } from '../src/core/http.js';
import { setup, eventually } from './core-harness.js';

describe('原生团队 MCP 用户问答', () => {
  it('发送工具返回后收束当前轮次，并保存持久问题', async () => {
    const { core, bot } = await setup(async (context) => {
      const env = Object.fromEntries(
        Object.entries({ ...process.env, ...context.nativeMcp.env }).filter(
          (entry): entry is [string, string] => entry[1] !== undefined,
        ),
      );
      const client = new Client({ name: 'input-test', version: '1.0.0' });
      const transport = new StdioClientTransport({
        command: context.nativeMcp.command,
        args: context.nativeMcp.args,
        env,
        stderr: 'ignore',
      });
      try {
        await client.connect(transport);
        const pause = new Promise<void>((resolve) =>
          context.inputSignal!.addEventListener('abort', () => resolve(), { once: true }),
        );
        const result = await client.callTool({
          name: 'ask_user',
          arguments: { question: '交付格式是什么？' },
        });
        expect(result.isError).not.toBe(true);
        expect(JSON.parse((result.content as { text: string }[])[0].text)).toMatchObject({
          waitingForInput: true,
        });
        await pause;
        expect(context.isWaitingForInput!()).toBe(true);
        return { text: '' };
      } finally {
        await client.close();
      }
    });
    const server = await startHttp(core, false);
    try {
      const member = bot('原生协议助手', ['ask_user']);
      const room = core.entities.createConversation({
        name: '问答',
        kind: 'private',
        memberIds: [member.id],
        workspaceId: core.state.snapshot().workspaces[0].id,
      });
      core.tasks.send({ conversationId: room.id, content: '开始工作' });
      await eventually(() => core.state.snapshot().runs[0]?.status === 'waiting_input', 10000);
      expect(core.state.snapshot().questions[0]).toMatchObject({
        status: 'pending',
        conversationId: room.id,
      });
      expect(core.state.storage.all<{ status: string }>('tool_operations')[0].status).toBe(
        'succeeded',
      );
    } finally {
      await server.close();
    }
  });
});
