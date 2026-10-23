import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Artifact, Run, Task } from '../src/domain/types.js';
import type { ArtifactReview } from '../src/domain/artifact-review.js';
import type { ToolExecutionContext } from '../src/domain/tools.js';
import { ArtifactReviewService } from '../src/core/artifact-reviews.js';
import { registerTaskArtifact } from '../src/core/artifact-registration.js';
import { latestArtifactVersions } from '../src/domain/artifact-versions.js';
import { id, now } from '../src/core/state.js';
import { setup } from './core-harness.js';

async function fixture() {
  const { core, root, bot } = await setup(async () => ({ text: '完成' }));
  core.scheduler.pause();
  const member = bot('编辑');
  const room = core.entities.createConversation({
    name: '文档修改',
    kind: 'private',
    memberIds: [member.id],
    workspaceId: core.state.snapshot().workspaces[0].id,
  });
  const task = core.tasks.create({ conversationId: room.id, botId: member.id, goal: '生成报告' });
  const artifact: Artifact = {
    id: id(),
    name: '报告.md',
    path: '/immutable/report.md',
    workingPath: '/workspace/report.md',
    mimeType: 'text/markdown',
    sha256: 'original-hash',
    size: 8,
    purpose: 'deliverable',
    conversationId: room.id,
    taskId: task.id,
    botId: member.id,
    createdAt: now(),
    requirementVersion: 1,
  };
  core.state.storage.put('artifacts', artifact);
  core.tasks.update(task, { artifactIds: [artifact.id] });
  const reviews = new ArtifactReviewService(core.state, core.tasks);
  const input = { conversationId: room.id, artifactIds: [artifact.id], requestId: 'user-1' };
  return { core, root, member, room, task, artifact, reviews, input };
}

