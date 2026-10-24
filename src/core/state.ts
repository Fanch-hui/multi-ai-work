import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type {
  Artifact,
  Bot,
  ProcessRecord,
  Run,
  Skill,
  Snapshot,
  Settings,
  Task,
  TaskQueueReason,
  Workspace,
} from '../domain/types.js';
import { Storage } from './storage.js';
import { ensureMemoryContentHashes, listMemoriesWithUsage } from './memory-storage.js';
import { ensureMainTeam, publicBot } from './chief.js';
import { migrateContextSettings } from './context-settings.js';
import { migrateProviders } from './provider-migrations.js';
import {
  migrateBotPermissions,
  migrateWorkSettings,
  workSettings,
  defaultSettings,
} from './work-settings.js';
import { migrateRunMetrics } from './run-metrics.js';
import { presetSkillIds, syncOfficeSkills } from './skills.js';
import { initializeOnboarding } from './onboarding.js';
import { initializeConversationReads, unreadConversations } from './conversation-read.js';
import type { TaskPlanRecord } from '../domain/task-plan.js';
import { taskPlanView } from './task-plan-view.js';
import { taskInputs } from './task-input-records.js';
import { taskActivity, taskActivityReader } from './task-activity.js';
import type { TaskActivity } from '../domain/task-activity.js';
import { artifactRequirement, taskRequirement } from './task-requirements.js';
import { SnapshotSync, publicProcess } from './snapshot-sync.js';
import { unreadConversationCounts } from './conversation-read.js';
import type { Message } from '../domain/types.js';
import { SnapshotCache } from './snapshot-cache.js';
import { ArtifactContents } from './artifact-contents.js';
import { migrateReplyArtifacts } from './reply-artifacts.js';
import { ArtifactObjects } from './artifact-objects.js';
import { migrateChiefWork } from './chief-migration.js';
import { chiefSnapshot } from './chief-contexts.js';
import { ChiefTimelineService } from './chief-timeline.js';

export const now = () => new Date().toISOString();
export const id = () => randomUUID();
export { defaultSettings } from './work-settings.js';
export type StateChange = 'state' | 'content';
export class State {
  readonly storage: Storage;
  readonly artifactContents: ArtifactContents;
  readonly artifactObjects: ArtifactObjects;
  private readonly snapshotCache: SnapshotCache;
  readonly sync = new SnapshotSync(this);
  private listeners = new Set<(kind: StateChange) => void>();
  queueReasonFor?: (task: Task) => TaskQueueReason | undefined;
  constructor(readonly dataDirectory: string) {
    mkdirSync(dataDirectory, { recursive: true, mode: 0o700 });
    this.storage = new Storage(join(dataDirectory, 'team.sqlite'));
    this.artifactObjects = new ArtifactObjects(dataDirectory, this.storage);
    this.artifactContents = new ArtifactContents(this.storage, dataDirectory);
    this.snapshotCache = new SnapshotCache(this.storage);
    ensureMemoryContentHashes(this.storage);
    migrateRunMetrics(this.storage);
    migrateReplyArtifacts(this.storage);
    if (!this.storage.all<Workspace>('workspaces').length) {
      const path = join(dataDirectory, 'workspace');
      mkdirSync(path, { recursive: true });
      this.storage.put('workspaces', { id: id(), name: '工作成果', path, writable: true });
    }
    if (!this.storage.metadata('settings')) this.storage.setMetadata('settings', defaultSettings);
    migrateProviders(this.storage);
    migrateContextSettings(this.storage);
    this.syncMainTeam();
    syncOfficeSkills(this);
    if (!this.storage.metadata('task-input-artifacts-v1')) {
      for (const task of this.storage.all<Task>('tasks')) {
        const inputs = task.artifactIds.filter(
          (artifactId) =>
            this.storage.get<Artifact>('artifacts', artifactId)?.source === 'user-attachment',
        );
        this.storage.put('tasks', {
          ...task,
          inputArtifactIds: task.inputArtifactIds ?? inputs,
          artifactIds: task.artifactIds.filter((artifactId) => !inputs.includes(artifactId)),
        });
      }
      this.storage.setMetadata('task-input-artifacts-v1', true);
    }
  }
  settings(): Settings {
    return workSettings(this.storage.metadata('settings'));
  }
  taskSnapshot(task: Task, readActivity?: (task: Task) => TaskActivity): Task {
    const queueReason = this.queueReasonFor?.(task);
    const current = { ...task, ...(queueReason ? { queueReason } : {}) };
    return {
      ...current,
      activity: readActivity ? readActivity(current) : taskActivity(this.storage, current),
      ...(!task.kind ? { requirement: taskRequirement(this.storage, task) } : {}),
    };
  }
  syncMainTeam() {
    migrateWorkSettings(this.storage);
    const settings = ensureMainTeam(this.storage, this.settings());
    migrateBotPermissions(this.storage, settings.mainBotId);
    initializeOnboarding(this.storage);
    initializeConversationReads(this.storage);
    migrateChiefWork(this);
  }
  snapshot(messageProjection?: Message[]): Snapshot {
    const s = this.storage,
      settings = this.settings(),
      messages = messageProjection ?? s.messages(),
      tasks = s.all<Task>('tasks');
    const runs = s.all<Run>('runs'),
      readActivity = taskActivityReader(s, tasks, runs);
    const privateSkillIds = presetSkillIds(this);
    const timeline = new ChiefTimelineService(this);
    timeline.sync(s.changes.ids('messages'));
    const conversations = messageProjection
      ? unreadConversationCounts(s)
      : unreadConversations(s, messages);
    return {
      chief: chiefSnapshot(this),
      connections: this.snapshotCache.all('connections'),
      bots: this.snapshotCache.all<Bot>('bots').map((bot) => publicBot(bot, settings.mainBotId)),
      conversations: conversations.map((room) =>
        room.id === settings.mainConversationId
          ? { ...room, unreadCount: timeline.unreadCount() }
          : room,
      ),
      workspaces: this.snapshotCache.all('workspaces'),
      messages,
      tasks: tasks.map((task) => this.taskSnapshot(task, readActivity)),
      runs,
      approvals: s.all('approvals'),
      artifacts: s.all<Artifact>('artifacts').map((artifact) => ({
        ...artifactRequirement(s, artifact),
        ...(artifact.image ? { image: { ...artifact.image, path: '' } } : {}),
      })),
      questions: s.all('questions'),
      memories: listMemoriesWithUsage(s),
      processes: s.all<ProcessRecord>('processes').map(publicProcess),
      events: s.events(),
      toolConnections: this.snapshotCache.all('tool_connections'),
      skills: this.snapshotCache
        .all<Skill>('skills')
        .map((skill) => (privateSkillIds.has(skill.id) ? { ...skill, presetOnly: true } : skill)),
      bindings: s.all('session_bindings'),
      checkpoints: s.all('context_checkpoints'),
      compactions: s.all('compactions'),
      taskPlans: s
        .all<TaskPlanRecord>('task_plans')
        .map((plan) => taskPlanView(plan, tasks, settings.mainBotId!)),
      taskInputs: taskInputs(s),
      settings,
      dataDirectory: this.dataDirectory,
    };
  }
  changed(kind: StateChange = 'state', options: { incremental?: boolean } = {}) {
    new ChiefTimelineService(this).sync(this.storage.changes.ids('messages'));
    this.sync.changed(kind, options.incremental);
    for (const listener of this.listeners) listener(kind);
  }
  subscribe(listener: (kind: StateChange) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
