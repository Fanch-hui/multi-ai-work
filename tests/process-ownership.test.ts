import { describe, expect, it } from 'vitest';
import type { Bot, ProcessRecord, Run, Task } from '../src/domain/types.js';
import { id, now } from '../src/core/state.js';
import { eventually, setup } from './core-harness.js';

async function fixture() {
  const { core, bot } = await setup(async () => ({ text: '' }));
  core.scheduler.pause();
  const workspace = core.state.snapshot().workspaces[0];
  const actor = (name: string, tools: string[], approvalMode: 'auto' | 'ask' = 'auto') => {
    const member = core.entities.saveBot({ ...bot(name, tools), approvalMode });
    const room = core.entities.createConversation({
      name,
      kind: 'private',
      memberIds: [member.id],
      workspaceId: workspace.id,
      ...(name === 'Chief' ? { chiefId: member.id } : {}),
    });
    const task: Task = {
      id: id(),
      botId: member.id,
      conversationId: room.id,
      dependencyIds: [],
      goal: '命令管理',
      expectedOutput: '',
      status: 'running',
      runIds: [],
      artifactIds: [],
      requestId: id(),
      depth: 0,
      createdAt: now(),
      updatedAt: now(),
    };
    const run: Run = {
      id: id(),
      taskId: task.id,
      botId: member.id,
      bindingId: id(),
      status: 'running',
      configRevision: member.revision,
      createdAt: now(),
    };
    task.runIds.push(run.id);
    core.state.storage.put('tasks', task);
    core.state.storage.put('runs', run);
    const context = core.tools.context(
      run,
      task,
      member,
      room,
      workspace,
      new AbortController().signal,
    );
    return {
      member,
      task,
      context,
      execute: (name: string, args: Record<string, unknown>) =>
        core.tools.execute(name, args, id(), context, member),
    };
  };
  const owner = actor('命令成员', ['run_command', 'read_process', 'stop_process']);
  const chief = actor('Chief', ['list_processes', 'read_process', 'stop_process']);
  return { core, actor, owner, chief };
}

async function start(owner: Awaited<ReturnType<typeof fixture>>['owner'], tree = false) {
  const script = tree
    ? 'const {spawn}=require("node:child_process");const child=spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:["ignore","inherit","inherit"]});console.log(child.pid);setInterval(()=>{},1000)'
    : 'console.log("ready");setInterval(()=>{},1000)';
  const result = (await owner.execute('run_command', {
    command: process.execPath,
    args: ['-e', script],
    background: true,
  })) as ProcessRecord & { processId: string };
  expect(result.status).toBe('running');
  return result;
}

function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe('App 命令所有权与主管停止权限', () => {
  it('成员不能停止其他成员命令，名称和职责不能伪造主管身份，仍可停止自己的命令', async () => {
    const { core, owner, actor } = await fixture();
    const other = actor('普通成员', ['stop_process', 'list_processes']);
    core.entities.saveBot({ ...other.member, name: 'Chief', role: 'Chief' });
    const started = await start(owner);
    const denied = (await other.execute('stop_process', { processId: started.processId })) as {
      error: string;
    };
    expect(denied.error).toContain('未授权');
    expect(await other.execute('list_processes', {})).toEqual([]);
    expect(core.state.storage.get<ProcessRecord>('processes', started.processId)?.status).toBe(
      'running',
    );
    expect(alive(started.pid!)).toBe(true);
    const stopped = (await owner.execute('stop_process', {
      processId: started.processId,
    })) as ProcessRecord;
    expect(stopped).toMatchObject({
      status: 'stopped',
      botId: owner.member.id,
      stoppedByBotId: owner.member.id,
      stoppedByTaskId: owner.task.id,
    });
    expect(alive(started.pid!)).toBe(false);
  });

  it('主管可列出并停止 App 注册的成员命令及子进程，产出归属保持原成员且日志仍受私聊权限约束', async () => {
    const { core, owner, chief } = await fixture();
    const started = await start(owner, true);
    await eventually(
      () => !!core.state.storage.get<ProcessRecord>('processes', started.processId)?.stdout?.trim(),
    );
    const childPid = Number(
      core.state.storage.get<ProcessRecord>('processes', started.processId)!.stdout!.trim(),
    );
    expect(childPid).toBeGreaterThan(0);
    expect(alive(childPid)).toBe(true);
    const list = (await chief.execute('list_processes', {})) as ProcessRecord[];
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ botId: owner.member.id, taskId: owner.task.id });
    expect(list[0]).not.toHaveProperty('stdout');
    const denied = (await chief.execute('read_process', { processId: started.processId })) as {
      error: string;
    };
    expect(denied.error).toContain('未授权');
    const stopped = (await chief.execute('stop_process', {
      processId: started.processId,
    })) as ProcessRecord;
    expect(stopped).toMatchObject({
      status: 'stopped',
      botId: owner.member.id,
      taskId: owner.task.id,
      conversationId: owner.context.conversation.id,
      stoppedByBotId: chief.member.id,
      stoppedByTaskId: chief.task.id,
    });
    expect(alive(started.pid!)).toBe(false);
    await eventually(() => !alive(childPid));
    expect(core.tools.processes.hasActive()).toBe(false);
    expect(
      core.state.storage
        .all<{ name: string; status: string }>('tool_operations')
        .filter((operation) => operation.name === 'stop_process')
        .map((operation) => operation.status),
    ).toEqual(['succeeded']);
  });

  it.each(['rejected', 'revoked'] as const)(
    '主管跨成员停止在审批%s后保持目标运行',
    async (mode) => {
      const { core, owner, chief } = await fixture();
      core.entities.saveBot({ ...chief.member, approvalMode: 'ask' });
      const started = await start(owner);
      const stopping = chief.execute('stop_process', { processId: started.processId });
      await eventually(() =>
        core.state.snapshot().approvals.some((approval) => approval.status === 'pending'),
      );
      const approval = core.state.snapshot().approvals.find((item) => item.status === 'pending')!;
      expect(approval).toMatchObject({
        botId: chief.member.id,
        toolName: 'stop_process',
        args: { processId: started.processId, botId: owner.member.id, taskId: owner.task.id },
      });
      if (mode === 'revoked') {
        const current = core.state.storage.get<Bot>('bots', chief.member.id)!;
        core.entities.saveBot({
          ...current,
          toolNames: current.toolNames.filter((name) => name !== 'stop_process'),
        });
      }
      core.approvals.resolve(approval.id, mode === 'revoked');
      const result = (await stopping) as { error: string };
      expect(result.error).toContain(mode === 'rejected' ? '未获批准' : '未授权');
      expect(core.state.storage.get<ProcessRecord>('processes', started.processId)).toMatchObject({
        status: 'running',
        botId: owner.member.id,
      });
      expect(alive(started.pid!)).toBe(true);
      expect(
        core.state.storage.get<ProcessRecord>('processes', started.processId),
      ).not.toHaveProperty('stoppedByBotId');
      await owner.execute('stop_process', { processId: started.processId });
    },
  );
});