describe('成果审阅与返工', () => {
  it('接受只绑定指定内容与原需求根，保留独立结论并支持删除后的历史查询', async () => {
    const { core, reviews, input, task, artifact } = await fixture();
    core.tasks.update(task, { status: 'completed' });
    const accepted = reviews.request('reviews.accept', input) as ArtifactReview;
    expect(accepted).toMatchObject({
      reviewer: 'user',
      outcome: 'accepted',
      targets: [
        {
          artifactId: artifact.id,
          sha256: artifact.sha256,
          name: artifact.name,
          requirementTaskId: task.id,
          requirementVersion: 1,
        },
      ],
    });
    expect(core.state.storage.all<Task>('tasks')).toHaveLength(1);
    expect(reviews.request('reviews.accept', input)).toEqual(accepted);
    expect(() => reviews.request('reviews.requestChanges', { ...input, feedback: '修改' })).toThrow(
      '请求 ID 与内容不匹配',
    );
    core.state.storage.delete('artifacts', artifact.id);
    expect(reviews.request('reviews.list', { ...input, artifactId: artifact.id })).toMatchObject([
      { id: accepted.id, targets: [{ deleted: true }] },
    ]);
    expect(() => reviews.request('reviews.accept', { ...input, requestId: 'new' })).toThrow(
      '已删除',
    );
  });

  it('活动任务追加意见并更新需求版本；重复提交保持单条消息', async () => {
    const { core, reviews, input, task } = await fixture();
    core.tasks.update(task, { status: 'waiting_children' });
    const review = reviews.request('reviews.requestChanges', {
      ...input,
      feedback: '补充数据来源',
    }) as ArtifactReview;
    expect(review.reworkTaskId).toBe(task.id);
    expect(core.state.storage.get<Task>('tasks', task.id)).toMatchObject({ status: 'queued' });
    const messages = core.state.storage.messages(input.conversationId);
    expect(messages).toHaveLength(1);
    expect(core.state.snapshot().taskInputs).toMatchObject([
      { taskId: task.id, requirementVersion: 2 },
    ]);
    reviews.request('reviews.requestChanges', { ...input, feedback: '补充数据来源' });
    expect(core.state.storage.messages(input.conversationId)).toEqual(messages);
  });

  it('已完成私聊交给原成员新建任务，同系列后续意见合并到活动返工', async () => {
    const { core, reviews, input, task, member } = await fixture();
    core.tasks.update(task, { status: 'completed' });
    const first = reviews.request('reviews.requestChanges', {
      ...input,
      feedback: '补充结论',
    }) as ArtifactReview;
    const second = reviews.request('reviews.requestChanges', {
      ...input,
      feedback: '补充摘要',
      requestId: 'user-2',
    }) as ArtifactReview;
    expect(second.reworkTaskId).toBe(first.reworkTaskId);
    expect(core.state.storage.all<Task>('tasks')).toHaveLength(2);
    expect(core.state.storage.get<Task>('tasks', first.reworkTaskId!)).toMatchObject({
      botId: member.id,
      reviewId: first.id,
      reworkOfTaskId: task.id,
      inputArtifactIds: input.artifactIds,
    });
    expect(core.state.storage.get<Task>('tasks', task.id)?.status).toBe('completed');
  });

  it('拒绝其他私聊成果与已归档对话，不留下消息或任务', async () => {
    const { core, reviews, input, room } = await fixture();
    expect(() => reviews.request('reviews.accept', { ...input, artifactIds: ['foreign'] })).toThrow(
      '授权范围',
    );
    core.state.storage.put('conversations', { ...room, archived: true });
    expect(() => reviews.request('reviews.requestChanges', { ...input, feedback: '修改' })).toThrow(
      '恢复对话',
    );
    expect(core.state.storage.all('artifact_reviews')).toEqual([]);
    expect(core.state.storage.messages(room.id)).toEqual([]);
  });

  it('AI 只登记当前任务输入的真实结论，用户接受保持独立', async () => {
    const { core, reviews, input, artifact, room, member } = await fixture();
    const task = core.tasks.create({ conversationId: room.id, botId: member.id, goal: '复核报告' });
    const context = {
      runId: 'review-run',
      callId: 'tool-1',
      task,
      botId: member.id,
      conversation: room,
      signal: new AbortController().signal,
      listArtifacts: () => [artifact],
    } as ToolExecutionContext;
    const args = { artifactIds: [artifact.id], outcome: 'passed', feedback: '数据来源完整' };
    expect(() => reviews.record(context, args)).toThrow('授权范围');
    core.tasks.update(task, { inputArtifactIds: [artifact.id] });
    const aiReview = reviews.record(context, args);
    expect(aiReview).toMatchObject({
      reviewer: 'bot',
      botId: member.id,
      taskId: task.id,
      outcome: 'passed',
    });
    core.state.storage.put('artifacts', artifact);
    reviews.request('reviews.accept', input);
    expect(reviews.request('reviews.list', { conversationId: room.id })).toMatchObject([
      { outcome: 'passed', reviewer: 'bot' },
      { outcome: 'accepted', reviewer: 'user' },
    ]);
  });

  it('返工失败时事务回滚审阅及用户消息', async () => {
    const { core, reviews, input, task, member } = await fixture();
    core.tasks.update(task, { status: 'completed' });
    core.state.storage.put('bots', { ...member, archived: true });
    expect(() => reviews.request('reviews.requestChanges', { ...input, feedback: '修改' })).toThrow(
      '有效成员',
    );
    expect(core.state.storage.all('artifact_reviews')).toEqual([]);
    expect(core.state.storage.messages(input.conversationId)).toEqual([]);
    expect(core.state.storage.all('tasks')).toHaveLength(1);
  });

  it('主对话仅可返工已明确回传的群成果，新任务继续交给主管', async () => {
    const { core, root, bot } = await setup(async () => ({ text: '完成' }));
    core.scheduler.pause();
    const chief = bot('Chief');
    const member = bot('研究员');
    const originalRoom = core.entities.createConversation({
      name: '项目',
      kind: 'private',
      memberIds: [chief.id],
      workspaceId: core.state.snapshot().workspaces[0].id,
    });
    const main = { ...originalRoom, purpose: 'chief' as const, chiefId: chief.id };
    core.state.storage.put('conversations', main);
    const original = core.tasks.create({
      conversationId: main.id,
      botId: chief.id,
      goal: '完成研究',
    });
    const originalGroup = core.entities.createConversation({
      name: '研究群',
      kind: 'group',
      memberIds: [chief.id, member.id],
      chiefId: chief.id,
      workspaceId: main.workspaceId,
    });
    const group = {
      ...originalGroup,
      purpose: 'task' as const,
      sourceTaskId: original.id,
      sourceConversationId: main.id,
    };
    core.state.storage.put('conversations', group);
    const child = {
      ...original,
      id: 'child',
      conversationId: group.id,
      botId: member.id,
      parentId: original.id,
      depth: 1,
      status: 'completed' as const,
    };
    core.state.storage.put('tasks', child);
    const artifact: Artifact = {
      id: 'returned',
      conversationId: group.id,
      taskId: child.id,
      botId: member.id,
      name: '研究.md',
      path: join(root, 'report.md'),
      mimeType: 'text/markdown',
      sha256: 'original',
      size: 1,
      purpose: 'deliverable',
      createdAt: now(),
      requirementVersion: 2,
    };
    core.state.storage.put('artifacts', artifact);
    core.state.storage.put('artifacts', { ...artifact, id: 'unreturned' });
    core.state.storage.setMetadata(`returned-artifacts:${original.id}`, [artifact.id]);
    core.tasks.update(original, { status: 'completed' });
    const reviews = new ArtifactReviewService(core.state, core.tasks);
    const input = {
      conversationId: main.id,
      artifactIds: [artifact.id],
      feedback: '补全引用',
      requestId: 'main-review',
    };
    expect(() =>
      reviews.request('reviews.requestChanges', { ...input, artifactIds: ['unreturned'] }),
    ).toThrow('授权范围');
    const review = reviews.request('reviews.requestChanges', input) as ArtifactReview;
    expect(review.targets).toMatchObject([
      { requirementTaskId: original.id, requirementVersion: 2 },
    ]);
    expect(core.state.storage.get<Task>('tasks', review.reworkTaskId!)).toMatchObject({
      conversationId: main.id,
      botId: chief.id,
      inputArtifactIds: [artifact.id],
      reworkOfTaskId: original.id,
    });
  });

  it('显式版本关联允许换路径与产出成员，原有组迁入同一系列', async () => {
    const { core, root, task, artifact, room, member } = await fixture();
    const older = { ...artifact, id: 'older-version', createdAt: '2020-01-01T00:00:00Z' };
    core.state.storage.put('artifacts', older);
    const bytes = Buffer.from('修改后的报告');
    const target = join(root, 'renamed.md');
    await writeFile(target, bytes);
    const input = {
      name: 'renamed.md',
      path: target,
      workingPath: target,
      mimeType: 'text/markdown',
      sha256: createHash('sha256').update(bytes).digest('hex'),
      size: bytes.length,
      conversationId: room.id,
      purpose: 'deliverable' as const,
      previousArtifactId: artifact.id,
    };
    const run = { id: 'run', taskId: task.id } as Run;
    expect(() => registerTaskArtifact(core.state, input, task, member, room, run)).toThrow(
      '本任务输入',
    );
    const rework = core.tasks.update(task, { inputArtifactIds: [artifact.id] });
    const replacement = registerTaskArtifact(
      core.state,
      input,
      rework,
      { ...member, id: 'new-producer' },
      room,
      run,
    );
    expect(replacement).toMatchObject({
      seriesId: artifact.id,
      previousArtifactId: artifact.id,
      botId: 'new-producer',
    });
    const all = core.state.storage.all<Artifact>('artifacts');
    expect(all.every((item) => item.seriesId === artifact.id)).toBe(true);
    expect(latestArtifactVersions(all)).toEqual([replacement]);
    expect(
      registerTaskArtifact(core.state, input, rework, { ...member, id: 'new-producer' }, room, run),
    ).toEqual(replacement);
  });
});
