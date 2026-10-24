import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { BackupService } from '../src/core/backup.js';
import { ChiefContextService } from '../src/core/chief-contexts.js';
import {
  ensureDefaultWorkspace,
  migrateChiefContinuity,
} from '../src/core/chief-continuity-migration.js';
import { State } from '../src/core/state.js';
import { Storage } from '../src/core/storage.js';
import type { ChiefInput, ChiefWorkContext } from '../src/domain/chief-work.js';
import type { Artifact, Task, Workspace } from '../src/domain/types.js';

const roots: string[] = [];
const databases: { close(): void }[] = [];
afterEach(async () => {
  for (const database of databases.splice(0)) database.close();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function directory() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'chief-continuity-')));
  roots.push(root);
  return root;
}
async function stateFixture() {
  const root = await directory();
  const state = new State(root);
  databases.push(state.storage.db);
  ensureDefaultWorkspace(state.storage, root);
  return { state, root };
}

describe('连续管家的存储升级', () => {
  it.each(['queued', 'recovering', 'waiting_input', 'waiting_approval', 'waiting_children'])(
    '旧版本存在 %s 任务时保持原数据库版本，待任务收尾后升级',
    async (status) => {
      const root = await directory();
      const path = join(root, 'team.sqlite');
      const legacy = new Database(path);
      legacy.exec('CREATE TABLE tasks (id TEXT PRIMARY KEY, payload TEXT NOT NULL)');
      legacy.prepare('INSERT INTO tasks VALUES (?, ?)').run('legacy', JSON.stringify({ status }));
      legacy.pragma('user_version = 2');
      legacy.close();
      expect(() => new Storage(path)).toThrow('完成或停止全部任务');
      const unchanged = new Database(path);
      expect(unchanged.pragma('user_version', { simple: true })).toBe(2);
      unchanged
        .prepare('UPDATE tasks SET payload = ?')
        .run(JSON.stringify({ status: 'completed' }));
      unchanged.close();
      const upgraded = new Storage(path);
      databases.push(upgraded.db);
      expect(upgraded.db.pragma('user_version', { simple: true })).toBe(3);
    },
  );

  it.each(['running', 'unknown'])('旧命令 %s 状态下暂停升级', async (status) => {
    const root = await directory();
    const path = join(root, 'team.sqlite');
    const legacy = new Database(path);
    legacy.exec('CREATE TABLE processes (id TEXT PRIMARY KEY, payload TEXT NOT NULL)');
    legacy
      .prepare('INSERT INTO processes VALUES (?, ?)')
      .run('process', JSON.stringify({ status }));
    legacy.pragma('user_version = 2');
    legacy.close();
    expect(() => new Storage(path)).toThrow('命令进程已退出');
    const unchanged = new Database(path);
    expect(unchanged.pragma('user_version', { simple: true })).toBe(2);
    unchanged.close();
  });

  it.each([
    ['tool_operations', 'prepared'],
    ['tool_operations', 'dispatched'],
    ['tool_operations', 'unknown'],
    ['approvals', 'pending'],
    ['questions', 'pending'],
    ['task_waits', 'pending'],
  ])('旧 %s 的 %s 操作收尾后才升级', async (table, status) => {
    const root = await directory();
    const path = join(root, 'team.sqlite');
    const legacy = new Database(path);
    legacy.exec(`CREATE TABLE ${table} (id TEXT PRIMARY KEY, payload TEXT NOT NULL)`);
    legacy
      .prepare(`INSERT INTO ${table} VALUES (?, ?)`)
      .run('unfinished', JSON.stringify({ status }));
    legacy.pragma('user_version = 2');
    legacy.close();
    expect(() => new Storage(path)).toThrow(
      table === 'tool_operations' ? '核查并对账' : '待回答问题与审批',
    );
    const unchanged = new Database(path);
    expect(unchanged.pragma('user_version', { simple: true })).toBe(2);
    unchanged.close();
  });

  it('以实际目录复用工作成果 ID，其他目录的读写授权保持原值', async () => {
    const { state, root } = await stateFixture();
    const original = ensureDefaultWorkspace(state.storage, root);
    const external = join(root, 'external');
    await mkdir(external);
    state.storage.put('workspaces', {
      id: 'external',
      name: '工作成果',
      path: external,
      writable: false,
      enabled: false,
    });
    state.storage.setMetadata('settings', { ...state.settings(), defaultWorkspaceId: 'external' });
    const first = ensureDefaultWorkspace(state.storage, root);
    const second = ensureDefaultWorkspace(state.storage, root);
    expect(first.id).toBe(original.id);
    expect(second.id).toBe(original.id);
    expect(
      state.storage.metadata<{ defaultWorkspaceId: string }>('settings')?.defaultWorkspaceId,
    ).toBe(original.id);
    expect(state.storage.get<Workspace>('workspaces', 'external')).toMatchObject({
      writable: false,
      enabled: false,
      path: external,
    });
  });

  it('一次迁移保留原文与原归属，并将尚未派发的输入交给新的连续主段', async () => {
    const { state } = await stateFixture();
    const contexts = new ChiefContextService(state);
    const old = contexts.create({ title: '原来的话题' });
    const source = state.storage.appendMessage({
      id: 'legacy-original',
      conversationId: old.conversationId,
      authorType: 'user',
      content: '我希望沿用前文',
      artifactIds: [],
      status: 'committed',
      createdAt: old.createdAt,
    });
    state.storage.put('chief_timeline', {
      id: 'legacy-anchor',
      homeConversationId: contexts.homeId,
      displaySequence: 24,
      messageId: source.id,
    });
    const pending: ChiefInput = {
      id: 'pending',
      requestId: 'client-request',
      messageId: 'pending-original',
      homeConversationId: contexts.homeId,
      fingerprint: 'original-fingerprint',
      content: '继续',
      artifactIds: [],
      status: 'clarification',
      taskIds: [],
      targetContextId: old.id,
      routingTaskId: 'completed-router',
      question: '旧归属问题',
      createdAt: old.createdAt,
    };
    state.storage.put('chief_inputs', pending);
    state.storage.put('chief_inputs', { ...pending, id: 'sent', status: 'dispatched' });
    state.storage.setMetadata('chief-continuity-v2', false);
    migrateChiefContinuity(state);
    const main = contexts.main();
    expect(main.context.kind).toBe('main');
    expect(main.room.id).not.toBe(old.conversationId);
    expect(state.storage.get<ChiefWorkContext>('chief_contexts', old.id)?.kind).toBe('history');
    expect(state.storage.getMessage(source.id)).toEqual(source);
    expect(state.storage.get('chief_timeline', 'legacy-anchor')).toMatchObject({
      displaySequence: 24,
    });
    expect(state.storage.get<ChiefInput>('chief_inputs', pending.id)).toMatchObject({
      requestId: pending.requestId,
      messageId: pending.messageId,
      fingerprint: pending.fingerprint,
      content: pending.content,
      status: 'pending',
      contextId: main.context.id,
    });
    expect(
      state.storage.get<ChiefInput>('chief_inputs', pending.id)?.routingTaskId,
    ).toBeUndefined();
    expect(state.storage.get<ChiefInput>('chief_inputs', 'sent')).toMatchObject({
      status: 'dispatched',
      targetContextId: old.id,
    });
    const count = state.storage.all('chief_contexts').length;
    migrateChiefContinuity(state);
    expect(contexts.main().context.id).toBe(main.context.id);
    expect(state.storage.all('chief_contexts')).toHaveLength(count);
  });
  it('时间线基线缺失时从主入口原文重建，并保留已有显示序号与资料范围', async () => {
    const { state, root } = await stateFixture();
    const s = state.storage;
    const contexts = new ChiefContextService(state);
    const previous = contexts.main();
    s.put('chief_contexts', { ...previous.context, kind: 'history' });
    s.setMetadata(`chief-main-context:${contexts.homeId}`, null);
    const own: Artifact = {
      id: 'own-original',
      name: 'own.md',
      path: join(root, 'own.md'),
      mimeType: 'text/markdown',
      size: 0,
      sha256: '',
      conversationId: contexts.homeId,
      createdAt: previous.context.createdAt,
    };
    s.put('artifacts', own);
    s.put('artifacts', { ...own, id: 'member-private', conversationId: 'member-private-room' });
    const message = s.appendMessage({
      id: 'home-original',
      conversationId: contexts.homeId,
      authorType: 'user',
      content: '继续主入口原文',
      artifactIds: [own.id, 'member-private'],
      status: 'committed',
      createdAt: previous.context.createdAt,
    });
    s.put('chief_timeline', {
      id: 'prior-stable-entry',
      homeConversationId: contexts.homeId,
      displaySequence: 24,
      messageId: 'prior-source',
    });
    s.setMetadata(`chief-timeline-sequence:${contexts.homeId}`, 0);
    s.setMetadata('chief-timeline-v1', true);
    s.setMetadata('chief-continuity-v2', false);
    migrateChiefContinuity(state);
    const main = contexts.main();
    expect(main.part.sourceMessageIds).toContain(message.id);
    expect(s.get('chief_timeline', message.id)).toMatchObject({ displaySequence: 25 });
    expect(s.get('chief_timeline', 'prior-stable-entry')).toMatchObject({ displaySequence: 24 });
    expect(s.metadata(`chief-artifact-grants:${main.room.id}`)).toEqual([own.id]);
    expect(s.getMessage(message.id)).toEqual(message);
  });
});

