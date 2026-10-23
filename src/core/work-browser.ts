import { z } from 'zod';
import { join } from 'node:path';
import { mkdir, rm } from 'node:fs/promises';
import type {
  BrowserProfile,
  BrowserSession,
  BrowserHostInput,
  BrowserHostMethod,
} from '../domain/work-browser.js';
import type { ToolExecutionContext } from '../domain/tools.js';
import type { Bot, Task, Run } from '../domain/types.js';
import type { TaskWait } from '../domain/task-wait.js';
import type { HostRequest } from './artifact-requests.js';
import type { TaskWaitService } from './task-waits.js';
import { State, id, now } from './state.js';
import { required } from './errors.js';
import { terminal } from '../domain/task-status.js';
import { BrowserOperations } from './work-browser-operations.js';

const identifier = z.string().min(1).max(200);

export class BrowserService {
  private operations: BrowserOperations;
  private unsubscribe?: () => void;
  private cleanup?: Promise<void>;
  private cleaning = false;
  private closing = false;
  private observed = '';

  private version() {
    return (['tasks', 'runs', 'browser_sessions'] as const)
      .map((table) => this.state.storage.tableVersion(table))
      .join(':');
  }
  private busy = new Map<string, Promise<unknown>>();

  constructor(
    readonly state: State,
    private host: HostRequest | undefined,
    readonly waits: TaskWaitService,
  ) {
    this.operations = new BrowserOperations(this);
  }

  start() {
    if (!this.host) return;
    this.unsubscribe = this.state.subscribe((kind) => {
      if (
        kind !== 'state' ||
        this.cleaning ||
        this.closing ||
        this.cleanup ||
        this.observed === this.version()
      )
        return;
      this.observed = this.version();
      this.cleanup = Promise.resolve()
        .then(() => this.releaseFinished())
        .finally(() => {
          this.cleanup = undefined;
        });
      void this.cleanup.catch((error) => {
        this.state.storage.setMetadata('browser-cleanup-error', String(error));
      });
    });
  }

  async close() {
    this.closing = true;
    this.unsubscribe?.();
    await this.cleanup;
    await Promise.allSettled([...this.busy.values()]);
    if (this.host)
      for (const session of this.sessions())
        await this.call('browser.close', { sessionId: session.id });
  }

  async reset() {
    await this.cleanup;
    for (const session of this.sessions()) await this.release(session);
  }

  sessions() {
    return this.state.storage
      .all<BrowserSession>('browser_sessions')
      .filter((s) => s.status !== 'closed');
  }

  async request(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (method === 'browser.available') return { available: !!this.host };
    if (method === 'browser.profiles')
      return this.state.storage.all<BrowserProfile>('browser_profiles');
    if (method === 'browser.saveProfile') return this.saveProfile(params.input);
    if (method === 'browser.sessions')
      return this.sessions().filter(
        (s) =>
          !params.conversationId ||
          s.conversationId === params.conversationId ||
          s.purpose === 'setup',
      );
    if (method === 'browser.profileOpen') return this.setup(identifier.parse(params.profileId));
    const session = required(
      this.state.storage.get<BrowserSession>('browser_sessions', identifier.parse(params.id)),
      '浏览器会话不存在',
    );
    if (session.status === 'closed') throw new Error('浏览器会话已经结束');
    if (method === 'browser.takeover') return this.takeover(session);
    if (method === 'browser.resume') return this.resume(session);
    if (method === 'browser.userTabs') {
      if (session.status !== 'handoff') throw new Error('请先接管浏览器');
      await this.ensureHost(session);
      return this.call('browser.tabs', {
        sessionId: session.id,
        operation: z.enum(['list', 'select', 'close']).parse(params.operation ?? 'list'),
        tabId: params.tabId === undefined ? undefined : identifier.parse(params.tabId),
      });
    }
    if (method === 'browser.closeSession') {
      const task = session.taskId && this.state.storage.get<Task>('tasks', session.taskId);
      if (task && !terminal(task.status)) throw new Error('请先停止任务，或交回浏览器继续工作');
      return this.release(session);
    }
    if (method === 'browser.navigate') {
      if (session.status !== 'handoff') throw new Error('请先接管浏览器');
      const url = z.url({ protocol: /^https?$/ }).parse(params.url);
      await this.ensureHost(session);
      await this.call('browser.interactive', { sessionId: session.id, interactive: false });
      try {
        return await this.call('browser.open', {
          sessionId: session.id,
          profileId: session.profileId,
          url,
        });
      } finally {
        await this.call('browser.interactive', { sessionId: session.id, interactive: true });
      }
    }
    if (method === 'browser.present') {
      const input = z
        .object({
          visible: z.boolean(),
          bounds: z
            .object({
              x: z.number().finite(),
              y: z.number().finite(),
              width: z.number().min(1).max(10000),
              height: z.number().min(1).max(10000),
            })
            .optional(),
        })
        .parse(params);
      await this.ensureHost(session);
      return this.call('browser.present', { sessionId: session.id, ...input });
    }
    throw new Error('不支持的浏览器操作');
  }

