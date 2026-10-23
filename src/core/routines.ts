import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { Routine, RoutineOccurrence } from '../domain/routines.js';
import type { Conversation, Task } from '../domain/types.js';
import { required } from './errors.js';
import { id, now, type State } from './state.js';
import { terminal, type TaskService } from './tasks.js';
import type { TeamService } from './team.js';
import { routineInputSchema, routineReferences, validateRoutineInput } from './routines-input.js';
import { latestRoutineRun, nextRoutineRun } from './routines-time.js';
import { prepareRoutineInputs } from './routines-artifacts.js';

const key = (value: string) => createHash('sha256').update(value).digest('hex');

export class RoutineService {
  private timer?: ReturnType<typeof setInterval>;
  private canRun = () => true;
  constructor(
    private state: State,
    private tasks: TaskService,
    private team: TeamService,
    private clock: () => string = now,
  ) {}

  request(method: string, params: Record<string, unknown> = {}): unknown {
    if (method === 'routines.list') return this.state.storage.all<Routine>('routines');
    if (method === 'routines.save') return this.save(params.input);
    const routine = this.get(z.string().min(1).parse(params.id));
    if (method === 'routines.get') return routine;
    if (method === 'routines.setEnabled')
      return this.setEnabled(routine, z.boolean().parse(params.enabled));
    if (method === 'routines.runNow')
      return this.runNow(routine, z.string().min(1).max(200).parse(params.requestId));
    if (method === 'routines.history') {
      const limit = z.number().int().min(1).max(200).default(50).parse(params.limit);
      return this.occurrences(routine.id)
        .sort((a, b) => b.triggeredAt.localeCompare(a.triggeredAt))
        .slice(0, limit)
        .map((entry) => ({
          ...entry,
          task: entry.taskId ? this.state.storage.get<Task>('tasks', entry.taskId) : undefined,
        }));
    }
    throw new Error(`未知例行工作方法: ${method}`);
  }

  start(canRun: () => boolean = () => true) {
    this.close();
    this.canRun = canRun;
    this.timer = setInterval(() => this.tick(), 15_000);
    this.timer.unref();
    this.tick();
  }

