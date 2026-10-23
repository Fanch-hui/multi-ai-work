import { describe, expect, it } from 'vitest';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Artifact, Task } from '../src/domain/types.js';
import type { ArtifactReview } from '../src/domain/artifact-review.js';
import type { ToolExecutionContext } from '../src/domain/tools.js';
import { ArtifactReviewService } from '../src/core/artifact-reviews.js';
import { artifactSeries } from '../src/core/artifact-review-series.js';
import { accessibleArtifacts } from '../src/core/tool-access.js';
import { id, now } from '../src/core/state.js';
import { setup } from './core-harness.js';

async function fixture() {
  const { core, root, bot } = await setup(async () => ({ text: '完成' }));
  core.scheduler.pause();
  const member = bot('原作者');
  const chief = bot('Chief');
  const workspaceId = core.state.snapshot().workspaces[0].id;
  const originalRoom = core.entities.createConversation({
    name: '原工作',
    kind: 'private',
    memberIds: [member.id],
    workspaceId,
  });
  const task = core.tasks.create({
    conversationId: originalRoom.id,
    botId: member.id,
    goal: '写报告',
  });
  const artifactId = id();
  const bytes = Buffer.from('原始报告');
  const artifact: Artifact = {
    id: artifactId,
    name: '报告.md',
    mimeType: 'text/markdown',
    purpose: 'deliverable',
    ...core.state.artifactObjects.publish(artifactId, '报告.md', bytes),
    conversationId: originalRoom.id,
    taskId: task.id,
    botId: member.id,
    createdAt: now(),
    requirementVersion: 3,
  };
  core.state.storage.put('artifacts', artifact);
  core.tasks.update(task, { status: 'completed', artifactIds: [artifact.id] });
  const memberRoom = core.entities.createConversation({
    name: '继续修改',
    kind: 'private',
    memberIds: [member.id],
    workspaceId,
  });
  const baseChiefRoom = core.entities.createConversation({
    name: '管家接收',
    kind: 'private',
    memberIds: [chief.id],
    workspaceId,
  });
  const chiefRoom = { ...baseChiefRoom, purpose: 'chief' as const, chiefId: chief.id };
  core.state.storage.put('conversations', chiefRoom);
  const reviews = new ArtifactReviewService(core.state, core.tasks);
  const input = {
    conversationId: memberRoom.id,
    artifactIds: [artifact.id],
    requestId: 'transfer-review',
    transfer: true,
  };
  return {
    core,
    root,
    bot,
    member,
    chief,
    originalRoom,
    task,
    artifact,
    bytes,
    memberRoom,
    chiefRoom,
    reviews,
    input,
  };
}

