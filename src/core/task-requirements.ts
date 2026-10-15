import type { Artifact, Message, Run, Task } from '../domain/types.js';
import type { TaskRequirement } from '../domain/task-requirement.js';
import type { Storage } from './storage.js';
import { taskPlanRoot } from './task-plan-view.js';

export function taskRequirement(storage: Storage, task: Task): TaskRequirement {
  const root = taskPlanRoot(storage, task) ?? task;
  const saved = storage.metadata<TaskRequirement>(`requirements:${root.id}`) ?? { taskId: root.id, version: 1, updates: [] };
  return { ...saved, updates: saved.updates.filter(update => task.id === root.id || update.conversationId === task.conversationId) };
}

export function updateRequirement(storage: Storage, task: Task, message: Message): number {
  const root = taskPlanRoot(storage, task) ?? task;
  const key = `requirements:${root.id}`;
  const previous = storage.metadata<TaskRequirement>(key) ?? { taskId: root.id, version: 1, updates: [] };
  const existing = previous.updates.find(update => update.messageId === message.id);
  if (existing) return existing.version;
  const version = previous.version + 1;
  storage.setMetadata(key, { ...previous, version, updates: [...previous.updates, { version, messageId: message.id,
    conversationId: message.conversationId, content: message.content, artifactIds: message.artifactIds, createdAt: message.createdAt }] });
  return version;
}

export function receivedRequirementVersion(storage: Storage, task: Task): number {
  return Math.max(1, ...taskRequirement(storage, task).updates.map(update => update.version));
}

export function artifactRequirement(storage: Storage, artifact: Artifact): Artifact {
  const task = artifact.taskId ? storage.get<Task>('tasks', artifact.taskId) : undefined;
  if (!task || artifact.requirementVersion === undefined) return artifact;
  return { ...artifact, superseded: artifact.requirementVersion < taskRequirement(storage, task).version };
}

export function acknowledgeRequirement(storage: Storage, run: Run, versions: number[]) {
  if (!versions.length) return;
  const current = storage.get<Run>('runs', run.id) ?? run;
  storage.put('runs', { ...current, requirementVersion: Math.max(current.requirementVersion ?? 1, ...versions) });
}
