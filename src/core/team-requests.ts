import { z } from 'zod';
import type { Bot, Task } from '../domain/types.js';
import type { State } from './state.js';
import type { EntityService } from './entities.js';
import type { TeamService } from './team.js';
import type { Scheduler } from './scheduler.js';
import type { CoreConnections } from './core-connections.js';
import { terminal } from '../domain/task-status.js';
import { publicBot } from './chief.js';
import { required } from './errors.js';

export class TeamRequests {
  constructor(
    private state: State,
    private entities: EntityService,
    private team: TeamService,
    private scheduler: Scheduler,
    private connectionRequests: CoreConnections,
  ) {}

  async request(method: string, params: Record<string, unknown>): Promise<unknown> {
    const s = this.state.storage;
    const objectId = () => z.string().parse(params.id);
    switch (method) {
      case 'bots.save': {
        await this.connectionRequests.refreshBotContextCatalog(params.input);
        return publicBot(this.entities.saveBot(params.input), this.state.settings().mainBotId);
      }
      case 'chief.configure': {
        const current = s.get<Bot>('bots', this.state.settings().mainBotId!);
        await this.connectionRequests.refreshBotContextCatalog(params.input, current);
        return publicBot(
          this.team.configureChief(params.input, z.string().optional().parse(params.workspaceId)),
          this.state.settings().mainBotId,
        );
      }
      case 'chief.conversations.create':
        return this.team.createChiefConversation(
          z.string().trim().min(1).max(120).optional().parse(params.name),
          z
            .object({
              workspaceId: z.string().optional(),
              model: z.string().optional(),
              reasoning: z.string().optional(),
            })
            .parse(params),
        );
      case 'chief.conversations.update':
        return this.team.updateChiefConversation(
          objectId(),
          z
            .object({ model: z.string().optional(), reasoning: z.string().optional() })
            .parse(params),
        );
      case 'chief.conversations.catalog':
        return this.connectionRequests.chiefCatalog();
      case 'bots.clone':
        return this.entities.cloneBot(objectId());
      case 'bots.archive': {
        const bot = required(s.get<Bot>('bots', objectId()), '智能体不存在');
        if (bot.id === this.state.settings().mainBotId)
          throw new Error('主智能体需要保留，请调整其配置');
        for (const task of s
          .all<Task>('tasks')
          .filter((task) => task.botId === bot.id && !terminal(task.status)))
          await this.scheduler.cancel(task.id);
        s.put('bots', { ...bot, archived: true });
        this.state.syncMainTeam();
        break;
      }
      default:
        throw new Error('不支持的应用操作');
    }
    this.state.changed();
    return { ok: true };
  }
}
