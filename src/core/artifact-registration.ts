import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { normalize } from 'node:path';
import type { Artifact, Bot, Conversation, Run, Task } from '../domain/types.js';
import type { ToolExecutionContext } from '../domain/tools.js';
import { id, now, type State } from './state.js';

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
    createdAt: now(),
    requirementVersion,
  };
  state.storage.transaction(() => {
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
