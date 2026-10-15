import { describe, expect, it } from 'vitest';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ManagedProgress, ProviderAdapter, RunContext } from '../src/domain/provider.js';
import type { Bot, Conversation, Run, Task, Workspace } from '../src/domain/types.js';
import type { ManagedCheckpoint } from '../src/core/managed-progress.js';
import { CoreService } from '../src/core/service.js';
import { sessionBinding } from '../src/core/session-binding.js';
import { createClient } from '../src/providers/managed/client.js';
import { runManaged } from '../src/providers/managed/loop.js';
import { caps, eventually, resources, setup } from './core-harness.js';

const answer = { type: 'message', id: 'reply', status: 'completed', role: 'assistant',
  content: [{ type: 'output_text', text: '恢复后的最终结果', annotations: [] }] };
const complete = (output: unknown[] = [answer]) => ({ type: 'response.completed',
  response: { id: 'response', status: 'completed', output } });
const past = new Date(0).toISOString();

describe('managed recovery lifecycle', () => {
  it('automatically resumes a crashed run without resetting its retry budget', async () => {
    const model = modelFixture(() => [{ type: 'error', code: 'server_error', message: 'temporary failure' }]);
    const execute = (context: RunContext) => runManaged(model.client, context, 'responses', [1, 1, 1, 1, 1]);
    const harness = await setup(execute);
    const seeded = seedRunning(harness.core, harness.bot('崩溃恢复成员'), 'request', 3);
    const core = await restart(harness.core, harness.root, execute);
    await eventually(() => core.state.storage.get<Task>('tasks', seeded.task.id)?.status === 'failed');
    const task = core.state.storage.get<Task>('tasks', seeded.task.id)!;
    expect(task.runIds).toHaveLength(2);
    expect(model.requests).toHaveLength(2);
    const source = core.state.storage.get<Run>('runs', seeded.run.id)!;
    expect(source.status).toBe('interrupted');
    const resumed = core.state.storage.get<Run>('runs', task.runIds[1])!;
    expect(resumed.resumeFromRunId).toBe(source.id);
    expect(core.state.storage.runEvents(resumed.id, undefined, 200).events
      .filter(event => event.data.phase === 'model-retry').map(event => event.data.attempt)).toEqual([5]);
    expect(task.error).toBeTruthy();
  });

  it.each(['cancel-requested', 'unknown-operation'] as const)
    ('does not automatically resume a crashed run with %s', async barrier => {
    let calls = 0;
    const execute = async () => { calls++; return { text: '不应启动' }; };
    const harness = await setup(execute);
    const seeded = seedRunning(harness.core, harness.bot('受限恢复成员'), 'request', 2);
    if (barrier === 'cancel-requested') harness.core.state.storage.put('runs', { ...seeded.run, cancelRequestedAt: past });
    else harness.core.state.storage.put('tool_operations', {
      id: `${seeded.run.id}:unconfirmed`, runId: seeded.run.id, status: 'unknown', name: 'write_artifact',
    });
    const core = await restart(harness.core, harness.root, execute);
    await schedulerTurn();
    const task = core.state.storage.get<Task>('tasks', seeded.task.id)!;
    expect(calls).toBe(0);
    expect(task.runIds).toEqual([seeded.run.id]);
    expect(task.status).toBe('interrupted');
    expect(task.recovery).toBeUndefined();
    if (barrier === 'unknown-operation') expect(task.reconciliationRequired).toBe(true);
  });

  it('normal shutdown cancels a parked recovery before the next startup', async () => {
    let calls = 0;
    const execute = async () => { calls++; return { text: '不应启动' }; };
    const harness = await setup(execute);
    const seeded = seedRunning(harness.core, harness.bot('关闭恢复成员'), 'ready', 3);
    harness.core.state.storage.put('runs', { ...seeded.run, status: 'interrupted' });
    harness.core.state.storage.put('tasks', { ...seeded.task, status: 'recovering', resumeFromRunId: seeded.run.id,
      recovery: { attempt: 3, maxAttempts: 5, nextAttemptAt: past } });
    const core = await restart(harness.core, harness.root, execute);
    await schedulerTurn();
    expect(calls).toBe(0);
    expect(core.state.storage.get<Task>('tasks', seeded.task.id)).toMatchObject({ status: 'cancelled', runIds: [seeded.run.id] });
    expect(core.state.storage.get<Task>('tasks', seeded.task.id)?.recovery).toBeUndefined();
    expect(core.state.storage.get<Task>('tasks', seeded.task.id)?.resumeFromRunId).toBeUndefined();
  });

  it('keeps a completed recovery closed when later task work is retried', async () => {
    const seen: RunContext[] = [];
    const harness = await setup(async context => { seen.push(context); return { text: '后续工作完成' }; });
    const seeded = seedRunning(harness.core, harness.bot('后续工作成员'), 'ready', 3);
    const completed: Run = { ...seeded.run, id: 'completed-recovery', status: 'completed', resumeFromRunId: seeded.run.id };
    harness.core.state.storage.put('runs', { ...seeded.run, status: 'interrupted' });
    harness.core.state.storage.put('runs', completed);
    harness.core.state.storage.put('tasks', { ...seeded.task, status: 'interrupted', runIds: [seeded.run.id, completed.id] });
    harness.core.tasks.retry(seeded.task.id);
    harness.core.scheduler.resume();
    await eventually(() => harness.core.state.storage.get<Task>('tasks', seeded.task.id)?.status === 'completed');
    expect(seen).toHaveLength(1);
    expect(seen[0].progress).toBeUndefined();
  });

  it('requires reconciliation for an unknown operation owned by the resumed source run', async () => {
    let sourceRunId = '';
    const harness = await setup(async () => {
      harness.core.state.storage.put('tool_operations', { id: `${sourceRunId}:pending`, runId: sourceRunId, status: 'unknown' });
      return { text: '模型答复不能确认外部结果' };
    });
    const seeded = seedRunning(harness.core, harness.bot('续接对账成员'), 'ready', 3);
    sourceRunId = seeded.run.id;
    harness.core.state.storage.put('runs', { ...seeded.run, status: 'interrupted' });
    harness.core.state.storage.put('tasks', { ...seeded.task, status: 'queued', resumeFromRunId: seeded.run.id });
    harness.core.scheduler.resume();
    await eventually(() => harness.core.state.storage.get<Task>('tasks', seeded.task.id)?.reconciliationRequired === true);
    expect(harness.core.state.storage.get<Task>('tasks', seeded.task.id)?.status).toBe('interrupted');
    expect(() => harness.core.tasks.retry(seeded.task.id)).toThrow('尚未确认');
  });

  it('preserves a posted message once when the same task resumes in another run', async () => {
    const model = modelFixture(index => [complete(index === 0 ? [{ type: 'function_call', id: 'post', call_id: 'post',
      name: 'post_message', arguments: JSON.stringify({ content: '已经即时发表的进展' }), status: 'completed' }] : [answer])]);
    let interrupted = false;
    const { core, bot } = await setup(context => runManaged(model.client, {
      ...context,
      saveProgress: async progress => {
        await context.saveProgress!(progress);
        if (!interrupted && progress.messages.some(message => message.role === 'tool' && message.callId === 'post')) {
          interrupted = true;
          throw new Error('即时发言后中断');
        }
      },
    }, 'responses', [1, 1, 1, 1, 1]));
    const member = bot('即时发表成员', ['post_message']);
    const room = roomFor(core, member);
    const taskId = core.tasks.send({ conversationId: room.id, content: '先汇报进展再交付' }).taskIds[0];
    await eventually(() => core.state.storage.get<Task>('tasks', taskId)?.status === 'failed');
    const published = core.state.storage.messages().filter(message => message.conversationId === room.id && message.authorType === 'bot');
    expect(published).toHaveLength(1);
    expect(published[0]).toMatchObject({ content: '已经即时发表的进展', status: 'committed' });
    await core.request('tasks.retry', { id: taskId });
    await eventually(() => core.state.storage.get<Task>('tasks', taskId)?.status === 'completed');
    const task = core.state.storage.get<Task>('tasks', taskId)!;
    expect(task.runIds).toHaveLength(2);
    expect(task.result).toBe('恢复后的最终结果');
    expect(core.state.storage.messages().filter(message => message.conversationId === room.id && message.authorType === 'bot')).toEqual(published);
    expect(core.state.storage.all('tool_operations')).toEqual([
      expect.objectContaining({ id: `${task.runIds[0]}:post`, status: 'succeeded', name: 'post_message' }),
    ]);
    expect(model.requests).toHaveLength(2);
  });

  it.each([false, true])('restores the prior file observation and respects external changes: %s', async changed => {
    const call = (id: string, name: string, args: Record<string, string>) => ({ type: 'function_call', id, call_id: id,
      name, arguments: JSON.stringify(args), status: 'completed' });
    const model = modelFixture(index => [complete(index === 0
      ? [call('read-original', 'read_file', { path: 'original.txt' })]
      : index === 1 ? [call('edit-original', 'edit_file', { path: 'original.txt', oldText: 'original', newText: 'edited' })] : [answer])]);
    let interrupted = false;
    const { core, root, bot } = await setup(context => runManaged(model.client, {
      ...context,
      saveProgress: async progress => {
        await context.saveProgress!(progress);
        if (!interrupted && progress.messages.some(message => message.role === 'tool' && message.callId === 'read-original')) {
          interrupted = true;
          throw new Error('读取完成后中断');
        }
      },
    }, 'responses', [1, 1, 1, 1, 1]));
    const configured = bot('文件续接成员', ['read_file', 'edit_file']);
    const member = core.entities.saveBot({ ...configured, approvalMode: 'auto' });
    const room = roomFor(core, member);
    const path = join(root, 'workspace', 'original.txt');
    await writeFile(path, 'original body');
    const taskId = core.tasks.send({ conversationId: room.id, content: '读取并修改原文件' }).taskIds[0];
    await eventually(() => core.state.storage.get<Task>('tasks', taskId)?.status === 'failed');
    const readOperation = core.state.storage.all('tool_operations')[0];
    expect(readOperation).toMatchObject({ name: 'read_file', status: 'succeeded' });
    if (changed) await writeFile(path, 'original body\nexternal addition');
    await core.request('tasks.retry', { id: taskId });
    await eventually(() => core.state.storage.get<Task>('tasks', taskId)?.status === 'completed');
    const task = core.state.storage.get<Task>('tasks', taskId)!;
    expect(task.runIds).toHaveLength(2);
    const operations = core.state.storage.all<{ id: string; runId: string; name: string; status: string; error?: string }>('tool_operations');
    expect(operations).toHaveLength(2);
    expect(operations.find(operation => operation.name === 'read_file')).toEqual(readOperation);
    const edit = operations.find(operation => operation.name === 'edit_file')!;
    expect(edit).toMatchObject({ runId: task.runIds[1], status: changed ? 'failed' : 'succeeded' });
    if (changed) expect(edit.error).toContain('版本已变化');
    expect(await readFile(path, 'utf8')).toBe(changed ? 'original body\nexternal addition' : 'edited body');
    expect(model.requests).toHaveLength(3);
  });

  it('keeps a committed reply when a complete checkpoint is recovered', async () => {
    const model = modelFixture(() => [complete()]);
    const execute = (context: RunContext) => runManaged(model.client, context, 'responses');
    const harness = await setup(execute);
    const seeded = seedRunning(harness.core, harness.bot('已发表答复成员'), 'complete', 0);
    const saved = harness.core.state.storage.get<{ id: string; checkpoint: ManagedCheckpoint }>('provider_archive', seeded.run.id)!;
    saved.checkpoint.progress.text = '已经完成的答复';
    saved.checkpoint.progress.messages.push({ role: 'assistant', content: '已经完成的答复' });
    harness.core.state.storage.put('provider_archive', saved);
    const draft = harness.core.state.storage.getMessage(saved.checkpoint.draftId)!;
    const published = { ...draft, content: '已经完成的答复', status: 'committed' as const };
    harness.core.state.storage.updateMessage(published);
    const core = await restart(harness.core, harness.root, execute);
    await eventually(() => core.state.storage.get<Task>('tasks', seeded.task.id)?.status === 'completed');
    expect(model.requests).toHaveLength(0);
    expect(core.state.storage.messages().filter(message => message.authorType === 'bot')).toEqual([published]);
    expect(core.state.storage.get<Task>('tasks', seeded.task.id)?.result).toBe(published.content);
  });
});

