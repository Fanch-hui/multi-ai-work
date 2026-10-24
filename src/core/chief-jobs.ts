import { randomUUID } from 'node:crypto';
import type { ChiefModelJob } from '../domain/chief-work.js';
import type { Conversation, Task } from '../domain/types.js';
import type { State } from './state.js';
import type { TaskService } from './tasks.js';
import { required } from './errors.js';

export const isChiefJob = (task: Pick<Task, 'kind'>) =>
  task.kind === 'chief-routing' || task.kind === 'chief-context-maintenance';

export class ChiefJobs {
  constructor(
    private state: State,
    private tasks: TaskService,
  ) {}
  queue(
    kind: 'chief-routing' | 'chief-context-maintenance',
    spec: ChiefModelJob,
    requestId: string,
  ): Task {
    const s = this.state.storage;
    return s.transaction(() => {
      const home = required(
        s.get<Conversation>('conversations', this.state.settings().mainConversationId!),
        '管家不存在',
      );
      const key = `chief-job-room:${home.id}`;
      let room = s.get<Conversation>('conversations', s.metadata<string>(key) ?? '');
      if (!room) {
        room = {
          ...home,
          id: randomUUID(),
          name: '管家上下文',
          chiefRole: 'router',
          chiefContextId: undefined,
          chiefHomeId: home.id,
          model: undefined,
          reasoning: undefined,
          createdAt: new Date().toISOString(),
        };
        s.put('conversations', room);
        s.setMetadata(key, room.id);
      }
      const task = this.tasks.create({
        conversationId: room.id,
        botId: home.chiefId!,
        goal: kind === 'chief-routing' ? '选择当前事项' : '整理工作上下文',
        kind,
        requestId,
      });
      s.setMetadata(`chief-model-job:${task.id}`, spec);
      return task;
    });
  }
}
