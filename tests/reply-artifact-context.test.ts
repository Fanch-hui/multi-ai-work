import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ModelMessage } from '../src/domain/provider.js';
import type { Artifact, ContextCheckpoint, Run, Task } from '../src/domain/types.js';
import type { ProviderArchive } from '../src/core/managed-history.js';
import { migrateReplyArtifacts } from '../src/core/reply-artifacts.js';
import { contextSourceHash } from '../src/runtime/context.js';
import { eventually, setup } from './core-harness.js';

const summary = '较早项目约定：输出中文报告，保留交付文件';
const oldHistory = 'EARLIER_PROJECT_NOTES';
const v1 = 'reply-artifact-delivery-v1';
const v2 = 'reply-artifact-context-v2';
type Checkpoint = ContextCheckpoint & { sourceHash: string };
interface Validity {
  generation: number;
  signature: string;
  sourceIds: string[];
  sourceHash: string;
}

async function compactedConversation() {
  const seen: ModelMessage[][] = [];
  let summaries = 0;
  const { core, root, bot } = await setup(async (context) => {
    if (context.runId.includes(':summary:')) {
      summaries++;
      return { text: summary };
    }
    seen.push(context.messages);
    return {
      text: '整理完成',
      messages: [
        ...context.messages,
        { role: 'user', content: context.prompt },
        { role: 'assistant', content: '整理完成' },
      ] as ModelMessage[],
    };
  });
  const member = core.entities.saveBot({
    ...bot('助手'),
    contextWindow: 40000,
    memoryMode: 'off',
  });
  const room = core.entities.createConversation({
    name: '项目讨论',
    kind: 'private',
    memberIds: [member.id],
    workspaceId: core.state.snapshot().workspaces[0].id,
  });
  const storage = core.state.storage;
  const turn = async (content: string) => {
    const taskId = core.tasks.send({ conversationId: room.id, content }).taskIds[0];
    await eventually(() => storage.get<Task>('tasks', taskId)?.status === 'completed');
  };
  await turn(`${oldHistory} `.repeat(500));
  await turn('近期原文要求：交付完整报告');
  const task = (await core.request('conversations.compact', { id: room.id })) as Task;
  await eventually(() =>
    ['completed', 'failed'].includes(storage.get<Task>('tasks', task.id)?.status ?? ''),
  );
  expect(storage.get<Task>('tasks', task.id)).toMatchObject({
    status: 'completed',
    contextCompactionOutcome: 'compressed',
  });
  const checkpoint = storage.all<Checkpoint>('context_checkpoints').at(-1)!;
  const validityKey = `history-validity:${checkpoint.bindingId}`;
  const reply = storage
    .messages(room.id)
    .find(
      (message) => message.authorType === 'bot' && checkpoint.sourceMessageIds.includes(message.id),
    )!;
  const run = storage.get<Run>('runs', reply.runId!)!;
  const sourceTask = storage.get<Task>('tasks', run.taskId)!;
  const path = join(root, 'process-output.txt');
  const processText = '工具完整输出，供内部读取';
  await writeFile(path, processText);
  const artifact: Artifact = {
    id: 'process-output',
    name: 'process-output.txt',
    path,
    mimeType: 'text/plain',
    sha256: createHash('sha256').update(processText).digest('hex'),
    size: Buffer.byteLength(processText),
    taskId: sourceTask.id,
    botId: member.id,
    conversationId: room.id,
    purpose: 'intermediate',
    createdAt: sourceTask.createdAt,
  };
  storage.put('artifacts', artifact);
  storage.put('tasks', { ...sourceTask, artifactIds: [artifact.id] });
  storage.updateMessage({ ...reply, artifactIds: [artifact.id] });
  const messages = storage.messages(room.id);
  const legacyCheckpoint = {
    ...checkpoint,
    sourceHash: contextSourceHash(
      messages.filter((message) => checkpoint.sourceMessageIds.includes(message.id)),
    ),
  };
  storage.put('context_checkpoints', legacyCheckpoint);
  const validity = storage.metadata<Validity>(validityKey)!;
  storage.setMetadata(validityKey, {
    ...validity,
    sourceHash: contextSourceHash(
      messages.filter((message) => validity.sourceIds.includes(message.id)),
    ),
  });
  storage.prepare('DELETE FROM metadata WHERE key IN (?, ?)').run(v1, v2);
  const applyV1 = () => {
    storage.updateMessage({ ...reply, artifactIds: [] });
    storage.setMetadata(v1, true);
  };
  return {
    storage,
    room,
    checkpoint: legacyCheckpoint,
    reply,
    artifact,
    processText,
    validityKey,
    turn,
    applyV1,
    seen,
    summaries: () => summaries,
  };
}