function roomFor(core: CoreService, member: Bot): Conversation {
  return core.entities.createConversation({ name: '生命周期私聊', kind: 'private', memberIds: [member.id],
    workspaceId: core.state.snapshot().workspaces[0].id });
}

function seedRunning(core: CoreService, member: Bot, phase: ManagedProgress['phase'], attempt: number) {
  core.scheduler.pause();
  const room = roomFor(core, member);
  const workspace = core.state.storage.get<Workspace>('workspaces', room.workspaceId)!;
  const connection = core.state.snapshot().connections.find(item => item.id === member.connectionId)!;
  const binding = sessionBinding(core.state, member, room, connection, workspace);
  const task = core.tasks.create({ conversationId: room.id, botId: member.id, goal: '继续保存的任务' });
  const run: Run = { id: `crashed-${task.id}`, taskId: task.id, botId: member.id, bindingId: binding.id,
    status: 'running', configRevision: member.revision, createdAt: new Date().toISOString() };
  const draft = core.state.storage.appendMessage({ id: `draft-${task.id}`, conversationId: room.id,
    authorType: 'bot', authorBotId: member.id, runId: run.id, content: '', artifactIds: [], status: 'draft', createdAt: run.createdAt });
  const runningTask: Task = { ...task, status: 'running', runIds: [run.id] };
  core.state.storage.put('tasks', runningTask);
  core.state.storage.put('runs', run);
  core.state.storage.put('provider_archive', { id: run.id, bindingId: binding.id, entries: [], checkpoint: {
    taskId: task.id, conversationId: room.id, botId: member.id, generation: binding.generation,
    workspaceId: workspace.id, draftId: draft.id, cutoff: draft.sequence - 1,
    progress: { messages: [{ role: 'user', content: task.goal }], currentStart: 0, text: '', pendingInputIds: [],
      turnId: `${run.id}:turn:1`, attempt, phase },
  } satisfies ManagedCheckpoint });
  return { task: runningTask, run };
}

async function restart(previous: CoreService, root: string, run: ProviderAdapter['run']) {
  await previous.close();
  const adapter: ProviderAdapter = { kind: 'custom', probe: async () => ({ models: [], capabilities: caps }), run };
  const core = new CoreService(root, undefined, undefined, [adapter]);
  const resource = resources.find(item => item.core === previous)!;
  resource.core = core;
  await core.start();
  return core;
}

function modelFixture(reply: (index: number) => unknown[]) {
  const requests: unknown[] = [];
  const client = createClient('http://127.0.0.1:7777/v1', undefined, async (_input, init) => {
    requests.push(JSON.parse(String(init?.body)));
    const events = reply(requests.length - 1);
    return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''), {
      status: 200, headers: { 'content-type': 'text/event-stream' },
    });
  });
  return { client, requests };
}

async function schedulerTurn() { await new Promise(resolve => setTimeout(resolve, 40)); }
