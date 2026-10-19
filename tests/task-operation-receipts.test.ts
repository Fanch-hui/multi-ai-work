import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { Artifact, Task } from '../src/domain/types.js';
import { taskOperationReceipts } from '../src/core/task-operation-receipts.js';
import { runPrompt } from '../src/core/run-prompt.js';
import type { ToolExecutionContext } from '../src/domain/tools.js';
import { setup } from './core-harness.js';

async function fixture() {
  const { core, bot: createBot } = await setup(async () => ({ text: '完成' }));
  core.scheduler.pause();
  const bot = createBot('执行者'),
    s = core.state.storage;
  bot.toolNames = ['read_artifact', 'read_process'];
  s.put('bots', bot);
  const room = core.entities.createConversation({
    name: '工作',
    kind: 'private',
    memberIds: [bot.id],
    workspaceId: core.state.snapshot().workspaces[0].id,
  });
  const task: Task = {
    id: 'task-receipts',
    conversationId: room.id,
    botId: bot.id,
    dependencyIds: [],
    goal: '继续完成原任务',
    expectedOutput: '',
    status: 'interrupted',
    runIds: ['run-first', 'run-next'],
    artifactIds: [],
    requestId: 'original',
    depth: 0,
    createdAt: '',
    updatedAt: '',
  };
  s.put('tasks', task);
  const add = (
    callId: string,
    name: string,
    result: unknown,
    status = 'succeeded',
    runId = task.runIds[0],
  ) => {
    const operation = {
      id: `${runId}:${callId}`,
      runId,
      name,
      status,
      result,
      requirementVersion: 3,
    };
    s.put('tool_operations', operation);
    return operation;
  };
  const render = () => taskOperationReceipts(core.state, task, bot, room);
  return { core, s, bot, room, task, add, render };
}