describe('删除来源会话后的成果处理', () => {
  it('仅用户显式转入已删除来源的成果，副本和原始审阅目标独立保留', async () => {
    const { core, artifact, originalRoom, bytes, memberRoom, reviews, input } = await fixture();
    expect(() => reviews.request('reviews.accept', input)).toThrow('仅来源对话已删除');
    await core.conversations.delete(originalRoom.id);
    expect(() => reviews.request('reviews.accept', { ...input, transfer: false })).toThrow(
      '授权范围',
    );
    const review = reviews.request('reviews.accept', input) as ArtifactReview;
    expect(review).toMatchObject({
      sourceTaskId: artifact.taskId,
      targets: [
        {
          artifactId: artifact.id,
          sha256: artifact.sha256,
          requirementTaskId: artifact.taskId,
          requirementVersion: 3,
        },
      ],
    });
    const copy = core.state.storage.byField<Artifact>(
      'artifacts',
      'conversationId',
      memberRoom.id,
    )[0];
    expect(copy).toMatchObject({
      botId: artifact.botId,
      taskId: artifact.taskId,
      sha256: artifact.sha256,
      objectHash: artifact.objectHash,
    });
    expect(copy.id).not.toBe(artifact.id);
    expect(copy.path).not.toBe(artifact.path);
    expect(await readFile(copy.path)).toEqual(bytes);
    expect(reviews.request('reviews.accept', input)).toEqual(review);
    expect(() => reviews.request('reviews.accept', { ...input, transfer: false })).toThrow(
      '请求 ID 与内容不匹配',
    );
    expect(core.state.storage.byField('artifacts', 'conversationId', memberRoom.id)).toHaveLength(
      1,
    );
    await core.request('artifacts.delete', { id: artifact.id });
    expect(await readFile(copy.path)).toEqual(bytes);
    expect(reviews.request('reviews.list', { conversationId: memberRoom.id })).toMatchObject([
      { targets: [{ artifactId: artifact.id, deleted: true }] },
    ]);
    expect(core.state.storage.all('tasks')).toEqual([]);
    const aliasInput = {
      ...input,
      artifactIds: [copy.id],
      transfer: false,
      requestId: 'accept-retained-copy',
    };
    const aliasReview = reviews.request('reviews.accept', aliasInput) as ArtifactReview;
    expect(aliasReview.targets[0]).toMatchObject({
      artifactId: artifact.id,
      sha256: artifact.sha256,
    });
    expect(reviews.request('reviews.accept', aliasInput)).toEqual(aliasReview);
    expect(
      reviews.request('reviews.list', { conversationId: memberRoom.id, artifactId: copy.id }),
    ).toHaveLength(2);
    expect(
      reviews.request('reviews.list', { conversationId: memberRoom.id, artifactId: copy.id }),
    ).toMatchObject([{ reviewInputArtifactIds: [copy.id] }, { reviewInputArtifactIds: [copy.id] }]);
  });

  it('原任务已删除时在接收管家对话创建普通根任务，并提供实时返工状态', async () => {
    const { core, originalRoom, artifact, chiefRoom, chief, task, reviews, input } =
      await fixture();
    await core.conversations.delete(originalRoom.id);
    const review = reviews.request('reviews.requestChanges', {
      ...input,
      conversationId: chiefRoom.id,
      feedback: '增加结论',
    }) as ArtifactReview;
    const rework = core.state.storage.get<Task>('tasks', review.reworkTaskId!)!;
    expect(rework).toMatchObject({
      conversationId: chiefRoom.id,
      botId: chief.id,
      reviewId: review.id,
      reworkOfTaskId: task.id,
      depth: 0,
    });
    expect(rework.parentId).toBeUndefined();
    expect(rework.inputArtifactIds).not.toContain(artifact.id);
    const inputArtifactId = rework.inputArtifactIds![0];
    expect(
      accessibleArtifacts(core.state, chiefRoom, chief.id, rework).map((item) => item.id),
    ).toEqual([inputArtifactId]);
    expect(artifactSeries(core.state, rework, inputArtifactId).seriesId).toBe(artifact.id);
    expect(reviews.request('reviews.list', { conversationId: chiefRoom.id })).toMatchObject([
      { reworkTask: { id: rework.id, status: 'queued', conversationId: chiefRoom.id } },
    ]);
    const next = reviews.request('reviews.requestChanges', {
      ...input,
      conversationId: chiefRoom.id,
      feedback: '补充摘要',
      requestId: 'transfer-second',
    }) as ArtifactReview;
    expect(next.reworkTaskId).toBe(rework.id);
    expect(core.state.storage.all('artifacts')).toHaveLength(2);
    expect(core.state.storage.get<Task>('tasks', rework.id)?.inputArtifactIds).toEqual([
      inputArtifactId,
    ]);
    core.tasks.update(rework, { status: 'completed' });
    expect(reviews.request('reviews.list', { conversationId: chiefRoom.id })).toMatchObject([
      { reworkTask: { status: 'completed' } },
      { reworkTask: { status: 'completed' } },
    ]);
  });

  it('有效私聊保持隔离，转入目标仅限主管或原产出成员', async () => {
    const { core, bot, originalRoom, memberRoom, reviews, input } = await fixture();
    const other = bot('其他成员');
    const room = core.entities.createConversation({
      name: '其他私聊',
      kind: 'private',
      memberIds: [other.id],
      workspaceId: memberRoom.workspaceId,
    });
    await core.conversations.delete(originalRoom.id);
    expect(() =>
      reviews.request('reviews.requestChanges', {
        ...input,
        conversationId: room.id,
        feedback: '修改',
      }),
    ).toThrow('有效成员');
    core.state.storage.put('conversations', { ...memberRoom, archived: true });
    expect(() => reviews.request('reviews.accept', input)).toThrow('恢复对话');
    expect(core.state.storage.all('artifact_reviews')).toEqual([]);
    expect(core.state.storage.byField('artifacts', 'conversationId', room.id)).toEqual([]);
    expect(() => reviews.record({} as ToolExecutionContext, { transfer: true })).toThrow(
      'AI 审阅不能转移',
    );
  });

  it('创建返工失败时撤销副本记录和文件，保留原始成果', async () => {
    const { core, root, originalRoom, member, memberRoom, artifact, reviews, input, bytes } =
      await fixture();
    await core.conversations.delete(originalRoom.id);
    core.state.storage.put('bots', { ...member, connectionId: 'deleted-connection' });
    expect(() => reviews.request('reviews.requestChanges', { ...input, feedback: '修改' })).toThrow(
      '模型连接',
    );
    expect(core.state.storage.all('artifact_reviews')).toEqual([]);
    expect(core.state.storage.byField('artifacts', 'conversationId', memberRoom.id)).toEqual([]);
    expect(core.state.storage.messages(memberRoom.id)).toEqual([]);
    expect(await readdir(join(root, 'artifacts'))).toEqual([artifact.id]);
    expect(await readFile(artifact.path)).toEqual(bytes);
    expect(core.state.storage.get<Artifact>('artifacts', artifact.id)?.seriesId).toBeUndefined();
  });
});
