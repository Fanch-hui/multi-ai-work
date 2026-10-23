import { z } from 'zod';
import type {
  ComputerGrant,
  ComputerHostRequest,
  ComputerObservation,
  ComputerSession,
  ComputerSettings,
} from '../domain/computer.js';
import type { Bot, Task } from '../domain/types.js';
import type { ToolExecutionContext } from '../domain/tools.js';
import type { TaskWait } from '../domain/task-wait.js';
import { terminal } from '../domain/task-status.js';
import { required } from './errors.js';
import { id, type State } from './state.js';
import type { TaskWaitService } from './task-waits.js';

const identifier = z.string().min(1).max(200);
const bundleId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{1,250}$/);
const actionSchema = z
  .object({
    revision: identifier,
    action: z.enum(['click', 'fill', 'press', 'scroll']),
    ref: identifier.optional(),
    text: z.string().max(20000).optional(),
    key: z
      .enum([
        'Enter',
        'Tab',
        'Escape',
        'ArrowLeft',
        'ArrowRight',
        'ArrowDown',
        'ArrowUp',
        'Backspace',
        'Space',
        'Meta+A',
        'Meta+S',
        'Meta+F',
        'Meta+Z',
        'Meta+Shift+Z',
      ])
      .optional(),
    deltaY: z.number().int().min(-1200).max(1200).optional(),
  })
  .strict();

