import { createRequire } from 'node:module';
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { ConnectorDraftView } from '../src/domain/connector-drafts.js';
import type { Run, Task } from '../src/domain/types.js';
import { eventually, setup } from './core-harness.js';
import type { ToolExecutionContext } from '../src/domain/tools.js';
async function messagingFixture(root: string) {
  const require = createRequire(import.meta.url);
  const sdk = (name: string) => pathToFileURL(require.resolve(name)).href;
  const script = join(root, 'fixture-server.mjs'),
    delivered = join(root, 'delivered.json');
  await writeFile(
    script,
    `
    import { Server } from ${JSON.stringify(sdk('@modelcontextprotocol/sdk/server/index.js'))};
    import { StdioServerTransport } from ${JSON.stringify(sdk('@modelcontextprotocol/sdk/server/stdio.js'))};
    import { ListToolsRequestSchema, CallToolRequestSchema } from ${JSON.stringify(sdk('@modelcontextprotocol/sdk/types.js'))};
    import { writeFileSync } from 'node:fs';
    const server = new Server({name:'fixture',version:'1'}, {capabilities:{tools:{}}});
    server.setRequestHandler(ListToolsRequestSchema, async () => ({tools:[{name:'send_message',description:'发送测试消息',inputSchema:{type:'object',properties:{recipient:{type:'string'},body:{type:'string'}},required:['recipient','body']}}]}));
    server.setRequestHandler(CallToolRequestSchema, async request => { writeFileSync(${JSON.stringify(delivered)},JSON.stringify(request.params.arguments)); return {content:[{type:'text',text:'fixture message accepted'}]}; });
    await server.connect(new StdioServerTransport());
  `,
  );
  return {
    delivered,
    input: {
      id: 'fixture',
      name: '测试连接器',
      kind: 'mcp',
      transport: 'stdio',
      command: process.execPath,
      args: [script],
      enabled: true,
    },
  };
}