describe('交付附件迁移保留已压缩上下文', () => {
  it('首次整理过程附件后连续两轮沿用摘要，保留聊天正文、成果文件和原始协议档案', async () => {
    const fixture = await compactedConversation();
    const { storage, room, checkpoint, reply, artifact, turn, seen } = fixture;
    const messages = storage.messages(room.id);
    const archives = storage.all<ProviderArchive>('provider_archive');
    migrateReplyArtifacts(storage);
    expect(storage.getMessage(reply.id)?.artifactIds).toEqual([]);
    expect(storage.messages(room.id).map((message) => message.content)).toEqual(
      messages.map((message) => message.content),
    );
    expect(storage.get('artifacts', artifact.id)).toEqual(artifact);
    expect(await readFile(artifact.path, 'utf8')).toBe(fixture.processText);
    expect(storage.all('provider_archive')).toEqual(archives);
    for (const content of ['继续写正文', '再核对结论']) {
      await turn(content);
      expect(JSON.stringify(seen.at(-1))).toContain(summary);
      expect(JSON.stringify(seen.at(-1))).not.toContain(oldHistory);
      expect(JSON.stringify(seen.at(-1))).toContain('近期原文要求');
    }
    expect(fixture.summaries()).toBe(1);
    expect(storage.all('context_checkpoints')).toHaveLength(1);
    expect(storage.get<Checkpoint>('context_checkpoints', checkpoint.id)?.content).toBe(summary);
    expect(storage.all('provider_archive').slice(0, archives.length)).toEqual(archives);
    expect(storage.messages(room.id).slice(0, messages.length)).toEqual(
      messages.map((message) =>
        message.id === reply.id ? { ...message, artifactIds: [] } : message,
      ),
    );
  });

  it('已按完整档案重建的会话恢复原摘要，并保留迁移后的新对话', async () => {
    const fixture = await compactedConversation();
    const { storage, turn, seen, validityKey, checkpoint } = fixture;
    fixture.applyV1();
    await turn('迁移之后补充的新要求');
    expect(JSON.stringify(seen.at(-1))).toContain(oldHistory);
    expect(JSON.stringify(seen.at(-1))).not.toContain(summary);
    expect(storage.metadata(validityKey)).toBeDefined();
    const archives = storage.all('provider_archive');
    migrateReplyArtifacts(storage);
    expect(storage.metadata(validityKey)).toBeUndefined();
    expect(storage.all('provider_archive')).toEqual(archives);
    await turn('修复后继续');
    expect(JSON.stringify(seen.at(-1))).toContain(summary);
    expect(JSON.stringify(seen.at(-1))).not.toContain(oldHistory);
    expect(JSON.stringify(seen.at(-1))).toContain('迁移之后补充的新要求');
    expect(fixture.summaries()).toBe(1);
    expect(storage.get<Checkpoint>('context_checkpoints', checkpoint.id)?.content).toBe(summary);
  });

  it.each(['修改正文', '缺失来源'] as const)('%s时保留旧检查点的校验失败', async (change) => {
    const { storage, checkpoint, reply, applyV1 } = await compactedConversation();
    applyV1();
    if (change === '修改正文') {
      storage.updateMessage({ ...reply, artifactIds: [], content: '历史内容已实际修改' });
    } else {
      const sourceId = checkpoint.sourceMessageIds.find((id) => id !== reply.id)!;
      storage.deleteMessage(sourceId);
    }
    migrateReplyArtifacts(storage);
    expect(storage.get('context_checkpoints', checkpoint.id)).toEqual(checkpoint);
  });

  it('检查点保存失败时原子回滚附件、校验记录和迁移标记', async () => {
    const { storage, room, checkpoint, validityKey } = await compactedConversation();
    const messages = storage.messages(room.id);
    const validity = storage.metadata(validityKey);
    storage
      .prepare(`CREATE TRIGGER fail_context_rebase BEFORE UPDATE ON context_checkpoints
      BEGIN SELECT RAISE(ABORT, 'checkpoint write failed'); END`)
      .run();
    expect(() => migrateReplyArtifacts(storage)).toThrow('checkpoint write failed');
    expect(storage.messages(room.id)).toEqual(messages);
    expect(storage.get('context_checkpoints', checkpoint.id)).toEqual(checkpoint);
    expect(storage.metadata(validityKey)).toEqual(validity);
    expect(storage.metadata(v1)).toBeUndefined();
    expect(storage.metadata(v2)).toBeUndefined();
  });
});
