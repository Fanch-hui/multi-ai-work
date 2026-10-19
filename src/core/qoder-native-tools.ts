import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { NativeTools } from '../domain/provider.js';
import type { Bot, Connection, Task, Workspace } from '../domain/types.js';
import type { ToolExecutionContext } from '../domain/tools.js';
import { enabledQoderServices } from '../domain/qoder-services.js';
import { publicUrl } from '../tools/web.js';
import { workspacePath } from '../tools/paths.js';
import { publicError } from './errors.js';
import { type State, id, now } from './state.js';
import { qoderImageResult, qoderPublicResult } from './qoder-native-results.js';

const domains = z.array(z.string().min(1).max(253)).max(20).optional();
const schemas: Record<string, z.ZodType<Record<string, unknown>>> = {
  WebSearch: z
    .object({
      query: z.string().min(1).max(2000),
      allowed_domains: domains,
      blocked_domains: domains,
    })
    .strict(),
  WebFetch: z
    .object({ url: z.string().url().max(8000), prompt: z.string().min(1).max(12000) })
    .strict(),
  ImageSearch: z
    .object({
      query: z.string().min(1).max(2000),
      count: z.number().int().min(1).max(10).optional(),
    })
    .strict(),
  ImageGen: z
    .object({
      name: z.string().min(1).max(200),
      prompt: z.string().min(1).max(20000),
      size: z.string().max(80).optional(),
    })
    .strict(),
};
type Operation = {
  id: string;
  runId: string;
  name: string;
  fingerprint: string;
  status: 'prepared' | 'dispatched' | 'succeeded' | 'failed' | 'unknown';
  result?: unknown;
  error?: string;
};
type Pending = { operation: Operation; release?: () => void };
const labels: Record<string, string> = {
  WebSearch: '网页搜索',
  WebFetch: '网页读取',
  ImageSearch: '图片搜索',
  ImageGen: '图片生成',
};

export class QoderNativeTools implements NativeTools {
  readonly names: string[];
  private pending = new Map<string, Pending>();
  private abort = () => this.close('Qoder 原生服务已取消');
  constructor(
    private state: State,
    private context: ToolExecutionContext,
    private bot: Bot,
    private acquireWrite: () => Promise<() => void>,
  ) {
    this.names = enabledQoderServices(bot).filter((name) => name !== 'SecurityScan');
    context.signal.addEventListener('abort', this.abort, { once: true });
  }

  private check(name: string) {
    this.context.signal.throwIfAborted();
    const current = this.state.storage.get<Bot>('bots', this.bot.id);
    const connection =
      current && this.state.storage.get<Connection>('connections', current.connectionId);
    if (
      !current ||
      current.archived ||
      current.connectionId !== this.bot.connectionId ||
      connection?.provider !== 'qoder' ||
      !enabledQoderServices(current).some((service) => service === name)
    )
      throw new Error(`当前未授权 Qoder ${labels[name] ?? name}`);
    if (
      name === 'ImageGen' &&
      (!this.context.workspace.writable ||
        !this.state.storage.get<Workspace>('workspaces', this.context.workspace.id)?.writable)
    )
      throw new Error('图片生成需要可写工作目录');
  }

