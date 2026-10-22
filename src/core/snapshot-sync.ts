import { randomUUID } from 'node:crypto';
import type { Message, ProcessRecord, Run, Task, TaskInput } from '../domain/types.js';
import type { TaskPlanRecord } from '../domain/task-plan.js';
import type {
  MessagePage,
  SnapshotCursor,
  SnapshotDelta,
  SnapshotView,
} from '../domain/snapshot-sync.js';
import type { State, StateChange } from './state.js';
import type { StorageChanges } from './storage-changes.js';
import { taskActivityReader } from './task-activity.js';
import { unreadConversationCounts } from './conversation-read.js';
import { taskPlanView } from './task-plan-view.js';

interface Change extends StorageChanges {
  version: number;
  legacyReset: boolean;
}
const supported = new Set([
  'messages',
  'tasks',
  'runs',
  'processes',
  'events',
  'text_events',
  'provider_archive',
]);
const businessSupported = new Set([...supported, 'deliveries', 'task_plans', 'conversation_reads']);
export const publicProcess = (item: ProcessRecord): ProcessRecord => ({
  id: item.id,
  runId: item.runId,
  taskId: item.taskId,
  botId: item.botId,
  conversationId: item.conversationId,
  workspaceId: item.workspaceId,
  command: item.command,
  args: item.args,
  status: item.status,
  createdAt: item.createdAt,
  endedAt: item.endedAt,
  code: item.code,
  signal: item.signal,
  stoppedByBotId: item.stoppedByBotId,
  stoppedByTaskId: item.stoppedByTaskId,
});

export class SnapshotSync {
  private epoch = randomUUID();
  private version = 0;
  private log: Change[] = [];
  constructor(private state: State) {}
  cursor(eventSequence = this.state.storage.latestNonTextEventSequence()): SnapshotCursor {
    return { epoch: this.epoch, version: this.version, eventSequence };
  }
  changed(kind: StateChange, incremental = false) {
    const changes = this.state.storage.changes.take();
    if (changes.invalidated) this.epoch = randomUUID();
    const legacyReset =
      kind === 'state' ||
      changes.reset ||
      [...changes.entities.keys()].some((table) => !supported.has(table));
    const reset =
      (kind === 'state' && !incremental) ||
      changes.reset ||
      [...changes.entities.keys()].some((table) => !businessSupported.has(table));
    this.log.push({ ...changes, reset, legacyReset, version: ++this.version });
    if (this.log.length > 256) this.log.shift();
  }
  view(conversationId?: string, from?: number): SnapshotView {
    let page: MessagePage | undefined;
    if (conversationId) {
      page = from
        ? this.state.storage.messageRange(conversationId, from)
        : this.state.storage.messagePage(conversationId);
    }
    return {
      snapshot: this.state.snapshot(page?.messages ?? []),
      cursor: this.cursor(),
      ...(conversationId ? { history: { conversationId, nextBefore: page?.nextBefore } } : {}),
    };
  }
  delta(cursor: SnapshotCursor, conversationId?: string, businessDeltas = false): SnapshotDelta {
    const changes = this.log.filter((change) => change.version > cursor.version);
    const result: SnapshotDelta = {
      cursor: { epoch: this.epoch, version: this.version, eventSequence: cursor.eventSequence },
      messages: [],
      tasks: [],
      runs: [],
      processes: [],
    };
    if (
      cursor.epoch !== this.epoch ||
      cursor.version > this.version ||
      cursor.version < (this.log[0]?.version ?? this.version + 1) - 1
    )
      return { ...result, reset: true };
    if (changes.some((change) => (businessDeltas ? change.reset : change.legacyReset)))
      result.reset = true;
    const s = this.state.storage;
    if (cursor.eventSequence === undefined) {
      result.events = s.events();
      result.cursor.eventSequence = s.latestNonTextEventSequence();
    }
    if (!changes.length) return result;
    const ids = (table: string) => [
      ...new Set(changes.flatMap((change) => [...(change.entities.get(table) ?? [])])),
    ];
    const changedMessages = ids('messages')
      .map((id) => s.getMessage(id))
      .filter((item): item is Message => !!item);
    result.messages = changedMessages.filter((item) => item.conversationId === conversationId);
    const runs = ids('runs')
      .map((id) => s.get<Run>('runs', id))
      .filter((item): item is Run => !!item);
    const eventRunIds = new Set([...ids('events'), ...ids('text_events')]);
    const eventRuns = [...eventRunIds]
      .map((id) => s.get<Run>('runs', id))
      .filter((item): item is Run => !!item);
    const changedTaskIds = new Set(ids('tasks'));
    const taskIds = new Set([
      ...changedTaskIds,
      ...runs.map((run) => run.taskId),
      ...eventRuns.map((run) => run.taskId),
    ]);
    // A dependency or occupied execution slot can change another queued task's wait reason.
    if (businessDeltas && changedTaskIds.size) {
      for (const status of ['queued', 'recovering'])
        for (const task of s.byField<Task>('tasks', 'status', status)) taskIds.add(task.id);
    }
    const tasks = [...taskIds]
      .map((id) => s.get<Task>('tasks', id))
      .filter((item): item is Task => !!item);
    const taskRuns = tasks
      .map((task) => task.runIds.at(-1))
      .filter((id): id is string => !!id)
      .map((id) => s.get<Run>('runs', id))
      .filter((run): run is Run => !!run);
    const currentRuns = [
      ...new Map([...runs, ...eventRuns, ...taskRuns].map((run) => [run.id, run])).values(),
    ];
    const readActivity = taskActivityReader(s, tasks, currentRuns);
    result.tasks = tasks.map((task) => this.state.taskSnapshot(task, readActivity));
    result.runs = runs;
    result.processes = ids('processes')
      .map((id) => s.get<ProcessRecord>('processes', id))
      .filter((item): item is ProcessRecord => !!item)
      .map(publicProcess);
    if (cursor.eventSequence !== undefined && ids('events').length) {
      const next = s.eventsAfter(cursor.eventSequence, 200);
      result.events = next.events;
      result.cursor.eventSequence = next.eventSequence;
    }
    if (businessDeltas) {
      const rooms = [
        ...new Set([
          ...ids('conversation_reads'),
          ...changedMessages.map((message) => message.conversationId),
        ]),
      ];
      if (rooms.length) result.conversationUpdates = unreadConversationCounts(s, rooms);
      this.businessUpdates(
        result,
        tasks.filter((task) => changedTaskIds.has(task.id)),
        ids,
      );
    } else if (ids('messages').length) result.conversations = unreadConversationCounts(s);
    return result;
  }

  private businessUpdates(result: SnapshotDelta, tasks: Task[], ids: (table: string) => string[]) {
    const s = this.state.storage;
    const planIds = new Set([
      ...ids('task_plans'),
      ...tasks.flatMap((task) => [task.id, ...(task.planId ? [task.planId] : [])]),
    ]);
    const plans = [...planIds].flatMap((id) => {
      const plan = s.get<TaskPlanRecord>('task_plans', id);
      if (!plan) return [];
      const root = s.get<Task>('tasks', plan.taskId);
      const linked = s
        .byField<Task>('tasks', 'planId', plan.id)
        .filter((task) => task.id !== root?.id);
      return [
        taskPlanView(plan, root ? [root, ...linked] : linked, this.state.settings().mainBotId!),
      ];
    });
    if (plans.length) result.taskPlans = plans;
    const inputs = ids('deliveries')
      .map((id) => s.get<TaskInput>('deliveries', id))
      .filter((input): input is TaskInput => input?.kind === 'user-input');
    if (inputs.length) result.taskInputs = inputs;
  }
}
