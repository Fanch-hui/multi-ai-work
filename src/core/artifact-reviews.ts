import { z } from 'zod';
import type { Artifact, Conversation, Task } from '../domain/types.js';
import type { ArtifactReview, ReviewTarget } from '../domain/artifact-review.js';
import type { ToolExecutionContext } from '../domain/tools.js';
import { artifactVersionKey } from '../domain/artifact-versions.js';
import { terminal } from '../domain/task-status.js';
import { id, now, type State } from './state.js';
import type { TaskService } from './tasks.js';
import { required } from './errors.js';
import {
  retainedReviewArtifacts,
  transferReviewBot,
  transferReviewInputs,
  removeTransferredFiles,
} from './artifact-review-transfer.js';
import {
  requireReviewArtifacts,
  reviewArtifacts,
  reviewSource,
  reviewTargets,
  reviewHistory,
} from './artifact-review-targets.js';

const artifactIds = z
  .array(z.string().min(1))
  .min(1)
  .max(10)
  .transform((ids) => [...new Set(ids)]);
const userInput = z.object({
  conversationId: z.string().min(1),
  artifactIds,
  feedback: z.string().trim().max(20000).default(''),
  requestId: z.string().min(1).max(500),
  transfer: z.boolean().default(false),
});
const botInput = z.object({
  artifactIds,
  outcome: z.enum(['passed', 'changes_requested']),
  feedback: z.string().trim().min(1).max(20000),
  requestId: z.string().min(1).max(500).optional(),
});

export class ArtifactReviewService {
  constructor(
    private state: State,
    private tasks: TaskService,
  ) {}

  request(method: string, params: Record<string, unknown>): unknown {
    if (method === 'reviews.list') return this.list(params);
    if (method !== 'reviews.accept' && method !== 'reviews.requestChanges')
      throw new Error('不支持的成果审阅操作');
    const input = userInput.parse(params);
    const outcome = method === 'reviews.accept' ? 'accepted' : 'changes_requested';
    if (outcome === 'changes_requested' && !input.feedback) throw new Error('请填写修改意见');
    const s = this.state.storage;
    const room = required(s.get<Conversation>('conversations', input.conversationId), '对话不存在');
    const saved = this.existing(input.requestId, input.conversationId, 'user', outcome, input);
    if (saved) return saved;
    const artifacts = input.transfer
      ? retainedReviewArtifacts(this.state, input.artifactIds)
      : requireReviewArtifacts(reviewArtifacts(this.state, room), input.artifactIds);
    const source = reviewSource(this.state, artifacts, input.transfer);
    const transferBotId =
      input.transfer || artifacts.every((artifact) => artifact.source === 'review-transfer')
        ? transferReviewBot(this.state, room, artifacts, source)
        : undefined;
    if (room.archived || !this.tasks.accepting(room.id)) throw new Error('请先恢复对话后再审阅');
    const review: ArtifactReview = {
      id: id(),
      requestId: input.requestId,
      conversationId: room.id,
      sourceTaskId: source?.id ?? artifacts[0].taskId,
      targets: reviewTargets(this.state, artifacts),
      reviewer: 'user',
      outcome,
      feedback: input.feedback,
      createdAt: now(),
    };
    let transferred: Artifact[] = [];
    let createdCopies: Artifact[] = [];
    try {
      s.transaction(() => {
        if (input.transfer) {
          const result = transferReviewInputs(this.state, room, artifacts);
          transferred = result.inputs;
          createdCopies = result.created;
          s.setMetadata(
            `review-transfer:${review.id}`,
            transferred.map((artifact) => artifact.id),
          );
        }
        if (outcome === 'changes_requested')
          review.reworkTaskId = this.rework(
            room,
            source,
            input.transfer ? transferred : artifacts,
            review,
            transferBotId,
          );
        s.put('artifact_reviews', review);
      });
    } catch (error) {
      removeTransferredFiles(this.state, createdCopies);
      throw error;
    }
    this.state.changed();
    return review;
  }

  record(context: ToolExecutionContext, args: Record<string, unknown>) {
    if (args.transfer !== undefined) throw new Error('AI 审阅不能转移成果授权');
    context.assertAuthorized?.();
    context.signal.throwIfAborted();
    const input = botInput.parse(args);
    const requestId = input.requestId ?? `${context.runId}:${context.callId ?? 'review'}`;
    const saved = this.existing(
      requestId,
      context.conversation.id,
      'bot',
      input.outcome,
      input,
      context.botId,
      context.task.id,
    );
    if (saved) return saved;
    const task = required(this.state.storage.get<Task>('tasks', context.task.id), '任务不存在');
    if (
      task.botId !== context.botId ||
      task.conversationId !== context.conversation.id ||
      terminal(task.status)
    )
      throw new Error('审阅任务已结束或不在当前会话');
    const visible = context
      .listArtifacts()
      .filter(
        (artifact) =>
          task.inputArtifactIds?.includes(artifact.id) || artifact.taskId === context.task.id,
      );
    const artifacts = requireReviewArtifacts(visible, input.artifactIds);
    const review: ArtifactReview = {
      id: id(),
      requestId,
      conversationId: context.conversation.id,
      sourceTaskId: reviewTargets(this.state, artifacts)[0]?.requirementTaskId,
      targets: reviewTargets(this.state, artifacts),
      reviewer: 'bot',
      botId: context.botId,
      taskId: context.task.id,
      outcome: input.outcome,
      feedback: input.feedback,
      createdAt: now(),
    };
    this.state.storage.put('artifact_reviews', review);
    this.state.changed();
    return review;
  }

