import type { Bot, Run, Task } from '../domain/types.js';
import type { State } from './state.js';
import { artifactRequirement } from './task-requirements.js';
import type { Artifact, TaskInput } from '../domain/types.js';
import { isBoundTaskDescendant } from './task-access.js';

export function inspectTask(state: State, task: Task) {
  const s = state.storage;
  const latestRun = (item: Task) => {
    const run = item.runIds.at(-1) ? s.get<Run>('runs', item.runIds.at(-1)!) : undefined;
    return (
      run && {
        id: run.id,
        status: run.status,
        error: run.error,
        createdAt: run.createdAt,
        endedAt: run.endedAt,
      }
    );
  };
  const children = s
    .byField<Task>('tasks', 'parentId', task.id)
    .filter((child) => isBoundTaskDescendant(state, task, child));
  const descendants = [...children];
  const seen = new Set([task.id, ...children.map((child) => child.id)]);
  for (let index = 0; index < descendants.length; index++) {
    for (const child of s.byField<Task>('tasks', 'parentId', descendants[index].id)) {
      if (seen.has(child.id) || !isBoundTaskDescendant(state, task, child)) continue;
      seen.add(child.id);
      descendants.push(child);
    }
  }
  const visibleArtifactIds = (ids: string[]) =>
    ids.filter((artifactId) => !!s.get<Artifact>('artifacts', artifactId));
  const artifacts = visibleArtifactIds([
    ...new Set([...task.artifactIds, ...descendants.flatMap((child) => child.artifactIds)]),
  ]);
  const inputs = s
    .all<TaskInput>('deliveries')
    .filter((input) => input.kind === 'user-input' && input.taskId === task.id);
  const snapshot = state.taskSnapshot(task);
  const deliverables = artifacts.flatMap((artifactId) => {
    const artifact = s.get<Artifact>('artifacts', artifactId);
    return artifact && artifact.purpose !== 'intermediate'
      ? [artifactRequirement(s, artifact)]
      : [];
  });
  return {
    ...snapshot,
    artifactIds: artifacts,
    latestRun: latestRun(task),
    inputs,
    deliverables,
    deliveryChecklist: {
      requirementVersion: snapshot.requirement?.version,
      artifacts: deliverables
        .filter((artifact) => !artifact.superseded)
        .map(({ id, name, sha256, requirementVersion }) => ({
          id,
          name,
          sha256,
          requirementVersion,
        })),
    },
    children: children.map((child) => ({
      id: child.id,
      botId: child.botId,
      botName: s.get<Bot>('bots', child.botId)?.name,
      status: child.status,
      queueReason: state.taskSnapshot(child).queueReason,
      goal: child.goal.slice(0, 200),
      dependencyIds: child.dependencyIds,
      artifactIds: visibleArtifactIds(child.artifactIds),
      error: child.error,
      updatedAt: child.updatedAt,
      latestRun: latestRun(child),
    })),
  };
}
