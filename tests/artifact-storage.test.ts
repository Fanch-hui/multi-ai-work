import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rm, stat, writeFile, utimes } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Artifact, Bot, Conversation, Run, Task } from '../src/domain/types.js';
import type { ArtifactStorageUsage } from '../src/domain/artifact-storage.js';
import { isDeliverableArtifact } from '../src/domain/artifact-purpose.js';
import { importAttachment } from '../src/core/attachments.js';
import { registerTaskArtifact } from '../src/core/artifact-registration.js';
import { setup } from './core-harness.js';

describe('artifact content storage', () => {
  it('shares immutable bytes across isolated file records and releases the final reference', async () => {
    const { core, root } = await setup(async () => ({ text: '完成' }));
    const conversationId = core.state.settings().mainConversationId!;
    const source = join(root, 'original.txt');
    await writeFile(source, 'shared bytes');
    const first = await importAttachment(core.state, conversationId, source);
    const second = await importAttachment(core.state, conversationId, source);
    expect(first.id).not.toBe(second.id);
    expect(first.objectHash).toBe(second.objectHash);
    expect(core.state.artifactObjects.sharesObject(first)).toBe(true);
    expect(core.state.artifactObjects.sharesObject(second)).toBe(true);
    const usage = (await core.request('artifacts.storage')) as ArtifactStorageUsage;
    expect(usage.fileBytes).toBe(12);
    expect(usage.logicalFileBytes).toBe(24);
    await core.request('artifacts.delete', { id: first.id });
    expect(await readFile(second.path, 'utf8')).toBe('shared bytes');
    expect((await stat(second.path)).mode & 0o222).toBe(0);
    await core.request('artifacts.delete', { id: second.id });
    await expect(stat(join(root, 'artifact-objects', first.objectHash!))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect(await readFile(source, 'utf8')).toBe('shared bytes');
  });

  it('reuses repeated registration, versions changed content, and checks the registered bytes', async () => {
    const { core, root } = await setup(async () => ({ text: '完成' }));
    const room = core.state.storage.get<Conversation>(
      'conversations',
      core.state.settings().mainConversationId!,
    )!;
    const bot = core.state.storage.get<Bot>('bots', core.state.settings().mainBotId!)!;
    const time = new Date().toISOString();
    const task: Task = {
      id: 'files-task',
      conversationId: room.id,
      botId: bot.id,
      dependencyIds: [],
      goal: '交付',
      expectedOutput: '',
      status: 'completed',
      runIds: ['files-run'],
      artifactIds: [],
      requestId: 'files-task',
      depth: 0,
      createdAt: time,
      updatedAt: time,
    };
    const run: Run = {
      id: 'files-run',
      taskId: task.id,
      botId: bot.id,
      bindingId: 'binding',
      status: 'completed',
      configRevision: 1,
      createdAt: time,
    };
    core.state.storage.put('tasks', task);
    core.state.storage.put('runs', run);
    const path = join(root, 'report.txt');
    const register = async (content: string) => {
      await writeFile(path, content);
      return registerTaskArtifact(
        core.state,
        {
          name: 'report.txt',
          path,
          conversationId: room.id,
          mimeType: 'text/plain',
          size: Buffer.byteLength(content),
          sha256: createHash('sha256').update(content).digest('hex'),
          purpose: 'deliverable',
        },
        task,
        bot,
        room,
        run,
      );
    };
    const first = await register('first');
    expect((await register('first')).id).toBe(first.id);
    const second = await register('second');
    expect(second.id).not.toBe(first.id);
    expect(await readFile(first.path, 'utf8')).toBe('first');
    expect(core.state.storage.get<Task>('tasks', task.id)!.artifactIds).toEqual([
      first.id,
      second.id,
    ]);
    expect(() =>
      registerTaskArtifact(
        core.state,
        {
          ...second,
          path,
          sha256: first.sha256,
        },
        task,
        bot,
        room,
        run,
      ),
    ).toThrow('文件内容已变化');
  });

  it('counts both object and alias bytes when the filesystem uses an independent copy', async () => {
    const { core, root } = await setup(async () => ({ text: '完成' }));
    const source = join(root, 'copied.txt');
    await writeFile(source, 'copied bytes');
    const artifact = await importAttachment(
      core.state,
      core.state.settings().mainConversationId!,
      source,
    );
    await rm(artifact.path);
    await writeFile(artifact.path, 'copied bytes');
    expect(core.state.artifactObjects.sharesObject(artifact)).toBe(false);
    const usage = await core.files.usage();
    expect(usage.fileBytes).toBe(24);
    expect(usage.logicalFileBytes).toBe(12);
  });

  it('migrates existing copies without changing IDs or message references', async () => {
    const { core, root } = await setup(async () => ({ text: '完成' }));
    const conversationId = core.state.settings().mainConversationId!;
    for (const id of ['legacy-one', 'legacy-two']) {
      const path = join(root, 'artifacts', id, 'same.txt');
      await mkdir(join(root, 'artifacts', id), { recursive: true });
      await writeFile(path, 'legacy');
      core.state.storage.put('artifacts', {
        id,
        path,
        name: 'same.txt',
        mimeType: 'text/plain',
        conversationId,
        size: 6,
        sha256: createHash('sha256').update('legacy').digest('hex'),
        createdAt: '',
      } satisfies Artifact);
    }
    core.state.storage.appendMessage({
      id: 'saved-message',
      conversationId,
      authorType: 'user',
      content: '',
      artifactIds: ['legacy-one'],
      status: 'committed',
      createdAt: '',
    });
    await core.files.maintain();
    const first = core.state.storage.get<Artifact>('artifacts', 'legacy-one')!;
    const second = core.state.storage.get<Artifact>('artifacts', 'legacy-two')!;
    expect(first.objectHash).toBe(second.objectHash);
    expect(core.state.artifactObjects.sharesObject(first)).toBe(true);
    expect(core.state.storage.getMessage('saved-message')!.artifactIds).toEqual(['legacy-one']);
    expect((await readdir(join(root, 'artifact-objects'))).length).toBe(1);
  });

  it('keeps internal tool images out of deliverables while preserving explicit image delivery', () => {
    const image = { source: 'mcp-image', name: 'image.png' } as Artifact;
    expect(isDeliverableArtifact(image)).toBe(false);
    expect(isDeliverableArtifact({ ...image, purpose: 'deliverable' })).toBe(true);
  });

  it('keeps policy and standalone backup contents readable after shared-file deletion', async () => {
    const { core, root } = await setup(async () => ({ text: '完成' }));
    const source = join(root, 'backup.txt');
    await writeFile(source, 'backup bytes');
    const artifact = await importAttachment(
      core.state,
      core.state.settings().mainConversationId!,
      source,
    );
    const policy = { cacheMiB: 64, cacheIdleDays: 2 };
    expect(
      (
        (await core.request('artifacts.configureStorage', {
          input: policy,
        })) as ArtifactStorageUsage
      ).policy,
    ).toEqual(policy);
    const backup = (await core.request('backup.create')) as { path: string };
    await core.request('artifacts.delete', { id: artifact.id });
    await core.request('backup.restore', { path: backup.path });
    const restored = core.state.storage.get<Artifact>('artifacts', artifact.id)!;
    expect(restored.objectHash).toBeUndefined();
    expect(await readFile(restored.path, 'utf8')).toBe('backup bytes');
    expect(await readFile(join(backup.path, 'artifacts', artifact.id), 'utf8')).toBe(
      'backup bytes',
    );
    await core.files.maintain();
    const migrated = core.state.storage.get<Artifact>('artifacts', artifact.id)!;
    expect(core.state.artifactObjects.sharesObject(migrated)).toBe(true);
    expect(await readFile(migrated.path, 'utf8')).toBe('backup bytes');
    await expect(stat(restored.path)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(core.files.policy()).toEqual(policy);
  });

  it('cleans only expired unreferenced uploads and owned orphan files, preserving drafts and sent input', async () => {
    const { core, root } = await setup(async () => ({ text: '完成' }));
    const conversationId = core.state.settings().mainConversationId!;
    const source = join(root, 'input.txt');
    await writeFile(source, 'input');
    const held = await importAttachment(core.state, conversationId, source);
    const sent = await importAttachment(core.state, conversationId, source);
    const abandoned = await importAttachment(core.state, conversationId, source);
    for (const artifact of [held, sent, abandoned])
      core.state.storage.setMetadata(`artifact-draft:${artifact.id}`, {
        conversationId,
        touchedAt: Date.now() - 25 * 60 * 60 * 1000,
      });
    core.state.storage.appendMessage({
      id: 'input-message',
      conversationId,
      authorType: 'user',
      content: '',
      artifactIds: [sent.id],
      status: 'committed',
      createdAt: '',
    });
    await core.request('artifacts.retainDrafts', {
      drafts: [{ conversationId, artifactIds: [held.id] }],
    });
    const orphanHash = 'a'.repeat(64);
    const orphan = join(root, 'artifact-objects', orphanHash);
    await writeFile(orphan, 'orphan');
    const temporary = join(
      root,
      'artifact-objects',
      `${orphanHash}.00000000-0000-4000-8000-000000000000.tmp`,
    );
    await writeFile(temporary, 'partial');
    const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    await utimes(orphan, old, old);
    await utimes(temporary, old, old);
    await core.files.maintain();
    expect(core.state.storage.get('artifacts', abandoned.id)).toBeUndefined();
    expect(await readFile(held.path, 'utf8')).toBe('input');
    expect(await readFile(sent.path, 'utf8')).toBe('input');
    await expect(stat(orphan)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(stat(temporary)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(source, 'utf8')).toBe('input');
  });
});
