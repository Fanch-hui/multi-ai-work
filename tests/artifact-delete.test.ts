import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Artifact, Task } from '../src/domain/types.js';
import { importAttachment } from '../src/core/attachments.js';
import { inspectTask } from '../src/core/task-inspection.js';
import { setup } from './core-harness.js';

describe('库成果删除', () => {
  it('删除记录、App 副本和对应预览，保留工作区原文件与其他成果', async () => {
    const { core, root } = await setup(async () => ({ text: '完成' }));
    const conversationId = core.state.settings().mainConversationId!;
    const original = path.join(root, 'original.txt');
    await writeFile(original, '用户原文件');
    const artifact = await importAttachment(core.state, conversationId, original);
    const other = await importAttachment(core.state, conversationId, original);
    core.state.storage.put('artifacts', { ...artifact, workingPath: original });
    const cacheKey = 'a'.repeat(64), cache = path.join(root, 'artifact-previews', cacheKey);
    await mkdir(cache, { recursive: true }); await writeFile(path.join(cache, 'page.png'), '预览');
    core.state.storage.setMetadata(`artifact-preview:${artifact.id}`, cacheKey);
    const task = { id: 'completed-task', conversationId, botId: core.state.settings().mainBotId!,
      status: 'completed', artifactIds: [artifact.id, other.id], runIds: [], dependencyIds: [], goal: '交付',
      expectedOutput: '', requestId: 'completed-task', depth: 0, createdAt: '', updatedAt: '' } satisfies Task;
    core.state.storage.put('tasks', task);
    expect(await core.request('artifacts.delete', { id: artifact.id })).toEqual({ ok: true });
    expect(core.state.storage.get('artifacts', artifact.id)).toBeUndefined();
    await expect(stat(path.dirname(artifact.path))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(stat(cache)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(original, 'utf8')).toBe('用户原文件');
    expect(await readFile(other.path, 'utf8')).toBe('用户原文件');
    expect(inspectTask(core.state, task).artifactIds).toEqual([other.id]);
    await expect(core.request('artifacts.read', { id: artifact.id })).rejects.toThrow('成果不存在');
  });

  it('旧成果的外部路径只删除库记录，不删除该路径的文件', async () => {
    const { core, root } = await setup(async () => ({ text: '完成' }));
    const original = path.join(root, 'legacy.txt'); await writeFile(original, '原文件');
    const artifact: Artifact = { id: 'legacy', conversationId: core.state.settings().mainConversationId!,
      name: 'legacy.txt', path: original, mimeType: 'text/plain', size: 9, sha256: '', createdAt: '' };
    core.state.storage.put('artifacts', artifact);
    await core.request('artifacts.delete', { id: artifact.id });
    expect(core.state.storage.get('artifacts', artifact.id)).toBeUndefined();
    expect(await readFile(original, 'utf8')).toBe('原文件');
  });

  it('恢复后删除精确移除成果副本与图片预览，保留同批其他成果、备份和原文件', async () => {
    const { core, root } = await setup(async () => ({ text: '完成' }));
    const original = path.join(root, 'restore-original.txt'); await writeFile(original, '备份内容');
    const roomId = core.state.settings().mainConversationId!;
    const artifact = await importAttachment(core.state, roomId, original);
    const other = await importAttachment(core.state, roomId, original);
    const backup = await core.request('backup.create', {}) as { path: string };
    await core.request('backup.restore', { path: backup.path });
    const restored = core.state.storage.get<Artifact>('artifacts', artifact.id)!;
    const retained = core.state.storage.get<Artifact>('artifacts', other.id)!;
    const preview = path.join(path.dirname(restored.path), `${artifact.id}-preview`);
    await mkdir(path.join(preview, '.image'), { recursive: true });
    await writeFile(path.join(preview, '.image', 'model.png'), '图片预览');
    await core.request('artifacts.delete', { id: restored.id });
    expect(core.state.storage.get('artifacts', restored.id)).toBeUndefined();
    await expect(stat(restored.path)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(stat(preview)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(retained.path, 'utf8')).toBe('备份内容');
    expect(await readFile(path.join(backup.path, 'artifacts', artifact.id), 'utf8')).toBe('备份内容');
    expect(await readFile(original, 'utf8')).toBe('备份内容');
  });
});
