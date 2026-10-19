import { createServer, type Server } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ManagedProgress } from '../src/domain/provider.js';
import type { Artifact, Task } from '../src/domain/types.js';
import { createClient } from '../src/providers/managed/client.js';
import { runManaged } from '../src/providers/managed/loop.js';
import type { CoreService } from '../src/core/service.js';
import { eventually, setup } from './core-harness.js';

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    ),
  );
});
const delays = [1, 1, 10_000, 10_000, 10_000];
const overloaded = { type: 'error', code: 'server_error', message: 'temporary failure' };
const answer = {
  type: 'message',
  id: 'reply',
  status: 'completed',
  role: 'assistant',
  content: [{ type: 'output_text', text: '交付完成', annotations: [] }],
};
const writeCall = (id: string, path: string, content: string) => ({
  type: 'function_call',
  id,
  call_id: id,
  name: 'write_artifact',
  arguments: JSON.stringify({ path, content, format: 'markdown' }),
  status: 'completed',
});
const complete = (output: unknown[] = [answer]) => ({
  type: 'response.completed',
  response: { id: 'response', status: 'completed', output },
});

interface Operation {
  id: string;
  runId: string;
  name: string;
  status: string;
  result?: unknown;
}

describe('persistent managed recovery', () => {
  it.each(['progress-saved', 'operation-saved'] as const)(
    'continues a tool batch after interruption at %s without recreating the first artifact',
    async (checkpoint) => {
      const model = await fixture((index) => [
        complete(
          index === 0
            ? [
                writeCall('first-write', 'first.md', '第一份真实成果'),
                writeCall('second-write', 'second.md', '第二份真实成果'),
              ]
            : [answer],
        ),
      ]);
      const client = createClient(model.url);
      let interrupted = false;
      let saved: ManagedProgress | undefined;
      const { core, root, bot } = await setup((context) =>
        runManaged(
          client,
          {
            ...context,
            saveProgress: async (progress, change) => {
              await context.saveProgress!(progress, change);
              saved = structuredClone(progress);
              if (
                checkpoint === 'progress-saved' &&
                !interrupted &&
                progress.messages.some(
                  (message) => message.role === 'tool' && message.callId === 'first-write',
                ) &&
                !progress.messages.some(
                  (message) => message.role === 'tool' && message.callId === 'second-write',
                )
              ) {
                interrupted = true;
                throw new Error('工具批次执行中断');
              }
            },
            executeTool: async (name, args, callId) => {
              const result = await context.executeTool(name, args, callId);
              if (checkpoint === 'operation-saved' && !interrupted && callId === 'first-write') {
                interrupted = true;
                throw new Error('工具结果写入检查点前中断');
              }
              return result;
            },
          },
          'responses',
          delays,
        ),
      );
      const member = bot('批次作者', ['write_artifact']);
      const room = roomFor(core, member.id, '双成果');
      const taskId = core.tasks.send({ conversationId: room.id, content: '分别交付两份成果' })
        .taskIds[0];
      await eventually(() => core.state.storage.get<Task>('tasks', taskId)?.status === 'failed');
      expect(
        saved?.messages
          .filter((message) => message.role === 'tool')
          .map((message) => message.callId),
      ).toEqual(checkpoint === 'progress-saved' ? ['first-write'] : []);
      const oldTask = core.state.storage.get<Task>('tasks', taskId)!;
      const first = core.state.storage
        .all<Artifact>('artifacts')
        .find((item) => item.taskId === taskId)!;
      expect(first).toMatchObject({ taskId, botId: member.id, conversationId: room.id });
      expect(await readFile(join(root, 'workspace', 'first.md'), 'utf8')).toBe('第一份真实成果');
      const oldOperations = core.state.storage.all<Operation>('tool_operations');
      expect(oldOperations).toEqual([
        expect.objectContaining({ id: `${oldTask.runIds[0]}:first-write`, status: 'succeeded' }),
      ]);
      await core.request('tasks.retry', { id: taskId });
      await eventually(() => core.state.storage.get<Task>('tasks', taskId)?.status === 'completed');
      const task = core.state.storage.get<Task>('tasks', taskId)!;
      expect(task.runIds).toHaveLength(2);
      expect(core.state.storage.get<Artifact>('artifacts', first.id)).toEqual(first);
      expect(core.state.snapshot().artifacts.filter((item) => item.taskId === taskId)).toHaveLength(
        2,
      );
      expect(await readFile(first.path, 'utf8')).toBe('第一份真实成果');
      expect(await readFile(join(root, 'workspace', 'second.md'), 'utf8')).toBe('第二份真实成果');
      const operations = core.state.storage.all<Operation>('tool_operations');
      expect(operations).toHaveLength(2);
      expect(operations.find((item) => item.id === oldOperations[0].id)).toEqual(oldOperations[0]);
      expect(operations.every((item) => item.status === 'succeeded')).toBe(true);
      expect(model.requests).toHaveLength(2);
      expect(model.requests[1].input).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: 'function_call_output',
            call_id: 'first-write',
            output: expect.stringContaining(first.id),
          }),
          expect.objectContaining({ type: 'function_call_output', call_id: 'second-write' }),
        ]),
      );
    },
  );

  it('releases execution capacity during recovery and keeps the attempt count across new runs', async () => {
    let recoveryRequests = 0;
    const model = await fixture((_index, request) => {
      if (JSON.stringify(request).includes('其他会话任务')) return [complete()];
      recoveryRequests++;
      if (recoveryRequests <= 4) return [overloaded];
      return [
        complete(
          recoveryRequests === 5
            ? [writeCall('delayed-write', 'recovered.md', '恢复后实际交付')]
            : [answer],
        ),
      ];
    });
    const client = createClient(model.url);
    const { core, root, bot } = await setup((context) =>
      runManaged(client, { ...context, deferRecovery: true }, 'responses', delays),
    );
    await core.request('settings.save', { input: { maxActiveRuns: 1 } });
    const member = bot('恢复作者', ['write_artifact']);
    const room = roomFor(core, member.id, '恢复主任务');
    const taskId = core.tasks.send({ conversationId: room.id, content: '等待线路恢复后交付文件' })
      .taskIds[0];
    await recovering(core, taskId, 3);
    await eventually(() => !core.scheduler.hasActive());
    const other = roomFor(core, member.id, '其他会话');
    const otherId = core.tasks.send({ conversationId: other.id, content: '其他会话任务' })
      .taskIds[0];
    await eventually(() => core.state.storage.get<Task>('tasks', otherId)?.status === 'completed');
    expect(core.state.storage.get<Task>('tasks', taskId)?.status).toBe('recovering');
    expect(recoveryRequests).toBe(3);
    makeDue(core, taskId);
    await recovering(core, taskId, 4);
    expect(recoveryRequests).toBe(4);
    makeDue(core, taskId);
    await eventually(() => core.state.storage.get<Task>('tasks', taskId)?.status === 'completed');
    const task = core.state.storage.get<Task>('tasks', taskId)!;
    expect(task.runIds).toHaveLength(3);
    expect(recoveryRequests).toBe(6);
    const artifacts = core.state.snapshot().artifacts.filter((item) => item.taskId === taskId);
    expect(artifacts).toHaveLength(1);
    expect(await readFile(join(root, 'workspace', 'recovered.md'), 'utf8')).toBe('恢复后实际交付');
    expect(await readFile(artifacts[0].path, 'utf8')).toBe('恢复后实际交付');
    expect(core.state.storage.all<Operation>('tool_operations')).toEqual([
      expect.objectContaining({ status: 'succeeded', name: 'write_artifact' }),
    ]);
    const retryAttempts = task.runIds
      .flatMap((runId) => core.state.storage.runEvents(runId, undefined, 200).events)
      .filter((event) => event.data.phase === 'model-retry')
      .map((event) => event.data.attempt);
    expect(retryAttempts).toEqual([1, 2, 3, 4]);
  });

  it('does not restart a cancelled recovery even when its retry time has arrived', async () => {
    const model = await fixture(() => [overloaded]);
    const client = createClient(model.url);
    const { core, bot } = await setup((context) =>
      runManaged(client, { ...context, deferRecovery: true }, 'responses', delays),
    );
    const member = bot('待恢复成员');
    const room = roomFor(core, member.id, '可停止恢复');
    const taskId = core.tasks.send({ conversationId: room.id, content: '等待恢复' }).taskIds[0];
    await recovering(core, taskId, 3);
    await eventually(() => !core.scheduler.hasActive());
    core.scheduler.pause();
    makeDue(core, taskId);
    await core.request('tasks.cancel', { id: taskId });
    core.scheduler.resume();
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(core.state.storage.get<Task>('tasks', taskId)).toMatchObject({
      status: 'cancelled',
      runIds: [expect.any(String)],
    });
    expect(model.requests).toHaveLength(3);
    expect(core.scheduler.hasActive()).toBe(false);
    expect(core.state.storage.all('tool_operations')).toHaveLength(0);
    expect(core.state.snapshot().artifacts.filter((item) => item.taskId === taskId)).toHaveLength(
      0,
    );
  });
});

function roomFor(core: CoreService, memberId: string, name: string) {
  return core.entities.createConversation({
    name,
    kind: 'private',
    memberIds: [memberId],
    workspaceId: core.state.snapshot().workspaces[0].id,
  });
}
async function recovering(core: CoreService, taskId: string, attempt: number) {
  await eventually(() => {
    const task = core.state.storage.get<Task>('tasks', taskId);
    return task?.status === 'recovering' && task.recovery?.attempt === attempt;
  });
}
function makeDue(core: CoreService, taskId: string) {
  const task = core.state.storage.get<Task>('tasks', taskId)!;
  core.state.storage.put('tasks', {
    ...task,
    recovery: { ...task.recovery!, nextAttemptAt: new Date(0).toISOString() },
  });
  core.scheduler.kick();
}
async function fixture(reply: (index: number, request: Record<string, unknown>) => unknown[]) {
  const requests: Record<string, unknown>[] = [];
  const server = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    const parsed = JSON.parse(body) as Record<string, unknown>;
    const events = reply(requests.push(parsed) - 1, parsed);
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''));
  });
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('测试服务未启动');
  return { url: `http://127.0.0.1:${address.port}/v1`, requests };
}
