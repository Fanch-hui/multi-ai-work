import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { normalize } from 'node:path';
import type { Artifact, Bot, Conversation, Run, Task } from '../domain/types.js';
import type { ToolExecutionContext } from '../domain/tools.js';
import { id, now, type State } from './state.js';
import { artifactSeries } from './artifact-review-series.js';

function chiefContextId(state: State, source: Conversation): string | undefined {
  let room: Conversation | undefined = source;
  const seen = new Set<string>();
  while (room && !seen.has(room.id)) {
    if (room.chiefContextId) return room.chiefContextId;
    seen.add(room.id);
    room = room.sourceConversationId
      ? state.storage.get<Conversation>('conversations', room.sourceConversationId)
      : undefined;
  }
  return undefined;
}

export function registerTaskArtifact(
  state: State,
  input: Parameters<ToolExecutionContext['registerArtifact']>[0],
  task: Task,
  bot: Bot,
  room: Conversation,
  run: Run,
): Artifact {
  const bytes = readFileSync(input.path);
  if (
    input.sha256 !== createHash('sha256').update(bytes).digest('hex') ||
    input.size !== bytes.length
  )
    throw new Error('文件内容已变化，请重新读取后登记');
  const workingPath = input.workingPath ?? (input.source ? undefined : input.path);
  const series = artifactSeries(state, task, input.previousArtifactId);
  const requirementVersion =
    input.requirementVersion ?? state.storage.get<Run>('runs', run.id)?.requirementVersion;
  const previous = state.storage
    .byField<Artifact>('artifacts', 'taskId', task.id)
    .find(
      (artifact) =>
        artifact.botId === bot.id &&
        artifact.conversationId === room.id &&
        artifact.name === input.name &&
        artifact.sha256 === input.sha256 &&
        artifact.size === bytes.length &&
        artifact.mimeType === input.mimeType &&
        artifact.source === input.source &&
        artifact.purpose === input.purpose &&
        artifact.requirementVersion === requirementVersion &&
        artifact.previousArtifactId === series.previousArtifactId &&
        normalize(artifact.workingPath ?? '') === normalize(workingPath ?? ''),
    );
  if (previous) {
    try {
      if (readFileSync(previous.path).equals(bytes)) return previous;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  const artifactId = id();
  const stored = state.artifactObjects.publish(artifactId, input.name, bytes);
  const artifact: Artifact = {
    ...input,
    ...stored,
    id: artifactId,
    workingPath,
    taskId: task.id,
    botId: bot.id,
    conversationId: room.id,
    chiefContextId: chiefContextId(state, room),
    createdAt: now(),
    requirementVersion,
    seriesId: series.seriesId,
    previousArtifactId: series.previousArtifactId,
  };
  state.storage.transaction(() => {
    for (const related of series.related)
      state.storage.put('artifacts', { ...related, seriesId: series.seriesId });
    state.storage.put('artifacts', artifact);
    const current = state.storage.get<Task>('tasks', task.id)!;
    state.storage.put('tasks', {
      ...current,
      artifactIds: [...new Set([...current.artifactIds, artifact.id])],
    });
  });
  state.changed();
  return artifact;
}