  private list(params: Record<string, unknown>) {
    const input = z
      .object({
        conversationId: z.string().min(1),
        artifactId: z.string().optional(),
        taskId: z.string().optional(),
      })
      .parse(params);
    const s = this.state.storage;
    const room = required(s.get<Conversation>('conversations', input.conversationId), '对话不存在');
    const visible = reviewArtifacts(this.state, room);
    const allowed = new Set([
      ...visible.map((artifact) => artifact.id),
      ...reviewTargets(this.state, visible).map((target) => target.artifactId),
    ]);
    const artifactId =
      input.artifactId &&
      (s.metadata<ReviewTarget>(`review-transfer-target:${input.artifactId}`)?.artifactId ??
        input.artifactId);
    const reviews = s.all<ArtifactReview>('artifact_reviews').filter((review) => {
      if (artifactId && !review.targets.some((target) => target.artifactId === artifactId))
        return false;
      if (
        input.taskId &&
        ![review.taskId, review.sourceTaskId, review.reworkTaskId].includes(input.taskId)
      )
        return false;
      return (
        review.conversationId === room.id ||
        review.targets.every((target) => allowed.has(target.artifactId))
      );
    });
    return reviews
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map((review) => reviewHistory(this.state, review, room.id));
  }

  private existing(
    requestId: string,
    conversationId: string,
    reviewer: ArtifactReview['reviewer'],
    outcome: ArtifactReview['outcome'],
    input: { artifactIds: string[]; feedback: string; transfer?: boolean },
    botId?: string,
    taskId?: string,
  ) {
    const saved = this.state.storage.firstByField<ArtifactReview>(
      'artifact_reviews',
      'requestId',
      requestId,
    );
    if (!saved) return undefined;
    if (
      saved.conversationId !== conversationId ||
      saved.reviewer !== reviewer ||
      saved.outcome !== outcome ||
      saved.feedback !== input.feedback ||
      saved.botId !== botId ||
      saved.taskId !== taskId ||
      (reviewer === 'user' &&
        !!this.state.storage.metadata(`review-transfer:${saved.id}`) !== !!input.transfer) ||
      JSON.stringify(saved.targets.map((target) => target.artifactId).sort()) !==
        JSON.stringify(
          input.artifactIds
            .map(
              (artifactId) =>
                this.state.storage.metadata<ReviewTarget>(`review-transfer-target:${artifactId}`)
                  ?.artifactId ?? artifactId,
            )
            .sort(),
        )
    )
      throw new Error('审阅请求 ID 与内容不匹配');
    return saved;
  }

  private rework(
    room: Conversation,
    source: Task | undefined,
    artifacts: Artifact[],
    review: ArtifactReview,
    transferBotId?: string,
  ): string {
    const s = this.state.storage;
    const destination =
      transferBotId || source?.conversationId === room.id
        ? room
        : required(
            s.get<Conversation>(
              'conversations',
              required(source, '成果缺少原始任务').conversationId,
            ),
            '来源对话不存在，请选择有效接收对话',
          );
    if (!this.tasks.accepting(destination.id)) throw new Error('请先恢复来源对话');
    const active = this.activeRework(destination, source, artifacts);
    const content = `请修改以下成果并交付新版本：\n${artifacts.map((artifact) => `${artifact.name}（${artifact.id}）`).join('\n')}\n\n修改意见：${review.feedback}`;
    const message = s.appendMessage({
      id: id(),
      conversationId: destination.id,
      authorType: 'user',
      content,
      artifactIds: artifacts.map((artifact) => artifact.id),
      status: 'committed',
      createdAt: now(),
    });
    if (active) {
      this.tasks.appendInput(active, message);
      return active.id;
    }
    return this.tasks.create({
      conversationId: destination.id,
      botId: transferBotId ?? required(source, '成果缺少原始任务').botId,
      goal: content,
      expectedOutput: '根据修改意见交付新版本，登记成果时关联 previousArtifactId。',
      inputArtifactIds: artifacts.map((artifact) => artifact.id),
      requestId: `review:${review.id}`,
      sourceMessageId: message.id,
      reviewId: review.id,
      reworkOfTaskId: review.sourceTaskId,
    }).id;
  }

  private activeRework(
    room: Conversation,
    source: Task | undefined,
    artifacts: Artifact[],
  ): Task | undefined {
    if (source?.conversationId === room.id && !terminal(source.status)) return source;
    const keys = new Set(artifacts.map((artifact) => artifactVersionKey(artifact)));
    const reviews = this.state.storage.all<ArtifactReview>('artifact_reviews');
    return this.state.storage.byField<Task>('tasks', 'conversationId', room.id).find((task) => {
      if (terminal(task.status) || !task.reviewId) return false;
      const review = reviews.find((item) => item.id === task.reviewId);
      return review?.targets.some((target) => {
        const artifact = this.state.storage.get<Artifact>('artifacts', target.artifactId);
        return artifact && keys.has(artifactVersionKey(artifact));
      });
    });
  }
}
