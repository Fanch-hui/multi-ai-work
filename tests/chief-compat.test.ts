import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import type { ChiefContextPart, ChiefInput, ChiefWorkContext } from '../src/domain/chief-work.js';
import type { Artifact, Conversation, Run } from '../src/domain/types.js';
import { artifactVersionKey, latestArtifactVersions } from '../src/domain/artifact-versions.js';
import { importAttachmentBytes } from '../src/core/attachments.js';
import { registerTaskArtifact } from '../src/core/artifact-registration.js';
import { setup } from './core-harness.js';

describe('统一管家的历史兼容', () => {
  it('首次设置沿用已有主对话和消息，欢迎语只保存一次', async () => {
    const { core, connection } = await setup(async () => ({ text: '完成' }));
    core.scheduler.pause();
    const homeId = core.state.settings().mainConversationId!;
    core.state.storage.appendMessage({
      id: 'before-onboarding',
      conversationId: homeId,
      authorType: 'user',
      content: '原有需求',
      artifactIds: [],
      status: 'committed',
      createdAt: new Date().toISOString(),
    });
    const input = {
      name: '小管家',
      connectionId: connection.id,
      model: 'test',
      workspaceId: core.state.snapshot().workspaces[0]!.id,
    };
    await core.request('onboarding.complete', { input });
    await core.request('onboarding.complete', { input });
    expect(core.state.settings().mainConversationId).toBe(homeId);
    expect(core.state.storage.messages(homeId).map((message) => message.id)).toEqual([
      'before-onboarding',
      `welcome:${homeId}`,
    ]);
  });

  it('固定主入口拒绝归档与删除并保留原记录', async () => {
    const { core } = await setup(async () => ({ text: '完成' }));
    const homeId = core.state.settings().mainConversationId!;
    await expect(core.conversations.archive(homeId, true)).rejects.toThrow('主入口需要保留');
    await expect(core.conversations.delete(homeId)).rejects.toThrow('主入口需要保留');
    expect(core.state.storage.get<Conversation>('conversations', homeId)?.archived).not.toBe(true);
    expect(core.state.settings().mainConversationId).toBe(homeId);
  });

  it('删除旧段清理消息映射和交接引用，保留后续段及成果正文', async () => {
    const { core } = await setup(async () => ({ text: '完成' }));
    core.scheduler.pause();
    const s = core.state.storage;
    const homeId = core.state.settings().mainConversationId!;
    const home = s.get<Conversation>('conversations', homeId)!;
    const old: Conversation = {
      ...home,
      id: 'old-chief-work',
      name: '报告旧段',
      chiefRole: 'history',
      chiefHomeId: homeId,
      chiefContextId: 'report-context',
    };
    const next: Conversation = { ...old, id: 'next-chief-work', chiefRole: 'work' };
    s.put('conversations', old);
    s.put('conversations', next);
    const message = s.appendMessage({
      id: 'old-report-message',
      conversationId: old.id,
      authorType: 'user',
      content: '报告采用中文',
      artifactIds: [],
      status: 'committed',
      createdAt: home.createdAt,
    });
    const context: ChiefWorkContext = {
      id: 'report-context',
      homeConversationId: homeId,
      title: '报告',
      currentPartId: 'next-part',
      legacyConversationId: old.id,
      createdAt: home.createdAt,
    };
    s.put('chief_contexts', context);
    const part: ChiefContextPart = {
      id: 'old-part',
      contextId: context.id,
      conversationId: old.id,
      sourceMessageIds: [],
      sourceArtifactIds: [],
      createdAt: home.createdAt,
    };
    s.put('chief_parts', part);
    s.put('chief_parts', {
      ...part,
      id: 'next-part',
      conversationId: next.id,
      previousPartId: part.id,
      sourceMessageIds: [message.id],
    });
    s.put('chief_timeline', {
      id: 'old-timeline-entry',
      homeConversationId: homeId,
      displaySequence: 1,
      messageId: message.id,
    });
    const attachment = await importAttachmentBytes(
      core.state,
      old.id,
      '原始资料.txt',
      'text/plain',
      Buffer.from('保留的正文').toString('base64'),
    );
    await core.conversations.delete(old.id);
    expect(s.get('chief_timeline', 'old-timeline-entry')).toBeUndefined();
    expect(s.get<ChiefContextPart>('chief_parts', 'next-part')).toMatchObject({
      sourceMessageIds: [],
    });
    expect(s.get<ChiefContextPart>('chief_parts', 'next-part')?.previousPartId).toBeUndefined();
    expect(s.get<ChiefWorkContext>('chief_contexts', context.id)?.currentPartId).toBe('next-part');
    expect(s.get<Artifact>('artifacts', attachment.id)?.path).toBe(attachment.path);
    expect(await readFile(attachment.path, 'utf8')).toBe('保留的正文');
  });

  it('新备份保存工作映射和待输入，恢复后要求重试未派发输入', async () => {
    const { core } = await setup(async () => ({ text: '完成' }));
    core.scheduler.pause();
    const homeId = core.state.settings().mainConversationId!;
    const input: ChiefInput = {
      id: 'input-pending',
      homeConversationId: homeId,
      messageId: 'future-message',
      requestId: 'pending-request',
      fingerprint: 'fingerprint',
      content: '继续报告',
      artifactIds: [],
      status: 'routing',
      taskIds: [],
      routingTaskId: 'old-routing-job',
      createdAt: new Date().toISOString(),
    };
    core.state.storage.put('chief_inputs', input);
    core.state.storage.put('chief_inputs', {
      ...input,
      id: 'input-delivered',
      requestId: 'delivered-request',
      status: 'dispatched',
      content: undefined,
    });
    const backup = (await core.request('backup.create')) as { path: string };
    const manifest = JSON.parse(await readFile(join(backup.path, 'manifest.json'), 'utf8'));
    expect(manifest.version).toBe(3);
    await core.request('backup.restore', { path: backup.path });
    expect(core.state.storage.get<ChiefInput>('chief_inputs', input.id)).toMatchObject({
      status: 'failed',
      content: '继续报告',
      taskIds: [],
    });
    expect(
      core.state.storage.get<ChiefInput>('chief_inputs', input.id)?.routingTaskId,
    ).toBeUndefined();
    expect(core.state.storage.get<ChiefInput>('chief_inputs', 'input-delivered')?.status).toBe(
      'dispatched',
    );
  });

  it('读取缺少工作上下文表的旧备份', async () => {
    const { core } = await setup(async () => ({ text: '完成' }));
    core.scheduler.pause();
    const homeId = core.state.settings().mainConversationId!;
    const backup = (await core.request('backup.create')) as { path: string };
    const databasePath = join(backup.path, 'team.sqlite');
    const database = new Database(databasePath);
    try {
      for (const table of ['chief_contexts', 'chief_parts', 'chief_inputs', 'chief_timeline'])
        database.exec(`DROP TABLE ${table}`);
      database.pragma('user_version = 1');
      database.prepare('DELETE FROM metadata WHERE key = ?').run('chief-work-v1');
    } finally {
      database.close();
    }
    const manifestPath = join(backup.path, 'manifest.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    manifest.version = 2;
    manifest.databaseSha256 = createHash('sha256')
      .update(await readFile(databasePath))
      .digest('hex');
    await writeFile(manifestPath, JSON.stringify(manifest));
    await expect(core.request('backup.restore', { path: backup.path })).resolves.toMatchObject({
      restored: true,
    });
    expect(core.state.settings().mainConversationId).toBe(homeId);
    expect(core.state.storage.get<Conversation>('conversations', homeId)).toBeDefined();
  });
});

describe('工作事项成果版本', () => {
  it('跨工作段接续同一版本链，并区分不同事项与显式系列', () => {
    const artifact = {
      id: 'first',
      conversationId: 'part-1',
      chiefContextId: 'report',
      botId: 'writer',
      workingPath: '/work/report.md',
      createdAt: '2026-10-24T10:00:00.000Z',
    } as Artifact;
    const revised = {
      ...artifact,
      id: 'revised',
      conversationId: 'part-2',
      createdAt: '2026-10-24T11:00:00.000Z',
    };
    const separate = { ...revised, id: 'separate', chiefContextId: 'other-report' };
    expect(artifactVersionKey(artifact)).toBe(artifactVersionKey(revised));
    expect(artifactVersionKey(separate)).not.toBe(artifactVersionKey(revised));
    expect(latestArtifactVersions([artifact, revised, separate]).map((item) => item.id)).toEqual([
      'revised',
      'separate',
    ]);
    expect(artifactVersionKey({ ...separate, seriesId: 'shared' })).toBe(
      artifactVersionKey({ ...artifact, seriesId: 'shared' }),
    );
  });

  it('登记任务群成果时沿显式来源保存工作事项归属', async () => {
    const { core, bot, root } = await setup(async () => ({ text: '完成' }));
    core.scheduler.pause();
    const member = bot('作者');
    const homeId = core.state.settings().mainConversationId!;
    const home = core.state.storage.get<Conversation>('conversations', homeId)!;
    const work = { ...home, id: 'work-source', chiefContextId: 'document-context' };
    core.state.storage.put('conversations', work);
    const group = core.entities.createConversation({
      name: '编写小组',
      kind: 'group',
      memberIds: [home.chiefId!, member.id],
      chiefId: home.chiefId,
      workspaceId: home.workspaceId,
    });
    core.state.storage.put('conversations', { ...group, sourceConversationId: work.id });
    const task = core.tasks.create({ conversationId: group.id, botId: member.id, goal: '写报告' });
    const file = join(root, 'report.txt');
    const bytes = Buffer.from('报告正文');
    await writeFile(file, bytes);
    const run: Run = {
      id: 'registration-run',
      taskId: task.id,
      botId: member.id,
      bindingId: 'registration-binding',
      configRevision: member.revision,
      status: 'completed',
      createdAt: new Date().toISOString(),
    };
    const artifact = registerTaskArtifact(
      core.state,
      {
        path: file,
        name: 'report.txt',
        mimeType: 'text/plain',
        size: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        purpose: 'deliverable',
        conversationId: group.id,
      },
      task,
      member,
      core.state.storage.get<Conversation>('conversations', group.id)!,
      run,
    );
    expect(artifact).toMatchObject({
      conversationId: group.id,
      chiefContextId: 'document-context',
      taskId: task.id,
      botId: member.id,
    });
    expect(await readFile(artifact.path, 'utf8')).toBe('报告正文');
  });
});