describe('任务续接操作凭据', () => {
  it('大量操作逐条保留合法完整凭据，提示不截断末尾操作', async () => {
    const { core, bot, room, task, add, render } = await fixture();
    for (let index = 0; index < 120; index++)
      add(
        `delegate-${index}`,
        'delegate_task',
        {
          id: `child-${index}`,
          botId: 'member',
          conversationId: room.id,
          status: 'queued',
          requestId: `request-${index}`,
          goal: '长任务正文'.repeat(1000),
          expectedOutput: '重复交付要求'.repeat(1000),
          dependencyIds: ['predecessor'],
          artifactIds: ['deliverable'],
          requirement: { version: 3 },
        },
        'succeeded',
        task.runIds[index % 2],
      );
    const receipts = render();
    expect(receipts).toHaveLength(120);
    expect(new Set(receipts.map((receipt) => receipt.operationId)).size).toBe(120);
    expect(JSON.stringify(receipts)).not.toContain('长任务正文');
    expect(receipts).toContainEqual(
      expect.objectContaining({
        operationId: 'run-next:delegate-119',
        callId: 'delegate-119',
        requirementVersion: 3,
        status: 'succeeded',
        result: expect.objectContaining({
          id: 'child-119',
          status: 'queued',
          requirement: { version: 3 },
          dependencyIds: ['predecessor'],
        }),
      }),
    );
    const prompt = runPrompt(
      core.state,
      core.memory,
      task,
      bot,
      room,
      { skills: [] } as unknown as ToolExecutionContext,
      [],
    ).prompt;
    const encoded = prompt.slice(prompt.indexOf('\n[{"operationId"') + 1);
    expect(JSON.parse(encoded)).toEqual(receipts);
  });

  it('保留群、成员、成果的真实目标、ID、版本及业务状态，省略重复正文', async () => {
    const { add, render } = await fixture();
    add('group', 'create_task_group', {
      conversation: { id: 'group-id', name: '任务群', memberIds: ['member'] },
      task: { id: 'group-task', botId: 'chief', status: 'running', goal: '重复目标' },
    });
    add('member', 'configure_bot', {
      id: 'member',
      revision: 9,
      model: 'model-a',
      connectionId: 'connection-a',
      instructions: '长指令'.repeat(1000),
    });
    add('artifact', 'write_artifact', {
      id: 'artifact',
      path: '/private/copy.md',
      workingPath: '/workspace/report.md',
      sha256: 'sha',
      requirementVersion: 3,
      purpose: 'deliverable',
      content: '重复正文',
    });
    add('delete', 'delete_file', { deleted: '/workspace/obsolete.md' });
    add('finished-child', 'delegate_task', {
      id: 'finished',
      botId: 'member',
      conversationId: 'room',
      status: 'failed',
      result: '已确认的部分业务结果',
      error: '缺少输入',
    });
    const receipts = render();
    expect(receipts[0].result).toEqual({
      conversation: { id: 'group-id', name: '任务群', memberIds: ['member'] },
      task: { id: 'group-task', botId: 'chief', status: 'running' },
    });
    expect(receipts[1].result).toEqual({
      id: 'member',
      revision: 9,
      model: 'model-a',
      connectionId: 'connection-a',
    });
    expect(receipts[2].result).toMatchObject({
      id: 'artifact',
      workingPath: '/workspace/report.md',
      sha256: 'sha',
      requirementVersion: 3,
    });
    expect(receipts[3].result).toEqual({ deleted: '/workspace/obsolete.md' });
    expect(receipts[4].result).toMatchObject({
      id: 'finished',
      status: 'failed',
      result: '已确认的部分业务结果',
      error: '缺少输入',
    });
    expect(JSON.stringify(receipts)).not.toContain('重复正文');
  });

  it('完整可读的命令日志通过现有入口读取，失败退出和已取消恢复仍保留执行凭据', async () => {
    const { s, bot, room, task, add, render } = await fixture();
    const output = '必要输出'.repeat(5000);
    const result = {
      processId: 'process',
      command: 'python',
      args: ['build.py'],
      status: 'failed',
      code: 2,
      signal: null,
      timedOut: false,
      stdout: output,
      stderr: '编译失败',
    };
    add('command', 'run_command', result);
    s.put('processes', {
      ...result,
      id: result.processId,
      taskId: task.id,
      botId: bot.id,
      runId: task.runIds[0],
      conversationId: room.id,
      workspaceId: room.workspaceId,
      logStart: 0,
      log: [
        { stream: 'stdout', text: output, offset: 0 },
        { stream: 'stderr', text: '编译失败', offset: output.length },
      ],
    });
    const receipt = render()[0];
    expect(receipt).toMatchObject({
      status: 'succeeded',
      result: {
        processId: 'process',
        command: 'python',
        args: ['build.py'],
        status: 'failed',
        code: 2,
        fullResult: { tool: 'read_process', processId: 'process', offset: 0 },
      },
    });
    expect(JSON.stringify(receipt)).not.toContain(output);
    s.put('tasks', { ...task, status: 'cancelled' });
    expect(render()).toEqual([receipt]);
    bot.toolNames = [];
    s.put('bots', bot);
    expect(render()[0].result).toEqual(result);
  });

  it('未知 MCP 及不完整旧格式原样保留，未确认状态不形成成功凭据', async () => {
    const { s, add, render } = await fixture();
    const result = {
      isError: true,
      content: [{ type: 'text', text: '必要业务结果'.repeat(5000) }],
      structuredContent: { remoteId: 'order-1' },
    };
    add('remote', 'call_mcp', result);
    s.event({
      id: 'remote-event',
      runId: 'run-first',
      type: 'tool',
      data: { callId: 'remote', summary: '调用 create_order · sales-system' },
      createdAt: '',
    });
    add('legacy', 'write_artifact', { id: 'legacy-id', body: '没有完整成果结构的旧结果' });
    for (const status of ['prepared', 'dispatched', 'unknown', 'failed'])
      add(status, 'run_command', { status }, status);
    add('read', 'read_file', { content: '不属于原有回执工具清单' });
    expect(render()).toHaveLength(2);
    expect(render()[0].result).toEqual(result);
    expect(render()[0].summary).toBe('调用 create_order · sales-system');
    expect(render()[1].result).toEqual({ id: 'legacy-id', body: '没有完整成果结构的旧结果' });
  });

  it('仅用当前获准且精确匹配的全文成果替代 MCP 正文，撤权或源失效后保留正文', async () => {
    const { core, s, bot, room, add, render } = await fixture();
    const result = {
      isError: false,
      structuredContent: { remoteId: 'order-1', details: '完整业务结果'.repeat(5000) },
    };
    const operation = add('remote', 'call_mcp', result),
      content = JSON.stringify(result);
    const artifact: Artifact = {
      id: 'full-result',
      conversationId: room.id,
      mimeType: 'text/plain',
      name: '工具完整结果.txt',
      path: '/unused/full.txt',
      sha256: createHash('sha256').update(content).digest('hex'),
      size: Buffer.byteLength(content),
      createdAt: '',
      contentSource: {
        kind: 'tool-operation',
        operationId: operation.id,
        field: 'result',
        encoding: 'value',
      },
    };
    s.put('artifacts', artifact);
    expect(render()[0].result).toMatchObject({
      isError: false,
      fullResult: { artifactId: artifact.id, tool: 'read_artifact' },
    });
    expect((await core.state.artifactContents.read(artifact)).toString()).toBe(content);
    s.put('artifacts', { ...artifact, sha256: 'invalid' });
    expect(render()[0].result).toEqual(result);
    s.put('artifacts', artifact);
    bot.toolNames = [];
    s.put('bots', bot);
    expect(render()[0].result).toEqual(result);
    bot.toolNames = ['read_artifact'];
    s.put('bots', bot);
    s.put('artifacts', { ...artifact, conversationId: 'private-room' });
    expect(render()[0].result).toEqual(result);
  });
});
