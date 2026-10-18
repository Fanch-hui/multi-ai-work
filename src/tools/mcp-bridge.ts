import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { ToolExecutionContext } from '../domain/tools.js';
import { workspacePath } from './paths.js';

interface BridgeReceipt {
  requestId: string; tool: string; state: 'pending' | 'completed' | 'unknown';
  version?: 2; taskId?: string; connectionId?: string; argumentsHash?: string;
  remoteTaskIds?: string[]; result?: unknown; updatedAt: string;
}

interface BridgeCall {
  connectionId: string; toolName: string; args: Record<string, unknown>; context: ToolExecutionContext;
  acceptsRequestId: boolean;
  validate(args: Record<string, unknown>): void;
  invoke(args: Record<string, unknown>): Promise<unknown>;
}

const hash = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical((value as Record<string, unknown>)[key])]));
}

export class BridgeMutations {
  private active = new Map<string, { argumentsHash: string; operation: Promise<unknown> }>();

  async call(input: BridgeCall): Promise<unknown> {
    const { connectionId, toolName, args, context } = input;
    const explicitId = typeof args.client_request_id === 'string' && args.client_request_id.trim() ? args.client_request_id.trim() : undefined;
    const requestId = explicitId ?? hash([context.task.id, connectionId, toolName, context.callId ?? args]);
    const receiptId = hash([context.task.id, connectionId, toolName, requestId]);
    const remoteArgs = input.acceptsRequestId ? { ...args, client_request_id: requestId } : args;
    input.validate(remoteArgs);
    context.signal.throwIfAborted(); context.assertAuthorized?.();
    const argumentsHash = hash(canonical(remoteArgs));
    const activeKey = hash([path.resolve(context.workspace.path), receiptId]);
    const active = this.active.get(activeKey);
    if (active) {
      this.assertArguments(active.argumentsHash, argumentsHash);
      return active.operation;
    }
    const operation = this.submit(input, requestId, receiptId, argumentsHash, remoteArgs, !explicitId);
    this.active.set(activeKey, { argumentsHash, operation });
    try { return await operation; } finally { this.active.delete(activeKey); }
  }

  private assertArguments(previous: string | undefined, current: string): void {
    if (previous && previous !== current) throw new Error('Bridge 同一请求 ID 的参数已变化，请使用新的请求 ID');
  }

  private async submit(input: BridgeCall, requestId: string, receiptId: string, argumentsHash: string,
    remoteArgs: Record<string, unknown>, generatedId: boolean): Promise<unknown> {
    const { context, connectionId, toolName } = input;
    const directory = await workspacePath('.ai-team/bridge', context, true);
    const receiptPath = path.join(directory, `${receiptId}.json`);
    let previous = await readReceipt(receiptPath);
    // Only generated legacy IDs encode the task, connection and tool scope.
    if (!previous && generatedId) previous = await readReceipt(path.join(directory, `${requestId}.json`));
    if (!previous && !generatedId && /^[A-Za-z0-9._-]+$/.test(requestId)) {
      const legacy = await readReceipt(path.join(directory, `${requestId}.json`));
      if (legacy) throw new Error('Bridge 旧版显式请求回执缺少作用域，请使用远端查询工具对账，禁止重复提交');
    }
    if (previous) {
      if (previous.requestId !== requestId || previous.tool !== toolName || (previous.version === 2
        && (previous.taskId !== context.task.id || previous.connectionId !== connectionId))) throw new Error('Bridge 回执与当前请求不匹配');
      this.assertArguments(previous.argumentsHash, argumentsHash);
      if (previous.state === 'completed') {
        if (!previous.argumentsHash) await saveReceipt(receiptPath, { ...previous, version: 2, taskId: context.task.id, connectionId, argumentsHash });
        return { clientRequestId: requestId, remoteTaskIds: previous.remoteTaskIds, result: previous.result, reused: true };
      }
      throw new Error(`Bridge 请求 ${requestId} 结果未知，请使用远端查询工具对账，禁止重复提交`);
    }
    context.signal.throwIfAborted(); context.assertAuthorized?.();
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const receipt: BridgeReceipt = { version: 2, requestId, taskId: context.task.id, connectionId, tool: toolName,
      argumentsHash, state: 'pending', updatedAt: new Date().toISOString() };
    await saveReceipt(receiptPath, receipt);
    context.signal.throwIfAborted(); context.assertAuthorized?.(); context.markDispatched?.();
    try {
      const result = await input.invoke(remoteArgs);
      receipt.state = 'completed'; receipt.remoteTaskIds = extractTaskIds(result); receipt.result = result;
      await saveReceipt(receiptPath, receipt);
      return { clientRequestId: requestId, remoteTaskIds: receipt.remoteTaskIds, result };
    } catch (error) { receipt.state = 'unknown'; await saveReceipt(receiptPath, receipt); throw error; }
  }
}

async function readReceipt(target: string): Promise<BridgeReceipt | undefined> {
  try { return JSON.parse(await readFile(target, 'utf8')) as BridgeReceipt; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; return undefined; }
}

async function saveReceipt(target: string, receipt: BridgeReceipt): Promise<void> {
  const temporary = `${target}.tmp`;
  await writeFile(temporary, JSON.stringify({ ...receipt, updatedAt: new Date().toISOString() }), { mode: 0o600 });
  await rename(temporary, target);
}

function extractTaskIds(value: unknown): string[] {
  const result = new Set<string>();
  const visit = (item: unknown): void => {
    if (typeof item === 'string') { try { visit(JSON.parse(item)); } catch { /* Plain result text. */ } return; }
    if (!item || typeof item !== 'object') return;
    for (const [key, entry] of Object.entries(item)) {
      if (/^(task_?id|remoteTaskId)$/i.test(key) && typeof entry === 'string') result.add(entry);
      else visit(entry);
    }
  };
  visit(value); return [...result];
}
