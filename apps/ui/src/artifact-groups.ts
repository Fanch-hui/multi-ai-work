import type { Artifact, Bot, Conversation, Snapshot, Task } from '../../../src/domain/types.js';
import { isDeliverableArtifact } from '../../../src/domain/artifact-purpose.js';
import {
  artifactVersionKey,
  latestArtifactVersions,
} from '../../../src/domain/artifact-versions.js';

export interface ArtifactGroup {
  id: string;
  title: string;
  project?: string;
  updatedAt: string;
  artifacts: Artifact[];
  history?: Map<string, Artifact[]>;
}

interface GroupOrigin {
  id: string;
  title: string;
  workspaceId?: string;
}

function groupOrigin(
  artifact: Artifact,
  tasks: Map<string, Task>,
  conversations: Map<string, Conversation>,
  chief?: Snapshot['chief'],
): GroupOrigin {
  let task = artifact.taskId ? tasks.get(artifact.taskId) : undefined;
  let conversationId = task?.conversationId ?? artifact.conversationId;
  let room = conversations.get(conversationId);
  const originalRoom = room;
  const visited = new Set<string>();
  while (!visited.has(`${conversationId}:${task?.id ?? ''}`)) {
    visited.add(`${conversationId}:${task?.id ?? ''}`);
    const source = room?.sourceTaskId ? tasks.get(room.sourceTaskId) : undefined;
    if (
      room?.kind === 'group' &&
      room.purpose === 'task' &&
      room.sourceConversationId &&
      (!source || source.conversationId === room.sourceConversationId)
    ) {
      conversationId = room.sourceConversationId;
      task = source;
      room = conversations.get(conversationId);
      continue;
    }
    if (room) break;
    const parent = task?.parentId ? tasks.get(task.parentId) : undefined;
    if (!parent) break;
    task = parent;
    conversationId = task.conversationId;
    room = conversations.get(conversationId);
  }
  const context = chief?.contexts.find(
    (item) => item.id === artifact.chiefContextId || item.conversationIds.includes(conversationId),
  );
  if (context)
    return {
      id: `work:${context.id}`,
      title: context.title,
      workspaceId: artifact.workspaceId ?? context.workspaceId,
    };
  return {
    id: `conversation:${conversationId}`,
    workspaceId: artifact.workspaceId ?? room?.workspaceId,
    title:
      room?.name ||
      originalRoom?.name ||
      task?.goal.trim().replace(/\s+/g, ' ') ||
      '已删除对话的成果',
  };
}

export function artifactProducer(
  artifact: Artifact,
  tasks: Map<string, Task>,
  bots: Map<string, Bot>,
): Bot | undefined {
  const botId = artifact.botId ?? (artifact.taskId ? tasks.get(artifact.taskId)?.botId : undefined);
  return botId ? bots.get(botId) : undefined;
}

export function artifactGroups(
  data: Pick<Snapshot, 'artifacts' | 'tasks' | 'conversations'> &
    Partial<Pick<Snapshot, 'bots' | 'chief' | 'workspaces'>>,
  query = '',
): ArtifactGroup[] {
  const tasks = new Map(data.tasks.map((task) => [task.id, task]));
  const conversations = new Map(data.conversations.map((room) => [room.id, room]));
  const bots = new Map(data.bots?.map((bot) => [bot.id, bot]));
  const groups = new Map<string, ArtifactGroup>();
  const projects = new Map<string, Set<string>>();
  const deliverables = data.artifacts.filter(isDeliverableArtifact);
  const current = latestArtifactVersions(deliverables, tasks);
  const versions = new Map<string, Artifact[]>();
  for (const artifact of deliverables) {
    const key = artifactVersionKey(artifact, tasks);
    const history = versions.get(key) ?? [];
    history.push(artifact);
    versions.set(key, history);
  }
  const search = query.trim().toLocaleLowerCase();
  for (const artifact of current) {
    const { id, title, workspaceId } = groupOrigin(artifact, tasks, conversations, data.chief);
    let group = groups.get(id);
    if (!group) {
      group = {
        id,
        title,
        project: data.workspaces?.find((item) => item.id === workspaceId)?.name,
        updatedAt: artifact.createdAt,
        artifacts: [],
      };
      groups.set(id, group);
    }
    const project = data.workspaces?.find((item) => item.id === workspaceId)?.name;
    if (project) {
      const names = projects.get(id) ?? new Set<string>();
      names.add(project);
      projects.set(id, names);
      group.project = [...names].join(' · ');
    }
    group.artifacts.push(artifact);
    const seenContent = new Set([artifact.sha256]);
    const history = versions
      .get(artifactVersionKey(artifact, tasks))!
      .filter((version) => version.id !== artifact.id)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .filter((version) => {
        if (!/^[a-f0-9]{64}$/.test(version.sha256)) return true;
        if (seenContent.has(version.sha256)) return false;
        seenContent.add(version.sha256);
        return true;
      });
    if (history.length) {
      group.history ??= new Map();
      group.history.set(artifact.id, history);
    }
    if (artifact.createdAt > group.updatedAt) group.updatedAt = artifact.createdAt;
  }
  const matchingGroups: ArtifactGroup[] = [];
  for (const group of groups.values()) {
    if (
      search &&
      !group.title.toLocaleLowerCase().includes(search) &&
      !group.project?.toLocaleLowerCase().includes(search)
    ) {
      group.artifacts = group.artifacts.filter(
        (artifact) =>
          artifact.name.toLocaleLowerCase().includes(search) ||
          artifactProducer(artifact, tasks, bots)?.name.toLocaleLowerCase().includes(search),
      );
      if (!group.artifacts.length) continue;
      const visibleIds = new Set(group.artifacts.map((artifact) => artifact.id));
      for (const id of group.history?.keys() ?? []) {
        if (!visibleIds.has(id)) group.history?.delete(id);
      }
    }
    group.artifacts.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    group.updatedAt = group.artifacts[0].createdAt;
    matchingGroups.push(group);
  }
  return matchingGroups.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}
