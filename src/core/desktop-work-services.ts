import type { ToolExecutionContext } from '../domain/tools.js';
import type { Vault } from '../security/vault.js';
import type { HostRequest } from './artifact-requests.js';
import type { State } from './state.js';
import type { TaskService } from './tasks.js';
import type { EntityService } from './entities.js';
import type { RoutineService } from './routines.js';
import type { TaskWaitService } from './task-waits.js';
import { WorkSkillService } from './work-skills.js';
import { BotTemplateService } from './bot-templates.js';
import { VoiceService } from './voice.js';
import { ComputerService } from './computer-service.js';
import { BrowserTeachingService } from './browser-teaching-service.js';
import { HostAccessService } from './host-access.js';
import { CollaborationRequests } from './collaboration-requests.js';

export class DesktopWorkServices {
  readonly skills: WorkSkillService;
  readonly templates: BotTemplateService;
  readonly voice: VoiceService;
  readonly computer: ComputerService;
  readonly teaching: BrowserTeachingService;
  readonly hostAccess: HostAccessService;
  readonly collaboration: CollaborationRequests;
  constructor(
    state: State,
    entities: EntityService,
    tasks: TaskService,
    routines: RoutineService,
    waits: TaskWaitService,
    vault: Vault,
    host: HostRequest | undefined,
    dispatch: (method: string, params: Record<string, unknown>) => Promise<unknown>,
  ) {
    this.skills = new WorkSkillService(state);
    this.templates = new BotTemplateService(state, entities, routines);
    this.voice = new VoiceService(state, vault);
    this.computer = new ComputerService(state, host, waits);
    this.teaching = new BrowserTeachingService(state, host);
    this.hostAccess = new HostAccessService(state, dispatch, host);
    this.collaboration = new CollaborationRequests(state, tasks);
  }
  extensions(): Pick<
    ToolExecutionContext,
    'saveWorkSkill' | 'executeComputer' | 'requestCollaboration' | 'resolveCollaboration'
  > {
    return {
      saveWorkSkill: async (args, context) => this.skills.execute(args, context),
      executeComputer: (name, args, context) => this.computer.execute(name, args, context),
      requestCollaboration: (args, context) => this.collaboration.create(args, context),
      resolveCollaboration: (args, context) => this.collaboration.resolve(args, context),
    };
  }
  start() {
    this.computer.start();
    this.collaboration.start();
  }
  handles(method: string) {
    return [
      'workSkills',
      'botTemplates',
      'voice',
      'computer',
      'teaching',
      'hostAccess',
      'collaboration',
    ].includes(method.split('.')[0]);
  }
  request(method: string, params: Record<string, unknown>): unknown {
    switch (method.split('.')[0]) {
      case 'workSkills':
        return this.skills.request(method, params);
      case 'botTemplates':
        return this.templates.request(method, params);
      case 'voice':
        return this.voice.request(method, params);
      case 'computer':
        return this.computer.request(method, params);
      case 'teaching':
        return this.teaching.request(method, params);
      case 'hostAccess':
        return this.hostAccess.request(method, params);
      case 'collaboration':
        return this.collaboration.request(method, params);
      default:
        throw new Error('不支持的工作操作');
    }
  }
  async stopInputs() {
    this.collaboration.close();
    this.voice.close();
    await this.hostAccess.close();
  }
  async close() {
    await this.teaching.close();
    await this.computer.close();
  }
  async resetAfterRestore() {
    await this.hostAccess.resetAfterRestore();
    await this.computer.reset();
  }
}