  close() {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  tick() {
    if (!this.canRun()) return;
    const current = this.clock();
    for (const routine of this.state.storage.all<Routine>('routines')) {
      if (!routine.enabled || (!routine.nextRunAt && !routine.pendingAt)) continue;
      try {
        this.tickRoutine(routine, current);
      } catch (error) {
        this.state.storage.put('routines', {
          ...this.get(routine.id),
          enabled: false,
          error: error instanceof Error ? error.message : String(error),
          updatedAt: current,
        });
        this.state.changed();
      }
    }
  }

  pauseRestored() {
    this.state.storage.transaction(() => {
      for (const routine of this.state.storage.all<Routine>('routines'))
        this.state.storage.put('routines', {
          ...routine,
          enabled: false,
          pendingAt: undefined,
          error: '备份已恢复，请检查资料和连接后启用',
          updatedAt: this.clock(),
        });
    });
    this.state.changed();
  }

  private get(routineId: string) {
    return required(this.state.storage.get<Routine>('routines', routineId), '例行工作不存在');
  }

  private occurrences(routineId: string) {
    return this.state.storage
      .all<RoutineOccurrence>('routine_occurrences')
      .filter((entry) => entry.routineId === routineId);
  }

  private async save(input: unknown) {
    const fields = routineInputSchema.parse(input);
    validateRoutineInput(this.state, fields);
    const previous = fields.id ? this.get(fields.id) : undefined;
    if (
      previous &&
      (previous.botId !== fields.botId || previous.workspaceId !== fields.workspaceId)
    )
      throw new Error('更换负责人或工作区请新建例行工作');
    const current = this.clock();
    const inputs = await prepareRoutineInputs(this.state, fields.inputArtifactIds);
    try {
      const result = this.state.storage.transaction(() => {
        if (previous && this.get(previous.id).revision !== previous.revision)
          throw new Error('例行工作已更新，请刷新后重试');
        validateRoutineInput(this.state, fields);
        const conversationId = previous?.conversationId ?? this.createRoom(fields);
        const routine: Routine = {
          ...fields,
          id: previous?.id ?? id(),
          conversationId,
          inputArtifactIds: inputs.save(conversationId),
          revision: (previous?.revision ?? 0) + 1,
          nextRunAt: nextRoutineRun(fields.schedule, fields.timeZone, current),
          createdAt: previous?.createdAt ?? current,
          updatedAt: current,
        };
        if (fields.enabled && fields.schedule.kind === 'once' && !routine.nextRunAt)
          throw new Error('请选择未来的执行时间');
        this.state.storage.put('routines', routine);
        return routine;
      });
      this.state.changed();
      return result;
    } finally {
      await inputs.discard();
    }
  }

  private createRoom(input: z.infer<typeof routineInputSchema>) {
    if (input.botId === this.state.settings().mainBotId)
      return this.team.createChiefConversation(input.name, {
        workspaceId: input.workspaceId,
        selectAsMain: false,
      }).id;
    const room: Conversation = {
      id: id(),
      name: input.name,
      kind: 'private',
      memberIds: [input.botId],
      workspaceId: input.workspaceId,
      createdAt: this.clock(),
    };
    this.state.storage.put('conversations', room);
    return room.id;
  }

  private setEnabled(routine: Routine, enabled: boolean) {
    if (enabled) this.validate(routine);
    const current = this.clock();
    const updated: Routine = {
      ...routine,
      enabled,
      error: undefined,
      pendingAt: undefined,
      nextRunAt: enabled
        ? nextRoutineRun(routine.schedule, routine.timeZone, current)
        : routine.nextRunAt,
      updatedAt: current,
    };
    if (enabled && !updated.nextRunAt) throw new Error('一次性工作已过期，请编辑执行时间');
    this.state.storage.put('routines', updated);
    this.state.changed();
    return updated;
  }

  private validate(routine: Routine) {
    routineReferences(this.state, routine);
    const room = required(
      this.state.storage.get<Conversation>('conversations', routine.conversationId),
      '例行工作会话已删除',
    );
    if (room.archived || !room.memberIds.includes(routine.botId))
      throw new Error('例行工作会话已归档或负责人已移除');
    validateRoutineInput(this.state, routine);
  }

  private active(routine: Routine) {
    const roots = new Set(this.occurrences(routine.id).flatMap((entry) => entry.taskId ?? []));
    const tasks = this.state.storage.all<Task>('tasks');
    let changed = true;
    while (changed) {
      changed = false;
      for (const task of tasks)
        if (task.parentId && roots.has(task.parentId) && !roots.has(task.id)) {
          roots.add(task.id);
          changed = true;
        }
    }
    return tasks.some((task) => roots.has(task.id) && !terminal(task.status));
  }

  private runNow(routine: Routine, requestId: string) {
    const occurrenceId = key(`manual:${routine.id}:${requestId}`);
    const existing = this.state.storage.get<RoutineOccurrence>('routine_occurrences', occurrenceId);
    if (existing) return existing;
    if (!this.canRun()) throw new Error('应用正在维护，请稍后执行');
    if (this.active(routine)) throw new Error('此例行工作仍在执行，请等待或停止当前任务');
    this.validate(routine);
    const result = this.state.storage.transaction(() =>
      this.launch(routine, this.clock(), 'manual', occurrenceId),
    );
    this.state.changed();
    return result;
  }

  private tickRoutine(routine: Routine, current: string) {
    const due = routine.nextRunAt && routine.nextRunAt <= current;
    const latest = due
      ? latestRoutineRun(routine.schedule, routine.timeZone, routine.nextRunAt!, current)
      : undefined;
    const pendingAt = latest ?? routine.pendingAt;
    if (!pendingAt) return;
    this.validate(routine);
    this.state.storage.transaction(() => {
      const advanced = {
        ...routine,
        nextRunAt: due
          ? nextRoutineRun(routine.schedule, routine.timeZone, current)
          : routine.nextRunAt,
        pendingAt,
        updatedAt: current,
      };
      if (this.active(routine)) {
        this.state.storage.put('routines', advanced);
        return;
      }
      const occurrenceId = key(`schedule:${routine.id}:${routine.revision}:${pendingAt}`);
      const skipped =
        routine.missedRunPolicy === 'skip' && Date.parse(current) - Date.parse(pendingAt) > 60_000;
      if (skipped)
        this.state.storage.put('routine_occurrences', {
          id: occurrenceId,
          routineId: routine.id,
          revision: routine.revision,
          scheduledAt: pendingAt,
          triggeredAt: current,
          source: 'schedule',
          reason: '已按设置跳过错过的执行',
        } satisfies RoutineOccurrence);
      else this.launch(routine, pendingAt, 'schedule', occurrenceId);
      this.state.storage.put('routines', {
        ...advanced,
        enabled: routine.schedule.kind === 'once' ? false : routine.enabled,
        pendingAt: undefined,
        error: undefined,
      });
    });
    this.state.changed();
  }

  private launch(
    routine: Routine,
    scheduledAt: string,
    source: RoutineOccurrence['source'],
    occurrenceId: string,
  ) {
    const existing = this.state.storage.get<RoutineOccurrence>('routine_occurrences', occurrenceId);
    if (existing) return existing;
    const task = this.tasks.create({
      conversationId: routine.conversationId,
      botId: routine.botId,
      goal: routine.goal,
      expectedOutput: routine.expectedOutput,
      inputArtifactIds: routine.inputArtifactIds,
      requestId: `routine:${occurrenceId}`,
      trigger: {
        type: 'routine',
        routineId: routine.id,
        occurrenceId,
        automatic: source === 'schedule',
      },
    });
    const occurrence: RoutineOccurrence = {
      id: occurrenceId,
      routineId: routine.id,
      revision: routine.revision,
      scheduledAt,
      triggeredAt: this.clock(),
      taskId: task.id,
      source,
    };
    return this.state.storage.put('routine_occurrences', occurrence);
  }
}