  async authorize(name: string, args: Record<string, unknown>, callId: string) {
    this.check(name);
    const input = schemas[name]?.parse(args);
    if (!input || !callId) throw new Error('Qoder 原生工具调用无效');
    if (name === 'WebFetch') await publicUrl(String(input.url));
    if (name === 'ImageGen') await workspacePath('vibe_images', this.context, true);
    const fingerprint = createHash('sha256')
      .update(JSON.stringify({ name, args: input }))
      .digest('hex');
    const operationId = `${this.context.runId}:${callId}`;
    const old = this.state.storage.get<Operation>('tool_operations', operationId);
    if (old) {
      if (old.fingerprint !== fingerprint || old.name !== name)
        throw new Error('原生工具调用 ID 与参数不匹配');
      if (!this.pending.has(callId)) throw new Error('原生工具已有执行记录，请先核查结果');
      return input;
    }
    const operation: Operation = {
      id: operationId,
      runId: this.context.runId,
      name,
      fingerprint,
      status: 'prepared',
    };
    this.pending.set(callId, { operation });
    this.state.storage.put('tool_operations', operation);
    this.event(name, callId, 'running', input);
    try {
      if (
        name === 'ImageGen' &&
        !(await this.context.requestApproval(name, `Qoder 生成图片：${input.name}`, input))
      )
        throw new Error('图片生成未获批准');
      this.check(name);
      if (name === 'ImageGen') {
        const release = await this.acquireWrite();
        const pending = this.pending.get(callId);
        if (!pending) {
          release();
          this.context.signal.throwIfAborted();
          throw new Error('图片生成已停止');
        }
        pending.release = release;
      }
      this.check(name);
      operation.status = 'dispatched';
      this.state.storage.put('tool_operations', operation);
      return input;
    } catch (error) {
      this.fail(name, callId, publicError(error));
      throw error;
    }
  }

  async complete(name: string, _args: Record<string, unknown>, callId: string, rawResult: unknown) {
    const pending = this.pending.get(callId);
    if (!pending || pending.operation.name !== name)
      throw new Error('Qoder 原生结果没有对应的已授权调用');
    try {
      this.context.signal.throwIfAborted();
      const value = rawResult as { isError?: boolean; error?: unknown } | null;
      if (value?.isError || value?.error)
        throw new Error(typeof value.error === 'string' ? value.error : 'Qoder 原生服务返回错误');
      const result =
        name === 'ImageGen'
          ? await qoderImageResult(rawResult, this.context, this.state.dataDirectory)
          : qoderPublicResult(rawResult);
      this.state.storage.put('tool_operations', {
        ...pending.operation,
        status: 'succeeded',
        result,
      });
      this.event(name, callId, 'completed');
      this.finish(callId);
      return result;
    } catch (error) {
      this.fail(name, callId, publicError(error));
      throw error;
    }
  }

  fail(name: string, callId: string, error: string) {
    const pending = this.pending.get(callId);
    if (!pending || pending.operation.name !== name) return;
    const unknown =
      name === 'ImageGen' &&
      pending.operation.status === 'dispatched' &&
      (this.context.signal.aborted ||
        /未确认|结果未知|ECONNRESET|ETIMEDOUT|timeout|timed out|断开/i.test(error));
    this.state.storage.put('tool_operations', {
      ...pending.operation,
      status: unknown ? 'unknown' : 'failed',
      error: publicError(error),
    });
    if (unknown && name === 'ImageGen') {
      const task = this.state.storage.get<Task>('tasks', this.context.task.id);
      if (task) this.state.storage.put('tasks', { ...task, reconciliationRequired: true });
    }
    this.event(name, callId, 'failed', undefined, publicError(error));
    this.finish(callId);
  }

  assertSettled() {
    if (this.pending.size) {
      this.close('Qoder 原生服务未确认最终结果');
      throw new Error('Qoder 原生服务未确认最终结果');
    }
  }
  close(reason = 'Qoder 原生服务未确认最终结果') {
    this.context.signal.removeEventListener('abort', this.abort);
    for (const [callId, pending] of this.pending) this.fail(pending.operation.name, callId, reason);
  }
  private finish(callId: string) {
    this.pending.get(callId)?.release?.();
    this.pending.delete(callId);
  }
  private event(
    name: string,
    callId: string,
    status: string,
    args?: Record<string, unknown>,
    error?: string,
  ) {
    const detail = args?.query ?? args?.name;
    this.state.storage.event({
      id: id(),
      runId: this.context.runId,
      type: 'tool',
      createdAt: now(),
      data: {
        name,
        callId,
        status,
        source: 'native',
        service: 'Qoder',
        summary: `Qoder ${labels[name] ?? name}${detail ? ` · ${String(detail).slice(0, 180)}` : ''}`,
        ...(error ? { error } : {}),
      },
    });
    this.state.changed();
  }
}