export class ComputerService {
  private session?: ComputerSession;
  private busy?: Promise<unknown>;
  private unsubscribe?: () => void;
  private revision?: string;
  constructor(
    readonly state: State,
    private host: ComputerHostRequest | undefined,
    private waits: TaskWaitService,
  ) {}
  settings(): ComputerSettings {
    return (
      this.state.storage.metadata<ComputerSettings>('computer-settings') ?? {
        enabled: false,
        grants: [],
      }
    );
  }
  start() {
    this.wakeWaiting();
    this.unsubscribe = this.state.subscribe((kind) => {
      if (kind !== 'state' || !this.session) return;
      const task = this.state.storage.get<Task>('tasks', this.session.taskId);
      if (
        !task ||
        terminal(task.status) ||
        !this.allowed(this.session.bundleId, this.session.botId)
      )
        void this.release().catch((error) => {
          this.state.storage.setMetadata('computer-release-error', String(error));
        });
    });
  }
  async reset() {
    await this.release();
    this.state.storage.setMetadata('computer-settings', { ...this.settings(), enabled: false });
    this.state.changed();
  }
  async close() {
    this.unsubscribe?.();
    await this.release();
  }
  async request(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    if (method === 'computer.settings') return this.settings();
    if (method === 'computer.capabilities' && !this.host)
      return {
        available: false,
        accessibility: false,
        screenCapture: false,
        guidance: '电脑操作需要桌面 App。',
      };
    if (method === 'computer.capabilities' || method === 'computer.apps') return this.call(method);
    if (method === 'computer.permissions')
      return this.call(method, {
        permission: z.enum(['accessibility', 'screenCapture']).parse(params.permission),
      });
    if (method === 'computer.configure') return this.configure(params.input);
    if (method === 'computer.session') return this.session ?? null;
    if (method === 'computer.takeover') return this.takeover();
    if (method === 'computer.resume') return this.resume();
    throw new Error('不支持的电脑操作');
  }
  async execute(
    name: string,
    args: Record<string, unknown>,
    context: ToolExecutionContext,
  ): Promise<unknown> {
    if (name === 'computer_apps') {
      this.authorize(context);
      const result = (await this.call('computer.apps')) as { apps: { bundleId: string }[] };
      return { apps: result.apps.filter((app) => this.allowed(app.bundleId, context.botId)) };
    }
    if (name === 'computer_observe') {
      const input = z
        .object({
          bundleId,
          windowId: z.number().int().positive().optional(),
          screenshot: z.boolean().default(false),
        })
        .strict()
        .parse(args);
      await this.acquire(input.bundleId, context);
      const result = (await this.perform(
        () => this.call('computer.observe', input),
        context,
      )) as ComputerObservation;
      this.revision = result.revision;
      const { screenshot, ...observation } = result;
      return {
        content: [
          { type: 'text', text: JSON.stringify(observation) },
          ...(screenshot ? [{ type: 'image', data: screenshot, mimeType: 'image/png' }] : []),
        ],
      };
    }
    this.authorize(context);
    const session = required(this.session, '请先观察获准应用');
    if (session.taskId !== context.task.id) throw new Error('电脑正在被其他任务使用');
    if (name === 'computer_handoff') {
      const reason = z.string().trim().min(1).max(2000).parse(args.reason);
      this.waits.create(context, {
        kind: 'computer-handoff',
        summary: reason,
        resourceId: session.id,
      });
      return this.takeover();
    }
    if (session.status !== 'active') throw new Error('电脑正在由用户接管，请等待交回');
    if (name !== 'computer_action') throw new Error('不支持的电脑工具');
    const input = actionSchema.parse(args);
    if (this.revision !== input.revision) throw new Error('请重新观察窗口后操作');
    if (
      !(await context.requestApproval(
        'computer_action',
        `操作 ${session.bundleId}：${input.action}`,
        input,
      ))
    )
      throw new Error('用户拒绝了电脑操作');
    this.authorize(context, session.bundleId);
    if (this.session?.status !== 'active' || this.revision !== input.revision)
      throw new Error('窗口状态已变化，请重新观察');
    this.revision = undefined;
    context.markDispatched?.();
    return this.perform(() => this.call('computer.action', input), context);
  }
  private allowed(app: string, bot: string) {
    const settings = this.settings();
    return (
      settings.enabled &&
      settings.grants.some((grant) => grant.bundleId === app && grant.allowedBotIds.includes(bot))
    );
  }
  private authorize(context: ToolExecutionContext, app?: string) {
    context.signal.throwIfAborted();
    context.assertAuthorized?.();
    const task = this.state.storage.get<Task>('tasks', context.task.id);
    const bot = this.state.storage.get<Bot>('bots', context.botId);
    if (
      !task ||
      terminal(task.status) ||
      !bot ||
      bot.archived ||
      !this.settings().enabled ||
      (app && !this.allowed(app, bot.id))
    )
      throw new Error('当前任务未获准操作此应用，请在电脑操作中授权');
  }
  private async acquire(app: string, context: ToolExecutionContext) {
    this.authorize(context, app);
    if (this.session && this.session.taskId !== context.task.id) {
      this.waits.create(context, {
        kind: 'computer-resource',
        summary: '等待共享电脑空闲',
        resourceId: 'desktop',
      });
      throw new Error('电脑正在被其他任务使用，此操作尚未执行');
    }
    if (this.session?.status === 'handoff') throw new Error('电脑正在由用户接管');
    if (this.busy) throw new Error('电脑正在执行上一项操作');
    this.session = {
      id: this.session?.id ?? id(),
      taskId: context.task.id,
      runId: context.runId,
      botId: context.botId,
      conversationId: context.conversation.id,
      bundleId: app,
      status: 'active',
    };
    this.state.changed();
  }
  private async configure(input: unknown) {
    const settings = z
      .object({
        enabled: z.boolean(),
        grants: z
          .array(
            z
              .object({
                bundleId,
                name: z.string().min(1).max(200),
                allowedBotIds: z.array(identifier).max(200),
              })
              .strict(),
          )
          .max(200),
      })
      .strict()
      .parse(input);
    const old = this.settings();
    let live: { apps: { bundleId: string; name: string }[] } = { apps: [] };
    if (
      settings.grants.some((grant) => !old.grants.some((item) => item.bundleId === grant.bundleId))
    )
      live = (await this.call('computer.apps')) as typeof live;
    for (const grant of settings.grants) {
      if (
        !live.apps.some((app) => app.bundleId === grant.bundleId) &&
        !old.grants.some((app) => app.bundleId === grant.bundleId)
      )
        throw new Error('请选择正在运行的应用');
      for (const botId of grant.allowedBotIds)
        if (!this.state.storage.get<Bot>('bots', botId)) throw new Error('授权成员不存在');
    }
    this.state.storage.setMetadata('computer-settings', {
      ...settings,
      grants: settings.grants.map(
        (grant): ComputerGrant => ({ ...grant, allowedBotIds: [...new Set(grant.allowedBotIds)] }),
      ),
    });
    this.state.changed();
    return this.settings();
  }
  private async perform<T>(operation: () => Promise<T>, context: ToolExecutionContext) {
    if (this.busy) throw new Error('电脑正在执行上一项操作');
    const abort = () => {
      void this.release().catch((error) => {
        this.state.storage.setMetadata('computer-release-error', String(error));
      });
    };
    this.authorize(context, this.session?.bundleId);
    context.signal.addEventListener('abort', abort, { once: true });
    const pending = operation();
    this.busy = pending;
    try {
      const result = await pending;
      this.authorize(context, this.session?.bundleId);
      if (!this.session || this.session.status !== 'active')
        throw new Error('电脑操作已暂停，请等待交回');
      return result;
    } finally {
      context.signal.removeEventListener('abort', abort);
      this.busy = undefined;
    }
  }
  private async takeover() {
    const current = required(this.session, '当前没有电脑任务');
    this.session = { ...current, status: 'handoff' };
    this.revision = undefined;
    const task = this.state.storage.get<Task>('tasks', current.taskId);
    if (task && !terminal(task.status))
      this.waits.create(
        {
          task,
          runId: current.runId,
          botId: current.botId,
          conversation: { id: current.conversationId },
        },
        { kind: 'computer-handoff', summary: '电脑正在由用户接管', resourceId: current.id },
      );
    await this.call('computer.release');
    this.state.changed();
    return this.session;
  }
  private async resume() {
    const current = required(this.session, '当前没有电脑任务');
    if (current.status !== 'handoff') throw new Error('电脑尚未被人工接管');
    if (!this.allowed(current.bundleId, current.botId)) throw new Error('此应用授权已撤销');
    this.session = { ...current, status: 'active' };
    this.revision = undefined;
    for (const wait of this.state.storage.all<TaskWait>('task_waits'))
      if (
        wait.kind === 'computer-handoff' &&
        wait.resourceId === current.id &&
        wait.status === 'pending'
      )
        this.waits.resume(wait.id);
    this.state.changed();
    return this.session;
  }
  private async release() {
    if (!this.session && !this.busy) return;
    this.session = undefined;
    this.revision = undefined;
    await this.call('computer.release');
    this.wakeWaiting();
    this.state.changed();
  }
  private wakeWaiting() {
    for (const wait of this.state.storage.all<TaskWait>('task_waits')) {
      if (wait.kind !== 'computer-resource' || wait.status !== 'pending') continue;
      const task = this.state.storage.get<Task>('tasks', wait.taskId);
      if (task?.status === 'waiting_input') this.waits.resourceAvailable(wait.id);
    }
  }
  private call(method: Parameters<ComputerHostRequest>[0], params?: Record<string, unknown>) {
    if (!this.host) throw new Error('电脑操作需要桌面 App');
    return this.host(method, params);
  }
}
