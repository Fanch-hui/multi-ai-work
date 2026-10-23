import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ToolExecutionContext, ToolRegistry } from '../src/domain/tools.js';
import type { Bot, Conversation, Task, Workspace } from '../src/domain/types.js';
import type { ConnectorDraftView } from '../src/domain/connector-drafts.js';
import { State } from '../src/core/state.js';
import { EntityService } from '../src/core/entities.js';
import { TaskService } from '../src/core/tasks.js';
import { ToolConnections } from '../src/core/tool-connections.js';
import { ConnectorService } from '../src/core/connector-service.js';
import { ConnectorOAuth } from '../src/core/connector-oauth.js';
import { Vault } from '../src/security/vault.js';

const resources: { state: State; service: ConnectorService; root: string }[] = [];
afterEach(async () => {
  for (const { state, service, root } of resources.splice(0)) {
    await service.close();
    state.storage.close();
    await rm(root, { recursive: true, force: true });
  }
});

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'connector-drafts-'));
  const state = new State(root),
    vault = new Vault(join(root, 'unused'));
  const entities = new EntityService(state, vault),
    tasks = new TaskService(state);
  const model = await entities.saveConnection({
    name: '测试模型',
    provider: 'custom',
    baseUrl: 'https://model.test',
    concurrency: 1,
  });
  state.storage.put('connections', { ...model, status: 'ready' });
  const bot = entities.saveBot({
    name: '助理',
    role: '助理',
    instructions: '',
    connectionId: model.id,
    model: 'test',
    toolNames: [
      'call_mcp',
      'create_connector_draft',
      'send_connector_draft',
      'get_connector_draft',
    ],
    toolConnectionIds: ['messaging'],
    approvalMode: 'ask',
  });
  const workspace = state.storage.all<Workspace>('workspaces')[0];
  const room = entities.createConversation({
    name: '工作',
    kind: 'private',
    memberIds: [bot.id],
    workspaceId: workspace.id,
  });
  const task = tasks.create({ conversationId: room.id, botId: bot.id, goal: '准备消息' });
  const deliveries: unknown[] = [];
  let result: unknown = { content: [{ type: 'text', text: 'message-id:123' }] };
  let failAfterDispatch = false;
  const registry: ToolRegistry = {
    definitions: () => [],
    probeConnection: async () => ['send_message'],
    close: async () => {},
    execute: async (name, args, context) => {
      expect(name).toBe('call_mcp');
      if (!(await context.requestApproval(name, '发送消息', args))) throw new Error('审批未通过');
      context.assertAuthorized?.();
      context.signal.throwIfAborted();
      context.markDispatched?.();
      deliveries.push(structuredClone(args));
      if (failAfterDispatch) throw new Error('ECONNRESET: connection closed');
      return result;
    },
  };
  const connections = new ToolConnections(state, entities, vault, registry);
  await connections.save({
    id: 'messaging',
    name: '工作消息',
    kind: 'mcp',
    transport: 'http',
    url: 'https://messaging.test/mcp',
    enabled: true,
  });
  const service = new ConnectorService(
    state,
    connections,
    tasks,
    registry,
    new ConnectorOAuth(state, vault),
  );
  resources.push({ state, service, root });
  const context = (
    target: Task = task,
    overrides: Partial<ToolExecutionContext> = {},
  ): ToolExecutionContext =>
    ({
      task: target,
      runId: 'test-run',
      botId: bot.id,
      conversation: room,
      workspace,
      callId: 'draft',
      signal: new AbortController().signal,
      requestApproval: async () => true,
      toolConnections: [],
      assertAuthorized: () => {},
      ...overrides,
    }) as ToolExecutionContext;
  const input = {
    connectionId: 'messaging',
    toolName: 'send_message',
    title: '项目进度',
    arguments: { destination: '#project', message: '初稿' },
    fields: [
      { path: ['destination'], label: '发送至', kind: 'recipient' },
      { path: ['message'], label: '正文', kind: 'body' },
    ],
  };
  const create = () => service.execute('create', input, context()) as ConnectorDraftView;
  const confirm = async (draft: ConnectorDraftView) =>
    service.request('connectorDrafts.confirm', {
      id: draft.id,
      revision: draft.revision,
      requestId: 'confirm',
    }) as Promise<ConnectorDraftView>;
  return {
    state,
    service,
    bot,
    room,
    task,
    context,
    input,
    create,
    confirm,
    deliveries,
    setResult: (value: unknown) => {
      result = value;
    },
    fail: () => {
      failAfterDispatch = true;
    },
  };
}

