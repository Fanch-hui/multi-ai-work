import { createHash } from 'node:crypto';
import { access, mkdir, readFile, stat, utimes, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Artifact, Run } from '../src/domain/types.js';
import { ArtifactContents, toolResultCacheBytes, toolResultCacheIdleMs } from '../src/core/artifact-contents.js';
import { setup } from './core-harness.js';

async function fixture(budget = 0) {
  const { core, root } = await setup(async () => ({ text: '完成' }));
  core.scheduler.pause();
  const s = core.state.storage, contents = new ArtifactContents(s, root, budget);
  const add = (id: string, content: string, conversationId = 'room', persistent = false): Artifact => {
    const artifact: Artifact = { id, name: '工具完整结果.txt', path: join(root, 'artifacts', id, 'tool-output.txt'),
      conversationId, mimeType: 'text/plain', size: Buffer.byteLength(content),
      sha256: createHash('sha256').update(content).digest('hex'), source: 'context-compaction', purpose: 'intermediate', createdAt: '',
      ...(!persistent ? { contentSource: { kind: 'stored-text' as const, key: `artifact-text:${id}` } } : {}) };
    s.put('artifacts', artifact);
    if (!persistent) s.setMetadata(`artifact-text:${id}`, content);
    return artifact;
  };
  return { core, root, s, contents, add };
}

