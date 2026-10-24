import { randomUUID } from 'node:crypto';
import { mkdirSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type {
  ChiefContextPart,
  ChiefInput,
  ChiefTimelineEntry,
  ChiefWorkContext,
} from '../domain/chief-work.js';
import type { Conversation, Settings, Task, Workspace } from '../domain/types.js';
import { ChiefContextService } from './chief-contexts.js';
import { ChiefTimelineService } from './chief-timeline.js';
import type { State } from './state.js';
import type { Storage } from './storage.js';
import { accessibleArtifacts } from './tool-access.js';
import { defaultSettings } from './work-settings.js';

export function ensureDefaultWorkspace(storage: Storage, dataDirectory: string): Workspace {
  const path = join(dataDirectory, 'workspace');
  mkdirSync(path, { recursive: true });
  const canonicalPath = realpathSync(path);
  const existing = storage
    .all<Workspace>('workspaces')
    .find(
      (workspace) => workspace.path === canonicalPath || resolve(workspace.path) === resolve(path),
    );
  const workspace: Workspace = {
    id: existing?.id ?? randomUUID(),
    name: existing?.name ?? '工作成果',
    path: canonicalPath,
    writable: true,
    enabled: true,
  };
  storage.put('workspaces', workspace);
  const settings = { ...defaultSettings, ...storage.metadata<Settings>('settings') };
  if (settings.defaultWorkspaceId !== workspace.id)
    storage.setMetadata('settings', { ...settings, defaultWorkspaceId: workspace.id });
  return workspace;
}

export function migrateChiefContinuity(state: State) {
  const s = state.storage;
  if (s.metadata('chief-continuity-v2')) return;
  const contexts = new ChiefContextService(state);
  s.transaction(() => {
    const sequenceKey = `chief-timeline-sequence:${contexts.homeId}`;
    const sequence = s
      .byField<ChiefTimelineEntry>('chief_timeline', 'homeConversationId', contexts.homeId)
      .reduce((maximum, entry) => Math.max(maximum, entry.displaySequence), 0);
    s.setMetadata(sequenceKey, Math.max(sequence, s.metadata<number>(sequenceKey) ?? 0));
    new ChiefTimelineService(state).sync(s.messages(contexts.homeId).map((message) => message.id));
    for (const context of s.all<ChiefWorkContext>('chief_contexts')) {
      if (context.kind) continue;
      s.put('chief_contexts', { ...context, kind: context.routineId ? 'work' : 'history' });
    }
    const main = contexts.ensureMain();
    const part = contexts.current(main.id).part;
    const earlier = s
      .byField<ChiefWorkContext>('chief_contexts', 'homeConversationId', contexts.homeId)
      .filter((context) => context.id !== main.id)
      .slice(-12)
      .flatMap((context) => {
        const previous = s.get<ChiefContextPart>('chief_parts', context.currentPartId);
        const tasks = previous
          ? s.byField<Task>('tasks', 'conversationId', previous.conversationId)
          : [];
        const result = tasks.filter((task) => task.result).at(-1);
        const summary = previous?.handoff ?? result?.result;
        return summary
          ? [`历史工作 ${context.id}（${context.title}）：${summary.slice(0, 600)}`]
          : [];
      })
      .join('\n');
    const artifactIds = new Set(part.sourceArtifactIds);
    for (const messageId of part.sourceMessageIds) {
      const message = s.getMessage(messageId);
      const room = message && s.get<Conversation>('conversations', message.conversationId);
      if (!room || room.chiefId !== state.settings().mainBotId) continue;
      const allowed = new Set(
        accessibleArtifacts(state, room, room.chiefId!).map((artifact) => artifact.id),
      );
      for (const artifactId of message!.artifactIds)
        if (allowed.has(artifactId)) artifactIds.add(artifactId);
    }
    s.put('chief_parts', {
      ...part,
      handoff: [part.handoff, earlier].filter(Boolean).join('\n\n').slice(0, 9000) || undefined,
      sourceArtifactIds: [...artifactIds],
    });
    if (artifactIds.size) {
      const key = `chief-artifact-grants:${main.conversationId}`;
      s.setMetadata(key, [...new Set([...(s.metadata<string[]>(key) ?? []), ...artifactIds])]);
    }
    for (const input of s.all<ChiefInput>('chief_inputs')) {
      if (!['pending', 'routing', 'clarification'].includes(input.status)) continue;
      s.put('chief_inputs', {
        ...input,
        status: 'pending',
        contextId: main.id,
        focusContextId: main.id,
        routingTaskId: undefined,
        question: undefined,
        candidateContextIds: undefined,
        error: undefined,
      });
    }
    s.setMetadata('chief-continuity-v2', true);
  });
}