describe('连续管家的跨目录备份恢复', () => {
  it.each([1, 2, 3, 4])(
    '恢复格式 %i 后默认目录定位本机，外部项目及成果版本保持归属',
    async (version) => {
      const { state: source, root: sourceRoot } = await stateFixture();
      const builtin = ensureDefaultWorkspace(source.storage, sourceRoot);
      const external = join(sourceRoot, 'project');
      await mkdir(external);
      source.storage.put('workspaces', {
        id: 'external-project',
        name: '项目',
        path: external,
        writable: false,
        enabled: false,
      });
      const bytes = Buffer.from('报告正文');
      const path = join(sourceRoot, 'report.md');
      await writeFile(path, bytes);
      const artifact: Artifact = {
        id: 'historical-report',
        name: 'report.md',
        path,
        mimeType: 'text/markdown',
        size: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        conversationId: source.settings().mainConversationId!,
        createdAt: new Date().toISOString(),
        chiefContextId: 'stable-work',
        botId: source.settings().mainBotId,
        workingPath: join(builtin.path, 'report.md'),
        purpose: 'deliverable',
      };
      source.storage.put('artifacts', artifact);
      source.storage.setMetadata(`chief-work-reports:${source.settings().mainConversationId}`, [
        { id: 'pending-report', content: '等待接入', taskId: 'finished-work' },
        { id: 'delivered-report', content: '已接入', deliveredAt: '2026-10-24' },
      ]);
      const task: Task = {
        id: 'restored-work-task',
        conversationId: source.settings().mainConversationId!,
        botId: source.settings().mainBotId!,
        dependencyIds: [],
        goal: '等待用户补充',
        expectedOutput: '报告',
        status: 'waiting_input',
        runIds: [],
        artifactIds: [],
        requestId: 'original-work-request',
        depth: 0,
        createdAt: artifact.createdAt,
        updatedAt: artifact.createdAt,
      };
      source.storage.put('tasks', task);
      const created = await new BackupService(source).create();
      const manifestPath = join(created.path, 'manifest.json');
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
      expect(manifest.version).toBe(4);
      if (version < 4) {
        const databasePath = join(created.path, 'team.sqlite');
        const legacy = new Database(databasePath);
        const { defaultWorkspaceId: _, ...settings } = source.settings();
        legacy
          .prepare('UPDATE metadata SET value = ? WHERE key = ?')
          .run(JSON.stringify(settings), 'settings');
        legacy.pragma(`user_version = ${version === 1 ? 1 : 2}`);
        legacy.close();
        manifest.databaseSha256 = createHash('sha256')
          .update(await readFile(databasePath))
          .digest('hex');
      }
      await writeFile(manifestPath, JSON.stringify({ ...manifest, version }));
      const { state: target, root: targetRoot } = await stateFixture();
      await new BackupService(target).restore(created.path);
      const restored = target.storage.get<Artifact>('artifacts', artifact.id)!;
      expect(target.storage.metadata('chief-restored-report-tasks')).toEqual([task.id]);
      expect(target.settings().defaultWorkspaceId).toBe(builtin.id);
      expect(target.storage.get<Workspace>('workspaces', builtin.id)?.path).toBe(
        join(targetRoot, 'workspace'),
      );
      expect(target.storage.get<Workspace>('workspaces', 'external-project')).toEqual({
        id: 'external-project',
        name: '项目',
        path: external,
        writable: false,
        enabled: false,
      });
      expect(restored.chiefContextId).toBe('stable-work');
      expect(restored.workingPath).toBe(join(targetRoot, 'workspace', 'report.md'));
      expect(await readFile(restored.path, 'utf8')).toBe('报告正文');
      expect(
        target.storage.metadata(`chief-work-reports:${source.settings().mainConversationId}`),
      ).toEqual([
        { id: 'pending-report', content: '等待接入', taskId: 'finished-work', suspended: true },
        { id: 'delivered-report', content: '已接入', deliveredAt: '2026-10-24' },
      ]);
    },
  );
});
