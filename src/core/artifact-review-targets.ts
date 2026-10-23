import type { Artifact, Conversation, Task } from '../domain/types.js';
import type { ArtifactReview, ReviewTarget } from '../domain/artifact-review.js';
import { isDeliverableArtifact } from '../domain/artifact-purpose.js';
import type { State } from './state.js';
import { accessibleArtifacts } from './tool-access.js';
import { taskPlanRoot } from './task-plan-view.js';
import { required } from './errors.js';

export function reviewArtifacts(state: State, room: Conversation): Artifact[] {
  const tasks = state.storage.byField<Task>('tasks', 'conversationId', room.id);
  const visible = accessibleArtifacts(state, room, room.chiefId ?? room.memberIds[0]);
  const all = [
    ...visible,
    ...tasks.flatMap((task) => accessibleArtifacts(state, room, task.botId, task)),
  ];
  return [...new Map(all.map((item) => [item.id, item])).values()].filter(isDeliverableArtifact);
}

export function reviewTargets(state: State, artifacts: Artifact[]): ReviewTarget[] {
  return artifacts.map((artifact) => {
    const transferred =
      artifact.source === 'review-transfer' &&
      state.storage.metadata<ReviewTarget>(`review-transfer-target:${artifact.id}`);
    if (transferred) return transferred;
    const task = artifact.taskId && state.storage.get<Task>('tasks', artifact.taskId);
    const root = task ? (taskPlanRoot(state.storage, task) ?? task) : undefined;
    return {
      artifactId: artifact.id,
      sha256: artifact.sha256,
      name: artifact.name,
      ...((root || artifact.taskId) && artifact.requirementVersion !== undefined
        ? {
            requirementTaskId: root?.id ?? artifact.taskId,
            requirementVersion: artifact.requirementVersion,
          }
        : {}),
    };
  });
}

export function requireReviewArtifacts(visible: Artifact[], artifactIds: string[]): Artifact[] {
  return artifactIds.map((id) =>
    required(
      visible.find((item) => item.id === id && isDeliverableArtifact(item)),
      '成果不在当前会话授权范围或已删除',
    ),
  );
}

export function reviewSource(
  state: State,
  artifacts: Artifact[],
  allowMissing = false,
): Task | undefined {
  const roots = new Map<string, Task | undefined>();
  for (const artifact of artifacts) {
    const task = artifact.taskId && state.storage.get<Task>('tasks', artifact.taskId);
    if (!task) {
      if ((!allowMissing && artifact.source !== 'review-transfer') || !artifact.taskId)
        throw new Error('成果缺少原始任务');
      roots.set(artifact.taskId, undefined);
      continue;
    }
    const root = taskPlanRoot(state.storage, task) ?? task;
    roots.set(root.id, root);
  }
  if (roots.size !== 1) throw new Error('请分别提交不同任务的成果意见');
  return roots.values().next().value;
}

export function reviewHistory(
  state: State,
  review: ArtifactReview,
  conversationId = review.conversationId,
) {
  const task = review.reworkTaskId && state.storage.get<Task>('tasks', review.reworkTaskId);
  const reviewInputArtifactIds = review.targets.flatMap((target) => {
    const inputId = state.storage.metadata<string>(
      `review-transfer-input:${conversationId}:${target.artifactId}`,
    );
    const artifact = inputId ? state.storage.get<Artifact>('artifacts', inputId) : undefined;
    return artifact?.conversationId === conversationId && artifact.sha256 === target.sha256
      ? [artifact.id]
      : [];
  });
  return {
    ...review,
    ...(reviewInputArtifactIds.length ? { reviewInputArtifactIds } : {}),
    ...(task
      ? { reworkTask: { id: task.id, status: task.status, conversationId: task.conversationId } }
      : {}),
    targets: review.targets.map((target) => ({
      ...target,
      deleted: !state.storage.get<Artifact>('artifacts', target.artifactId),
    })),
  };
}
