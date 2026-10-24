import type {
  ChiefContextPart,
  ChiefContextView,
  ChiefModelJob,
  ChiefWorkContext,
} from '../domain/chief-work.js';
import { terminal } from '../domain/task-status.js';
import type { Conversation, Task } from '../domain/types.js';
import type { State } from './state.js';
import { publicError } from './errors.js';
import { maintenanceDecision, maintenancePrompt } from './chief-maintenance-prompt.js';
import {
  maintenanceReady,
  maintenanceSource,
  type MaintenanceSource,
} from './chief-maintenance-source.js';

export interface ChiefMaintenanceContexts {
  list(): ChiefContextView[];
  current(contextId: string): {
    context: ChiefWorkContext;
    part: ChiefContextPart;
    room: Conversation;
  };
  rotate(
    contextId: string,
    handoff: string,
    sourceMessageIds: string[],
    sourceArtifactIds: string[],
  ): ChiefContextView;
}

export interface ChiefMaintenanceJobs {
  queue(
    kind: 'chief-routing' | 'chief-context-maintenance',
    spec: ChiefModelJob,
    requestId: string,
  ): Task;
  compact(conversationId: string): Task;
}

interface MaintenanceRecord {
  partId: string;
  fingerprint: string;
  status: 'judging' | 'compacting' | 'settled' | 'failed';
  taskId?: string;
  compactionId?: string;
  error?: string;
}

const recordKey = (contextId: string) => `chief-maintenance:${contextId}`;

export class ChiefMaintenanceService {
  private unsubscribe?: () => void;
  private scheduled = false;
  private closed = false;

  constructor(
    private state: State,
    private contexts: ChiefMaintenanceContexts,
    private jobs: ChiefMaintenanceJobs,
  ) {}

  start() {
    if (this.unsubscribe) return;
    this.closed = false;
    this.unsubscribe = this.state.subscribe((kind) => {
      if (kind === 'state') this.schedule();
    });
    this.schedule();
  }

  close() {
    this.closed = true;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
  }

  tick() {
    if (this.closed) return;
    for (const view of this.contexts.list()) this.check(view);
  }

  private schedule() {
    if (this.closed || this.scheduled) return;
    this.scheduled = true;
    queueMicrotask(() => {
      this.scheduled = false;
      this.tick();
    });
  }

  private check(view: ChiefContextView) {
    if (view.kind === 'history') return;
    const s = this.state.storage;
    const previous = s.metadata<MaintenanceRecord>(recordKey(view.id));
    const source = maintenanceSource(this.state, view, previous?.compactionId);
    if (previous && ['judging', 'compacting'].includes(previous.status)) {
      this.consume(view, previous, source);
      return;
    }
    if (!source?.pressured || previous?.fingerprint === source.fingerprint) return;
    if (!maintenanceReady(this.state, view, source.tasks)) return;
    try {
      s.transaction(() => {
        const job = this.jobs.queue(
          'chief-context-maintenance',
          maintenancePrompt(this.state, source),
          `chief-maintenance:${view.id}:${source.fingerprint}`,
        );
        s.setMetadata(recordKey(view.id), {
          partId: source.partId,
          fingerprint: source.fingerprint,
          status: 'judging',
          taskId: job.id,
          compactionId: source.compactionId,
        } satisfies MaintenanceRecord);
      });
      this.state.changed();
    } catch (error) {
      this.finish(view.id, source, 'failed', publicError(error));
    }
  }

  private consume(view: ChiefContextView, record: MaintenanceRecord, source?: MaintenanceSource) {
    const task = record.taskId ? this.state.storage.get<Task>('tasks', record.taskId) : undefined;
    if (task && !terminal(task.status)) return;
    if (
      !source ||
      record.partId !== view.currentPartId ||
      record.fingerprint !== source.fingerprint
    ) {
      this.settle(view.id, { ...record, status: 'settled' });
      return;
    }
    if (!maintenanceReady(this.state, view, source.tasks)) {
      this.finish(view.id, source, 'settled');
      return;
    }
    if (!task || task.status !== 'completed') {
      this.finish(view.id, source, 'failed', task?.error ?? '上下文整理任务未完成');
      return;
    }
    if (record.status === 'compacting') {
      this.finish(view.id, source, 'settled');
      return;
    }
    try {
      const decision = maintenanceDecision(task.result);
      if (decision.action === 'compact') {
        const compact = this.jobs.compact(source.conversationId);
        this.state.storage.setMetadata(recordKey(view.id), {
          ...record,
          status: 'compacting',
          taskId: compact.id,
        } satisfies MaintenanceRecord);
        this.state.changed();
      } else {
        this.contexts.rotate(
          view.id,
          decision.handoff!,
          source.sourceMessageIds,
          source.sourceArtifactIds,
        );
        this.finish(view.id, source, 'settled');
      }
    } catch (error) {
      this.finish(view.id, source, 'failed', publicError(error));
    }
  }

  private finish(
    contextId: string,
    source: MaintenanceSource,
    status: 'settled' | 'failed',
    error?: string,
  ) {
    this.settle(contextId, {
      partId: source.partId,
      fingerprint: source.fingerprint,
      compactionId: source.compactionId,
      status,
      ...(error ? { error } : {}),
    } satisfies MaintenanceRecord);
  }

  private settle(contextId: string, record: MaintenanceRecord) {
    const key = recordKey(contextId);
    const previous = this.state.storage.metadata<MaintenanceRecord>(key);
    this.state.storage.setMetadata(key, record);
    if (previous && ['judging', 'compacting'].includes(previous.status)) this.state.changed();
  }
}
