import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import type { Routine } from '../src/domain/routines.js';
import type { TaskWait } from '../src/domain/task-wait.js';
import type { Run, Task } from '../src/domain/types.js';
import type { BrowserProfile, BrowserSession } from '../src/domain/work-browser.js';
import { setup } from './core-harness.js';

const ongoingTables = [
  'routines',
  'routine_occurrences',
  'artifact_reviews',
  'browser_profiles',
  'browser_sessions',
  'task_waits',
] as const;

async function fixture() {
  const { core, bot } = await setup(
    async () => ({ text: '完成' }),
    async () => ({}),
  );
  core.scheduler.pause();
  core.routines.close();
  const member = bot('资料员');
  const workspaceId = core.state.snapshot().workspaces[0]!.id;
  const room = core.entities.createConversation({
    name: '例行资料整理',
    kind: 'private',
    memberIds: [member.id],
    workspaceId,
  });
  const original = core.tasks.create({
    conversationId: room.id,
    botId: member.id,
    goal: '整理资料',
  });
  const createdAt = new Date().toISOString();
  const run: Run = {
    id: 'waiting-run',
    taskId: original.id,
    botId: member.id,
    bindingId: 'waiting-binding',
    status: 'waiting_input',
    configRevision: member.revision,
    createdAt,
    endedAt: createdAt,
  };
  const task = core.tasks.update(original, { status: 'waiting_input', runIds: [run.id] });
  core.state.storage.put('runs', run);
  const wait: TaskWait = {
    id: 'approval-wait',
    taskId: task.id,
    runId: run.id,
    conversationId: room.id,
    botId: member.id,
    kind: 'approval',
    summary: '等待确认写入报告',
    status: 'pending',
    createdAt,
  };
  core.state.storage.put('task_waits', wait);
  const profile: BrowserProfile = {
    id: 'work-profile',
    name: '工作浏览器',
    allowedBotIds: [member.id],
    createdAt,
  };
  core.state.storage.put('browser_profiles', profile);
  for (const status of ['active', 'handoff'] as const) {
    const session: BrowserSession = {
      id: `browser-${status}`,
      profileId: profile.id,
      taskId: task.id,
      botId: member.id,
      conversationId: room.id,
      status,
      createdAt,
    };
    core.state.storage.put('browser_sessions', session);
  }
  const routine: Routine = {
    id: 'daily-routine',
    name: '每日整理',
    botId: member.id,
    workspaceId,
    conversationId: room.id,
    goal: '整理资料',
    expectedOutput: '报告',
    inputArtifactIds: [],
    schedule: { kind: 'daily', time: '09:00' },
    timeZone: 'UTC',
    missedRunPolicy: 'latest',
    enabled: true,
    revision: 1,
    nextRunAt: '2099-01-01T09:00:00.000Z',
    pendingAt: '2026-10-22T09:00:00.000Z',
    createdAt,
    updatedAt: createdAt,
  };
  core.state.storage.put('routines', routine);
  return { core, task, wait, profile, routine };
}

describe('持续工作的备份恢复', () => {
  it('恢复后取消人工等待、关闭浏览器会话并暂停例行工作', async () => {
    const { core, task, wait, profile, routine } = await fixture();
    const backup = (await core.request('backup.create')) as { path: string };
    core.state.storage.delete('task_waits', wait.id);
    core.state.storage.delete('routines', routine.id);

    await core.request('backup.restore', { path: backup.path });

    expect(core.state.storage.get<Task>('tasks', task.id)?.status).toBe('interrupted');
    expect(core.state.storage.get<TaskWait>('task_waits', wait.id)).toMatchObject({
      ...wait,
      status: 'cancelled',
      resolvedAt: expect.any(String),
    });
    expect(await core.request('waits.list')).toEqual([]);
    expect(core.state.storage.all<BrowserSession>('browser_sessions')).toMatchObject([
      { id: 'browser-active', profileId: profile.id, status: 'closed' },
      { id: 'browser-handoff', profileId: profile.id, status: 'closed' },
    ]);
    expect(core.state.storage.get<BrowserProfile>('browser_profiles', profile.id)).toEqual(profile);
    expect(core.state.storage.get<Routine>('routines', routine.id)).toMatchObject({
      enabled: false,
      error: '备份已恢复，请检查资料和连接后启用',
      nextRunAt: routine.nextRunAt,
    });
    expect(core.state.storage.get<Routine>('routines', routine.id)?.pendingAt).toBeUndefined();
    const count = core.state.storage.all('tasks').length;
    core.routines.tick();
    expect(core.state.storage.all('tasks')).toHaveLength(count);
  });

  it('恢复缺少持续工作新表的旧备份，并清空当前对应数据', async () => {
    const { core, task } = await fixture();
    const backup = (await core.request('backup.create')) as { path: string };
    const databasePath = join(backup.path, 'team.sqlite');
    const database = new Database(databasePath);
    try {
      for (const table of ongoingTables) database.exec(`DROP TABLE ${table}`);
    } finally {
      database.close();
    }
    const manifestPath = join(backup.path, 'manifest.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    manifest.databaseSha256 = createHash('sha256')
      .update(await readFile(databasePath))
      .digest('hex');
    await writeFile(manifestPath, JSON.stringify(manifest));

    await expect(core.request('backup.restore', { path: backup.path })).resolves.toMatchObject({
      restored: true,
    });

    for (const table of ongoingTables) expect(core.state.storage.all(table)).toEqual([]);
    expect(core.state.storage.get<Task>('tasks', task.id)).toMatchObject({
      goal: task.goal,
      status: 'interrupted',
    });
  });
});