  execute(name: string, args: Record<string, unknown>, context: ToolExecutionContext) {
    return this.operations.execute(name, args, context);
  }

  authorize(profileId: string, context: ToolExecutionContext) {
    context.signal.throwIfAborted();
    context.assertAuthorized?.();
    const profile = required(
      this.state.storage.get<BrowserProfile>('browser_profiles', profileId),
      '浏览器配置不存在',
    );
    const bot = this.state.storage.get<Bot>('bots', context.botId);
    const task = this.state.storage.get<Task>('tasks', context.task.id);
    if (
      !profile.allowedBotIds.includes(context.botId) ||
      !bot ||
      bot.archived ||
      !task ||
      terminal(task.status)
    )
      throw new Error('当前任务未获准使用此浏览器配置');
    return profile;
  }

  async acquire(profileId: string, context: ToolExecutionContext) {
    this.authorize(profileId, context);
    await this.releaseFinished();
    const current = this.sessions().find((s) => s.profileId === profileId);
    if (current && current.taskId !== context.task.id) {
      this.waits.create(context, {
        kind: 'browser-resource',
        summary: '等待工作浏览器空闲',
        resourceId: profileId,
      });
      throw new Error('浏览器正在被其他任务或人工使用，此操作尚未执行');
    }
    const session: BrowserSession = current ?? {
      id: id(),
      profileId,
      taskId: context.task.id,
      botId: context.botId,
      conversationId: context.conversation.id,
      purpose: 'task',
      status: 'active',
      createdAt: now(),
    };
    if (!current) this.save(session);
    await this.perform(session, () => this.ensureHost(session), context.signal);
    return session;
  }

  async ensureHost(session: BrowserSession) {
    const downloadDirectory = this.downloadDirectory(session.id);
    await mkdir(downloadDirectory, { recursive: true });
    await this.call('browser.open', {
      sessionId: session.id,
      profileId: session.profileId,
      downloadDirectory,
    });
    if (session.status === 'handoff')
      await this.call('browser.interactive', { sessionId: session.id, interactive: true });
  }

  downloadDirectory(sessionId: string) {
    return join(this.state.dataDirectory, 'browser-downloads', sessionId);
  }

  async perform<T>(
    session: BrowserSession,
    action: () => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    if (this.busy.has(session.id)) throw new Error('浏览器正在处理上一项操作，请等待完成');
    signal?.throwIfAborted();
    let cancellation: Promise<unknown> | undefined;
    const abort = () => {
      this.save({ ...session, status: 'closed' });
      cancellation = this.call('browser.close', { sessionId: session.id });
      void cancellation.catch(() => {});
    };
    signal?.addEventListener('abort', abort, { once: true });
    const operation = action();
    this.busy.set(session.id, operation);
    try {
      return await operation;
    } finally {
      signal?.removeEventListener('abort', abort);
      try {
        await cancellation;
      } finally {
        this.busy.delete(session.id);
        if (signal?.aborted) await this.release(session);
      }
    }
  }

  call(method: BrowserHostMethod, input: BrowserHostInput) {
    if (!this.host) throw new Error('工作浏览器需要桌面应用');
    return this.host(method, { ...input });
  }

  save(session: BrowserSession) {
    this.state.storage.put('browser_sessions', session);
    this.state.changed();
    return session;
  }

