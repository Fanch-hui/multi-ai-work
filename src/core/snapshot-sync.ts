import { randomUUID } from 'node:crypto';
import type { Message, ProcessRecord, Run, Task } from '../domain/types.js';
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

interface Change extends StorageChanges {
  version: number;
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
  changed(kind: StateChange) {
    const changes = this.state.storage.changes.take();
    if (changes.invalidated) this.epoch = randomUUID();
    const reset =
      kind === 'state' ||
      changes.reset ||
      [...changes.entities.keys()].some((table) => !supported.has(table));
    this.log.push({ ...changes, reset, version: ++this.version });
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
  delta(cursor: SnapshotCursor, conversationId?: string): SnapshotDelta {
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
    if (changes.some((change) => change.reset)) result.reset = true;
    const s = this.state.storage;
    if (cursor.eventSequence === undefined) {
      result.events = s.events();
      result.cursor.eventSequence = s.latestNonTextEventSequence();
    }
    if (!changes.length) return result;
    const ids = (table: string) => [
      ...new Set(changes.flatMap((change) => [...(change.entities.get(table) ?? [])])),
    ];
    result.messages = ids('messages')
      .map((id) => s.getMessage(id))
      .filter((item): item is Message => !!item && item.conversationId === conversationId);
    const runs = ids('runs')
      .map((id) => s.get<Run>('runs', id))
      .filter((item): item is Run => !!item);
    const eventRunIds = new Set([...ids('events'), ...ids('text_events')]);
    const eventRuns = [...eventRunIds]
      .map((id) => s.get<Run>('runs', id))
      .filter((item): item is Run => !!item);
    const taskIds = new Set([
      ...ids('tasks'),
      ...runs.map((run) => run.taskId),
      ...eventRuns.map((run) => run.taskId),
    ]);
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
    if (ids('messages').length) result.conversations = unreadConversationCounts(s);
    return result;
  }
}