describe('连接器外发草稿', () => {
  it('保留独立发送权限，缺少权限时确认前提示成员配置入口', async () => {
    const test = await setup();
    const draft = test.create();
    test.state.storage.put('bots', {
      ...test.bot,
      toolNames: test.bot.toolNames.filter((name) => name !== 'send_connector_draft'),
    });
    const visible = (await test.service.request('connectorDrafts.get', {
      id: draft.id,
    })) as ConnectorDraftView;
    expect(visible.sendBlockedReason).toContain('我的团队');
    await expect(test.confirm(draft)).rejects.toThrow('发送权限');
    expect(test.deliveries).toEqual([]);
    expect(test.state.storage.all<Task>('tasks')).toHaveLength(1);
  });
  it('创建只登记草稿，幂等请求参数冲突被拒绝', async () => {
    const test = await setup();
    const draft = test.create();
    expect(draft.status).toBe('draft');
    expect(test.deliveries).toEqual([]);
    expect(test.create().id).toBe(draft.id);
    expect(() =>
      test.service.execute('create', { ...test.input, title: '另一封消息' }, test.context()),
    ).toThrow('请求 ID');
    expect(() =>
      test.service.execute(
        'create',
        { ...test.input, arguments: { ...test.input.arguments, access_token: 'fixture' } },
        test.context(),
      ),
    ).toThrow('认证信息');
  });

  it('修改后固定用户确认版本，通过普通任务和原工具审批发送', async () => {
    const test = await setup();
    const first = test.create();
    await expect(test.service.execute('send', { id: first.id }, test.context())).rejects.toThrow(
      '用户确认',
    );
    const edited = (await test.service.request('connectorDrafts.update', {
      id: first.id,
      revision: first.revision,
      arguments: { destination: '#final', message: '用户修改后的正文' },
    })) as ConnectorDraftView;
    await expect(
      test.service.request('connectorDrafts.confirm', {
        id: edited.id,
        revision: 1,
        requestId: 'old',
      }),
    ).rejects.toThrow('已更新');
    const approved = await test.confirm(edited);
    expect((await test.confirm(approved)).dispatchTaskId).toBe(approved.dispatchTaskId);
    await expect(test.service.execute('send', { id: approved.id }, test.context())).rejects.toThrow(
      '发送任务',
    );
    const dispatch = test.state.storage.get<Task>('tasks', approved.dispatchTaskId!)!;
    let approvals = 0,
      marks = 0;
    const context = test.context(dispatch, {
      requestApproval: async () => {
        approvals++;
        return true;
      },
      markDispatched: () => marks++,
    });
    expect(await test.service.execute('send', { id: approved.id }, context)).toMatchObject({
      status: 'sent',
    });
    expect(test.deliveries).toEqual([
      {
        connectionId: 'messaging',
        toolName: 'send_message',
        arguments: { destination: '#final', message: '用户修改后的正文' },
      },
    ]);
    expect(approvals).toBe(1);
    expect(marks).toBe(1);
    expect(await test.service.execute('send', { id: approved.id }, context)).toMatchObject({
      status: 'sent',
    });
    expect(test.deliveries).toHaveLength(1);
    expect(await test.service.request('connectorDrafts.get', { id: first.id })).toMatchObject({
      operationId: 'test-run:draft',
      result: expect.stringContaining('123'),
    });
  });

  it('审批等待期间撤回连接授权，实际发送被阻止', async () => {
    const test = await setup();
    const approved = await test.confirm(test.create());
    const dispatch = test.state.storage.get<Task>('tasks', approved.dispatchTaskId!)!;
    await expect(
      test.service.execute(
        'send',
        { id: approved.id },
        test.context(dispatch, {
          requestApproval: async () => {
            test.state.storage.put('bots', { ...test.bot, toolConnectionIds: [] });
            return true;
          },
        }),
      ),
    ).rejects.toThrow('未获准');
    expect(test.deliveries).toHaveLength(0);
    expect(await test.service.request('connectorDrafts.get', { id: approved.id })).toMatchObject({
      status: 'failed',
    });
  });

  it('发送后断线记录未知结果，用户核查后才可重新确认', async () => {
    const test = await setup();
    const approved = await test.confirm(test.create());
    test.fail();
    const dispatch = test.state.storage.get<Task>('tasks', approved.dispatchTaskId!)!;
    await expect(
      test.service.execute('send', { id: approved.id }, test.context(dispatch)),
    ).rejects.toThrow('ECONNRESET');
    expect(await test.service.request('connectorDrafts.get', { id: approved.id })).toMatchObject({
      status: 'unknown',
    });
    await expect(test.confirm(approved)).rejects.toThrow('不可发送');
    const reconciled = (await test.service.request('connectorDrafts.reconcile', {
      id: approved.id,
      revision: approved.revision,
      outcome: 'not_sent',
      note: '已在目标频道检查，消息未出现',
    })) as ConnectorDraftView;
    expect(reconciled).toMatchObject({ status: 'draft', revision: 2 });
    expect(test.deliveries).toHaveLength(1);
    await expect(
      test.service.execute('send', { id: approved.id }, test.context(dispatch)),
    ).rejects.toThrow('用户确认');
  });

  it('连接器返回业务错误保存失败，重启的在途发送进入核查', async () => {
    const test = await setup();
    const approved = await test.confirm(test.create());
    test.setResult({ isError: true, content: [{ type: 'text', text: '目标频道不存在' }] });
    const dispatch = test.state.storage.get<Task>('tasks', approved.dispatchTaskId!)!;
    expect(
      await test.service.execute('send', { id: approved.id }, test.context(dispatch)),
    ).toMatchObject({ status: 'failed' });
    const stored = test.state.storage.get('connector_drafts', approved.id) as ConnectorDraftView;
    test.state.storage.put('connector_drafts', { ...stored, status: 'sending' });
    test.service.start();
    expect(await test.service.request('connectorDrafts.get', { id: approved.id })).toMatchObject({
      status: 'unknown',
    });
  });

  it('账号切换使已确认草稿失效；按会话查询保持隔离', async () => {
    const test = await setup();
    const approved = await test.confirm(test.create());
    test.state.storage.setMetadata('connector-account-revision:messaging', 2);
    const dispatch = test.state.storage.get<Task>('tasks', approved.dispatchTaskId!)!;
    expect(() => test.service.execute('send', { id: approved.id }, test.context(dispatch))).toThrow(
      '配置已更改',
    );
    expect(await test.service.request('connectorDrafts.list', { conversationId: 'other' })).toEqual(
      [],
    );
    expect(() =>
      test.service.execute(
        'get',
        { id: approved.id },
        test.context(dispatch, { conversation: { ...test.room, id: 'other' } as Conversation }),
      ),
    ).toThrow('当前成员与会话');
  });

  it('界面可分别授权成员，不自动扩大工具能力', async () => {
    const test = await setup();
    await test.service.request('connectors.setAccess', { id: 'messaging', botIds: [] });
    expect(test.state.storage.get<Bot>('bots', test.bot.id)?.toolConnectionIds).toEqual([]);
    await test.service.request('connectors.setAccess', { id: 'messaging', botIds: [test.bot.id] });
    expect(test.state.storage.get<Bot>('bots', test.bot.id)?.toolNames).toEqual(test.bot.toolNames);
    expect(await test.service.request('connectors.list', {})).toMatchObject([
      { authorizedBots: [{ id: test.bot.id }] },
    ]);
  });
});