describe('连接器草稿运行闭环', () => {
  it('用户修改并确认后，由现有调度、审批和幂等日志执行真实 MCP 测试服务', async () => {
    let draftId = '';
    const { core, root, bot } = await setup(async (context) => {
      const run = core.state.storage.get<Run>('runs', context.runId)!;
      const task = core.state.storage.get<Task>('tasks', run.taskId)!;
      if (task.goal.startsWith('用户已确认外发草稿')) {
        const result = await context.executeTool(
          'send_connector_draft',
          { id: draftId },
          'send-confirmed',
        );
        expect(result).toMatchObject({ status: 'sent' });
        return { text: '消息已发送。' };
      }
      expect(context.tools.some((tool) => tool.name === 'create_connector_draft')).toBe(true);
      const draft = (await context.executeTool(
        'create_connector_draft',
        {
          connectionId: 'fixture',
          toolName: 'send_message',
          title: '项目通知',
          arguments: { recipient: '#project', body: '初稿' },
          fields: [
            { path: ['recipient'], label: '目标频道', kind: 'recipient' },
            { path: ['body'], label: '消息正文', kind: 'body' },
          ],
        },
        'prepare-draft',
      )) as ConnectorDraftView;
      draftId = draft.id;
      return { text: '草稿已准备，请核对并确认发送。' };
    });
    const { input, delivered } = await messagingFixture(root);
    await core.request('connectors.save', { input });
    const member = bot('助理', [
      'call_mcp',
      'create_connector_draft',
      'send_connector_draft',
      'get_connector_draft',
    ]);
    core.state.storage.put('bots', {
      ...member,
      memoryMode: 'off',
      toolConnectionIds: ['fixture'],
    });
    const room = core.entities.createConversation({
      name: '草稿验收',
      kind: 'private',
      memberIds: [member.id],
      workspaceId: core.state.snapshot().workspaces[0].id,
    });
    const source = core.tasks.send({ conversationId: room.id, content: '准备消息' });
    await eventually(
      () => core.state.storage.get<Task>('tasks', source.taskIds[0])?.status === 'completed',
    );
    expect(existsSync(delivered)).toBe(false);
    const edited = (await core.request('connectorDrafts.update', {
      id: draftId,
      revision: 1,
      arguments: { recipient: '#reviewed', body: '用户确认的内容' },
    })) as ConnectorDraftView;
    const approved = (await core.request('connectorDrafts.confirm', {
      id: draftId,
      revision: edited.revision,
      requestId: 'confirm-once',
    })) as ConnectorDraftView;
    await eventually(() =>
      core.state
        .snapshot()
        .approvals.some(
          (item) => item.taskId === approved.dispatchTaskId && item.status === 'pending',
        ),
    );
    expect(existsSync(delivered)).toBe(false);
    const approval = core.state
      .snapshot()
      .approvals.find(
        (item) => item.taskId === approved.dispatchTaskId && item.status === 'pending',
      )!;
    core.approvals.resolve(approval.id, true);
    await eventually(
      () => core.state.storage.get<Task>('tasks', approved.dispatchTaskId!)?.status === 'completed',
    );
    expect(JSON.parse(await readFile(delivered, 'utf8'))).toEqual({
      recipient: '#reviewed',
      body: '用户确认的内容',
    });
    const saved = (await core.request('connectorDrafts.get', {
      id: draftId,
    })) as ConnectorDraftView;
    expect(saved.status).toBe('sent');
    expect(core.state.storage.get('tool_operations', saved.operationId!)).toMatchObject({
      name: 'send_connector_draft',
      status: 'succeeded',
    });
    await expect(
      core.request('connectorDrafts.confirm', {
        id: draftId,
        revision: edited.revision,
        requestId: 'again',
      }),
    ).rejects.toThrow('不可发送');
  });
  it('旧 tools.save 更换凭据后，已确认草稿不能沿用新身份发送', async () => {
    const { core, root, bot } = await setup(async () => ({ text: '等待发送指令。' }));
    const fixture = await messagingFixture(root);
    await core.request('tools.save', {
      input: { ...fixture.input, secret: 'fixture-first-credential' },
    });
    const member = bot('助理', [
      'call_mcp',
      'create_connector_draft',
      'send_connector_draft',
      'get_connector_draft',
    ]);
    core.state.storage.put('bots', {
      ...member,
      memoryMode: 'off',
      toolConnectionIds: ['fixture'],
    });
    const workspace = core.state.snapshot().workspaces[0];
    const room = core.entities.createConversation({
      name: '身份变更',
      kind: 'private',
      memberIds: [member.id],
      workspaceId: workspace.id,
    });
    const task = core.tasks.create({ conversationId: room.id, botId: member.id, goal: '准备草稿' });
    const context = {
      task,
      botId: member.id,
      conversation: room,
      workspace,
      runId: 'fixture-run',
      callId: 'draft',
      signal: new AbortController().signal,
    } as ToolExecutionContext;
    const draft = core.connectors.execute(
      'create',
      {
        connectionId: 'fixture',
        toolName: 'send_message',
        title: '通知',
        arguments: { recipient: '#project', body: '消息' },
        fields: [
          { path: ['recipient'], label: '频道', kind: 'recipient' },
          { path: ['body'], label: '正文', kind: 'body' },
        ],
      },
      context,
    ) as ConnectorDraftView;
    const approved = (await core.request('connectorDrafts.confirm', {
      id: draft.id,
      revision: draft.revision,
      requestId: 'confirm',
    })) as ConnectorDraftView;
    await core.request('tools.save', {
      input: { ...fixture.input, secret: 'fixture-replacement-credential' },
    });
    const dispatch = core.state.storage.get<Task>('tasks', approved.dispatchTaskId!)!;
    expect(() =>
      core.connectors.execute('send', { id: draft.id }, { ...context, task: dispatch }),
    ).toThrow('配置已更改');
    expect(existsSync(fixture.delivered)).toBe(false);
    expect(
      ((await core.request('connectorDrafts.get', { id: draft.id })) as ConnectorDraftView).status,
    ).toBe('approved');
  });
});