  async handoff(session: BrowserSession, context: ToolExecutionContext, reason: string) {
    this.waits.create(context, {
      kind: 'browser-handoff',
      summary: reason,
      resourceId: session.id,
    });
    return this.takeover(session, reason);
  }

  private saveProfile(input: unknown) {
    const fields = z
      .object({
        id: identifier.optional(),
        name: z.string().trim().min(1).max(100),
        allowedBotIds: z.array(identifier).max(100),
      })
      .strict()
      .parse(input);
    const old = fields.id
      ? required(
          this.state.storage.get<BrowserProfile>('browser_profiles', fields.id),
          '配置不存在',
        )
      : undefined;
    for (const botId of fields.allowedBotIds)
      if (
        !this.state.storage.get<Bot>('bots', botId) ||
        this.state.storage.get<Bot>('bots', botId)?.archived
      )
        throw new Error('授权成员不存在');
    const profile: BrowserProfile = {
      ...fields,
      id: old?.id ?? id(),
      allowedBotIds: [...new Set(fields.allowedBotIds)],
      createdAt: old?.createdAt ?? now(),
    };
    this.state.storage.put('browser_profiles', profile);
    this.state.changed();
    return profile;
  }

  private async setup(profileId: string) {
    required(
      this.state.storage.get<BrowserProfile>('browser_profiles', profileId),
      '浏览器配置不存在',
    );
    const old = this.sessions().find((s) => s.profileId === profileId);
    if (old) return this.takeover(old);
    const session = this.save({
      id: id(),
      profileId,
      purpose: 'setup',
      status: 'handoff',
      createdAt: now(),
    });
    await this.ensureHost(session);
    return session;
  }

  private async takeover(session: BrowserSession, reason = '工作浏览器正在由用户接管') {
    const updated = this.save({ ...session, status: 'handoff', reason });
    if (session.taskId && session.botId && session.conversationId) {
      const task = this.state.storage.get<Task>('tasks', session.taskId);
      const runId = task?.runIds.at(-1);
      if (task && runId && !terminal(task.status))
        this.waits.create(
          { task, runId, botId: session.botId, conversation: { id: session.conversationId } },
          { kind: 'browser-handoff', summary: reason, resourceId: session.id },
        );
    }
    await this.busy.get(session.id);
    await this.ensureHost(updated);
    return updated;
  }

  private async resume(session: BrowserSession) {
    if (session.purpose === 'setup') return this.release(session);
    await this.ensureHost(session);
    await this.call('browser.interactive', { sessionId: session.id, interactive: false });
    const updated = this.save({ ...session, status: 'active', reason: undefined });
    for (const wait of this.state.storage.all<TaskWait>('task_waits'))
      if (
        wait.resourceId === session.id &&
        wait.kind === 'browser-handoff' &&
        wait.status === 'pending'
      )
        this.waits.resume(wait.id);
    return updated;
  }

  async release(session: BrowserSession) {
    await this.busy.get(session.id);
    await this.call('browser.close', { sessionId: session.id });
    this.save({ ...session, status: 'closed' });
    this.state.storage.setMetadata(`browser-downloads:${session.id}`, {});
    await rm(this.downloadDirectory(session.id), { recursive: true, force: true });
    for (const wait of this.state.storage.all<TaskWait>('task_waits')) {
      if (
        wait.kind !== 'browser-resource' ||
        wait.resourceId !== session.profileId ||
        wait.status !== 'pending'
      )
        continue;
      const task = this.state.storage.get<Task>('tasks', wait.taskId);
      if (task && task.status === 'waiting_input') this.waits.resourceAvailable(wait.id);
    }
    return { closed: true };
  }

  private async releaseFinished() {
    if (this.cleaning) return;
    this.cleaning = true;
    try {
      for (const session of this.sessions()) {
        if (!session.taskId) continue;
        const task = this.state.storage.get<Task>('tasks', session.taskId);
        const run = task?.runIds.at(-1)
          ? this.state.storage.get<Run>('runs', task.runIds.at(-1)!)
          : undefined;
        if ((!task || terminal(task.status)) && (!run || run.endedAt)) await this.release(session);
      }
    } finally {
      this.cleaning = false;
    }
  }
}
