import type { Artifact, Task } from './types.js';

export function artifactVersionKey(
  artifact: Artifact,
  tasks: ReadonlyMap<string, Pick<Task, 'botId'>> = new Map(),
): string {
  if (artifact.seriesId) return JSON.stringify(['series', artifact.seriesId]);
  const botId = artifact.botId ?? (artifact.taskId ? tasks.get(artifact.taskId)?.botId : undefined);
  let producer = ['artifact', artifact.id];
  if (botId) producer = ['bot', botId];
  else if (artifact.taskId) producer = ['task', artifact.taskId];
  return JSON.stringify([
    artifact.chiefContextId ?? artifact.conversationId,
    producer,
    artifact.workingPath || artifact.id,
  ]);
}

export function latestArtifactVersions(
  artifacts: Iterable<Artifact>,
  tasks: ReadonlyMap<string, Pick<Task, 'botId'>> = new Map(),
): Artifact[] {
  const current = new Map<string, Artifact>();
  for (const artifact of artifacts) {
    const key = artifactVersionKey(artifact, tasks);
    const previous = current.get(key);
    if (!previous || artifact.createdAt > previous.createdAt) current.set(key, artifact);
  }
  return [...current.values()];
}