describe('App 工具资料缓存', () => {
  it('默认额度为整个 App 共用128MiB，按最近使用回收跨会话副本并保持原ID可读', async () => {
    expect(toolResultCacheBytes).toBe(128 * 1024 * 1024);
    const { s, contents, add } = await fixture(30);
    const older = add('older', 'A'.repeat(20), 'first-room'), newer = add('newer', 'B'.repeat(20), 'second-room');
    await contents.materialize(older);
    await contents.materialize(newer);
    const past = new Date(Date.now() - 60000);
    await utimes(older.path, past, past);
    await contents.maintain();
    await expect(stat(older.path)).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await stat(newer.path)).size).toBe(20);
    expect(s.get('artifacts', older.id)).toBeDefined();
    expect((await contents.read(older)).toString()).toBe('A'.repeat(20));
    const restarted = new ArtifactContents(s, contents.dataDirectory, 30);
    expect((await restarted.read(older)).toString()).toBe('A'.repeat(20));
    expect(await restarted.canRead(older)).toBe(true);
  });

  it('正在读取与系统打开的文件受保护，释放读取后才回收', async () => {
    const { contents, add } = await fixture();
    const reading = add('reading', '正在读取'), opened = add('opened', '系统正在打开');
    await contents.materialize(reading);
    await contents.materialize(opened, true);
    let release!: () => void, began!: () => void;
    const ready = new Promise<void>(resolve => { began = resolve; });
    const hold = new Promise<void>(resolve => { release = resolve; });
    const active = contents.withPinned(reading, async () => { began(); await hold; });
    await ready;
    await contents.maintain();
    expect(await readFile(reading.path, 'utf8')).toBe('正在读取');
    expect(await readFile(opened.path, 'utf8')).toBe('系统正在打开');
    release(); await active;
    await contents.maintain();
    await expect(stat(reading.path)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(opened.path, 'utf8')).toBe('系统正在打开');
  });

  it('未达到容量上限也回收12小时未使用的副本，实际读取会刷新时间', async () => {
    expect(toolResultCacheIdleMs).toBe(12 * 60 * 60 * 1000);
    const { contents, add } = await fixture(toolResultCacheBytes);
    const expired = add('expired', '过期缓存'), reused = add('reused', '重新使用的缓存');
    await contents.materialize(expired);
    await contents.materialize(reused);
    const past = new Date(Date.now() - toolResultCacheIdleMs - 60000);
    await utimes(expired.path, past, past);
    await utimes(reused.path, past, past);
    expect((await contents.read(reused)).toString()).toBe('重新使用的缓存');
    await contents.maintain();
    await expect(stat(expired.path)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(reused.path, 'utf8')).toBe('重新使用的缓存');
    expect((await contents.read(expired)).toString()).toBe('过期缓存');
  });

  it('缓存额度再小也保留唯一原文和无法校验的副本', async () => {
    const { s, contents, add } = await fixture();
    const unique = add('unique', '唯一原文', 'room', true), damaged = add('damaged', '完整原文');
    await mkdir(dirname(unique.path), { recursive: true });
    await writeFile(unique.path, '唯一原文');
    await contents.materialize(damaged);
    s.setMetadata('artifact-text:damaged', '已经改变');
    await contents.maintain();
    expect(await readFile(unique.path, 'utf8')).toBe('唯一原文');
    expect(await readFile(damaged.path, 'utf8')).toBe('完整原文');
  });

  it('旧文件逐个匹配真实记录，内容相同才迁移并回收', async () => {
    const { s, contents, add } = await fixture(toolResultCacheBytes);
    const content = '旧版本留下的完整工具结果';
    s.put('tasks', { id: 'task', botId: 'bot', runIds: ['run'] });
    s.put('runs', { id: 'run', taskId: 'task', botId: 'bot' });
    s.put('tool_operations', { id: 'run:read', runId: 'run', status: 'succeeded', result: content });
    const matched = { ...add('matched', content, 'room', true), taskId: 'task' };
    const unique = { ...add('unmatched', '没有其他来源的原文', 'room', true), taskId: 'task' };
    for (const artifact of [matched, unique]) {
      s.put('artifacts', artifact);
      await mkdir(dirname(artifact.path), { recursive: true });
      await writeFile(artifact.path, artifact.id === 'matched' ? content : '没有其他来源的原文');
      const past = new Date(Date.now() - toolResultCacheIdleMs - 60000);
      await utimes(artifact.path, past, past);
    }
    await contents.maintain();
    expect(s.get<Artifact>('artifacts', matched.id)?.contentSource?.kind).toBe('tool-operation');
    await expect(stat(matched.path)).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await contents.read(matched)).toString()).toBe(content);
    expect(s.get<Artifact>('artifacts', unique.id)?.contentSource).toBeUndefined();
    expect(await readFile(unique.path, 'utf8')).toBe('没有其他来源的原文');
  });

  it('备份暂停整理期间不回收，删除成果后拒绝使用旧引用读取', async () => {
    const { s, contents, add } = await fixture();
    const artifact = add('paused', '备份所需内容');
    await contents.materialize(artifact);
    const resume = await contents.pauseMaintenance();
    await contents.maintain();
    expect(await readFile(artifact.path, 'utf8')).toBe('备份所需内容');
    resume(); await contents.maintain();
    await expect(stat(artifact.path)).rejects.toMatchObject({ code: 'ENOENT' });
    s.delete('artifacts', artifact.id);
    expect(await contents.canRead(artifact)).toBe(false);
    await expect(contents.read(artifact)).rejects.toThrow('成果不存在');
  });

  it('界面查看和打开可按需恢复文件，用户删除后同时清除目录正文', async () => {
    const { core, s, add } = await fixture();
    const artifact = add('view', '可供界面查看的资料');
    const read = await core.request('artifacts.read', { id: artifact.id }) as { content: string };
    expect(read.content).toBe('可供界面查看的资料');
    await expect(stat(artifact.path)).rejects.toMatchObject({ code: 'ENOENT' });
    const opened = await core.request('artifacts.open', { id: artifact.id }) as { path: string };
    expect(await readFile(opened.path, 'utf8')).toBe(read.content);
    await core.request('artifacts.delete', { id: artifact.id });
    expect(s.get('artifacts', artifact.id)).toBeUndefined();
    expect(s.metadata('artifact-text:view')).toBeUndefined();
  });

  it('原生通道的大结果也复用记录，重新读取文件保留新旧两个时点的真实结果', async () => {
    const { core, bot, connection } = await setup(async () => ({ text: '完成' }));
    core.scheduler.pause();
    const s = core.state.storage;
    s.put('connections', { ...connection, status: 'ready', provider: 'qoder' });
    const member = bot('资料助手', ['read_file', 'read_artifact']);
    const workspace = core.state.snapshot().workspaces[0];
    const room = core.entities.createConversation({ name: '原生资料', kind: 'private', memberIds: [member.id], workspaceId: workspace.id });
    const task = core.tasks.create({ conversationId: room.id, botId: member.id, goal: '读取资料' });
    const run: Run = { id: 'native-run', taskId: task.id, botId: member.id, bindingId: 'binding', status: 'running', configRevision: 1, createdAt: '' };
    s.put('runs', run);
    const context = core.tools.context(run, task, member, room, workspace, new AbortController().signal);
    const path = join(workspace.path, 'source.txt');
    await writeFile(path, '第一次读取的资料'.repeat(6000));
    const result = await core.tools.execute('read_file', { path }, 'first', context, member) as { artifactId: string; truncated: boolean };
    expect(result.truncated).toBe(true);
    const artifact = s.get<Artifact>('artifacts', result.artifactId)!;
    expect(artifact.contentSource).toMatchObject({ kind: 'tool-operation', operationId: `${run.id}:first` });
    await expect(access(artifact.path)).rejects.toMatchObject({ code: 'ENOENT' });
    const original = JSON.stringify(s.get<{ result: unknown }>('tool_operations', `${run.id}:first`)!.result);
    const page = await core.tools.execute('read_artifact', { artifactId: artifact.id, offset: 1000, limit: 4000 }, 'page', context, member) as { content: string };
    expect(page.content).toBe(original.slice(1000, 5000));
    await writeFile(path, '现在的资料');
    const fresh = await core.tools.execute('read_file', { path }, 'fresh', context, member) as { content: string };
    expect(fresh.content).toBe('现在的资料');
    expect((await core.state.artifactContents.read(artifact)).toString()).toBe(original);
    await expect(access(artifact.path)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
