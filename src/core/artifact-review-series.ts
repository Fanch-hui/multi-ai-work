import type { Artifact, Conversation, Task } from '../domain/types.js';
import type { ArtifactReview } from '../domain/artifact-review.js';
import { artifactVersionKey } from '../domain/artifact-versions.js';
import { isDeliverableArtifact } from '../domain/artifact-purpose.js';
import type { State } from './state.js';
import { accessibleArtifacts } from './tool-access.js';
import { required } from './errors.js';

export function artifactSeries(
  state: State,
  task: Task,
  previousArtifactId?: string,
): { seriesId?: string; previousArtifactId?: string; related: Artifact[] } {
  if (!previousArtifactId) return { related: [] };
  const s = state.storage;
  task = s.get<Task>('tasks', task.id) ?? task;
  const previous = required(s.get<Artifact>('artifacts', previousArtifactId), '上一版本已删除');
  if (!isDeliverableArtifact(previous)) throw new Error('上一版本必须是正式交付成果');
  const room = required(s.get<Conversation>('conversations', task.conversationId), '对话不存在');
  if (!accessibleArtifacts(state, room, task.botId, task).some((item) => item.id === previous.id))
    throw new Error('上一版本不在当前任务授权范围');
  let current: Task | undefined = task;
  let reworkTarget = false;
  while (current) {
    const review = current.reviewId && s.get<ArtifactReview>('artifact_reviews', current.reviewId);
    if (review && review.targets.some((target) => target.artifactId === previous.id))
      reworkTarget = true;
    current = current.parentId ? s.get<Task>('tasks', current.parentId) : undefined;
  }
  if (!task.inputArtifactIds?.includes(previous.id) && !reworkTarget)
    throw new Error('上一版本必须是本任务输入或明确返工目标');
  return { ...previousArtifactSeries(state, previous), previousArtifactId };
}

export function previousArtifactSeries(
  state: State,
  previous: Artifact,
): { seriesId: string; related: Artifact[] } {
  if (previous.seriesId) return { seriesId: previous.seriesId, related: [] };
  const s = state.storage;
  const tasks = new Map(
    s
      .byField<Task>('tasks', 'conversationId', previous.conversationId)
      .map((item) => [item.id, item]),
  );
  const legacyKey = artifactVersionKey(previous, tasks);
  const related = s
    .byField<Artifact>('artifacts', 'conversationId', previous.conversationId)
    .filter((artifact) => !artifact.seriesId && artifactVersionKey(artifact, tasks) === legacyKey);
  return { seriesId: previous.id, related };
}
