import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import Ajv from 'ajv';
import type { ToolConnection } from '../domain/types.js';
import type { ToolExecutionContext } from '../domain/tools.js';
import type { ToolDefinition } from '../domain/provider.js';
import { workspacePath } from './paths.js';
import { remoteToolAlias, type McpCatalogDiagnostic, type McpToolTarget } from './mcp-catalog.js';

type RemoteTool = Awaited<ReturnType<Client['listTools']>>['tools'][number];
type Session = { client: Client; tools: RemoteTool[]; signature: string; closed: boolean; revision: number; loadedRevision: number; stderr: string; secret?: string; refresh?: Promise<void> };
interface BridgeReceipt { requestId: string; tool: string; state: 'pending' | 'completed' | 'unknown'; remoteTaskIds?: string[]; result?: unknown; updatedAt: string; }
const MAX_STDERR_CHARS = 4096;
const schemaValidator = new Ajv({ strict: false, allErrors: true });

export class McpConnections {
  private sessions = new Map<string, Promise<Session>>();
  private activeSessions = new Map<string, Session>();
  private queues = new Map<string, Promise<void>>();
  private mutations = new Map<string, Promise<unknown>>();
  private aliases = new Map<string, McpToolTarget>();
  private catalogErrors = new Map<string, McpCatalogDiagnostic>();
  private closing?: Promise<void>;

  private signature(connection: ToolConnection, secret: string | undefined): string {
    return JSON.stringify([connection.transport, connection.url, connection.command, connection.args, connection.secretRef, secret]);
  }

  private async connect(connection: ToolConnection, getSecret: ToolExecutionContext['getSecret']): Promise<Session> {
    if (this.closing) throw new Error('MCP 连接服务已关闭');
    if (!this.queues.has(connection.id)) {
      const active = this.activeSessions.get(connection.id);
      if (active && !active.closed && !active.refresh && active.loadedRevision === active.revision) {
        const secret = await getSecret(connection.secretRef);
        const signature = this.signature(connection, secret);
        if (!this.closing && !this.queues.has(connection.id) && this.activeSessions.get(connection.id) === active
          && !active.closed && !active.refresh && active.loadedRevision === active.revision && active.signature === signature) {
          return active;
        }
      }
    }
    return this.serial(connection.id, () => this.connectSerial(connection, getSecret));
  }

  private serial<T>(id: string, operation: () => Promise<T>): Promise<T> {
    const pending = (this.queues.get(id) ?? Promise.resolve()).then(operation);
    const tail = pending.then(() => undefined, () => undefined);
    this.queues.set(id, tail);
    void tail.then(() => { if (this.queues.get(id) === tail) this.queues.delete(id); });
    return pending;
  }

  private async connectSerial(connection: ToolConnection, getSecret: ToolExecutionContext['getSecret']): Promise<Session> {
    if (this.closing) throw new Error('MCP 连接服务已关闭');
    const secret = await getSecret(connection.secretRef);
    const signature = this.signature(connection, secret);
    const existing = this.sessions.get(connection.id);
    if (existing) {
      const session = await existing;
      if (session.signature === signature && !session.closed) {
        await this.refresh(session); return session;
      }
      session.closed = true; session.stderr = '';
      this.activeSessions.delete(connection.id);
      await session.client.close(); this.sessions.delete(connection.id);
      this.clearCatalog(connection.id);
    }
    const pending = this.open(connection, secret, signature);
    this.sessions.set(connection.id, pending);
    try {
      const session = await pending;
      if (!session.closed) this.activeSessions.set(connection.id, session);
      return session;
    } catch (error) {
      this.activeSessions.delete(connection.id);
      this.sessions.delete(connection.id);
      throw error;
    }
  }

  private async open(connection: ToolConnection, secret: string | undefined, signature: string): Promise<Session> {
    const client = new Client({ name: 'ai-team', version: '0.1.0' });
    const session: Session = { client, tools: [], signature, closed: false, revision: 0, loadedRevision: -1, stderr: '', secret };
    client.onclose = () => {
      session.closed = true;
      if (this.activeSessions.get(connection.id) === session) this.activeSessions.delete(connection.id);
    };
    client.setNotificationHandler(ToolListChangedNotificationSchema, () => { session.revision++; });
    try {
      if (connection.transport === 'stdio') {
        if (!connection.command) throw new Error('MCP 缺少启动命令');
        const transport = new StdioClientTransport({ command: connection.command, args: connection.args ?? [], stderr: 'pipe',
          env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', SystemRoot: process.env.SystemRoot ?? '', ...(secret ? { MCP_API_KEY: secret } : {}) } });
        transport.stderr?.on('data', (chunk: Buffer | string) => {
          const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
          session.stderr = (session.stderr + text).slice(-MAX_STDERR_CHARS);
        });
        await client.connect(transport);
      } else {
        if (!connection.url) throw new Error('MCP 缺少服务地址');
        const url = new URL(connection.url);
        if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error('MCP 服务地址不合法');
        if (secret && url.protocol !== 'https:' && !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) throw new Error('远程凭据连接需要 HTTPS');
        await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers: secret ? { Authorization: `Bearer ${secret}` } : {}, redirect: 'error' } }));
      }
      await this.refresh(session);
      return session;
    } catch (error) { await client.close().catch(() => undefined); throw attachStderr(error, session); }
  }

  private async refresh(session: Session, force = false): Promise<void> {
    if (session.refresh) {
      await session.refresh;
      if (!force && session.loadedRevision === session.revision) return;
    }
    if (!force && session.loadedRevision === session.revision) return;
    const revision = session.revision;
    const pending = (async () => {
      const tools: RemoteTool[] = [];
      let cursor: string | undefined;
      do {
        const result = await session.client.listTools(cursor ? { cursor } : undefined, { timeout: 15_000 });
        tools.push(...result.tools); cursor = result.nextCursor;
      } while (cursor);
      session.tools = tools; session.loadedRevision = revision;
    })();
    session.refresh = pending;
    try { await pending; } catch (error) { throw attachStderr(error, session); } finally { if (session.refresh === pending) session.refresh = undefined; }
  }

  async probe(connection: ToolConnection, getSecret: ToolExecutionContext['getSecret']): Promise<string[]> {
    return this.serial(connection.id, async () => {
      const session = await this.connectSerial(connection, getSecret);
      await this.refresh(session, true);
      return session.tools.map(tool => tool.name);
    });
  }

  async describe(connectionId: string, context: ToolExecutionContext): Promise<unknown> {
    const connection = this.authorized(connectionId, context);
    const session = await this.connect(connection, context.getSecret);
    return session.tools;
  }

  async catalog(context: ToolExecutionContext): Promise<ToolDefinition[]> {
    const connections = context.toolConnections.filter(item => item.enabled && item.kind !== 'search');
    const definitions = await Promise.all(connections.map(async connection => {
      try {
        const session = await this.connect(connection, context.getSecret);
        if (session.closed || this.closing) return [];
        this.catalogErrors.delete(connection.id);
        connection.toolNames = session.tools.map(tool => tool.name);
        return session.tools.map(tool => {
          const name = remoteToolAlias(connection, tool.name);
          this.aliases.set(name, { connectionId: connection.id, toolName: tool.name });
          return { name, description: `${connection.name} · ${tool.name}${tool.description ? `\n${tool.description}` : ''}`, inputSchema: tool.inputSchema };
        });
      } catch {
        if (this.closing) return [];
        this.catalogErrors.set(connection.id, { connectionId: connection.id, message: 'MCP 工具目录获取失败，请检测连接' });
        return [];
      }
    }));
    return definitions.flat();
  }

  resolve(name: string, context: ToolExecutionContext): McpToolTarget | undefined {
    const target = this.aliases.get(name);
    return target && context.toolConnections.some(item => item.id === target.connectionId && item.enabled && item.kind !== 'search') ? target : undefined;
  }

  diagnostics(context: ToolExecutionContext): McpCatalogDiagnostic[] {
    return context.toolConnections.flatMap(connection => {
      const error = connection.enabled && this.catalogErrors.get(connection.id);
      return error ? [error] : [];
    });
  }

  private authorized(id: string, context: ToolExecutionContext): ToolConnection {
    const connection = context.toolConnections.find(item => item.id === id && item.enabled && item.kind !== 'search');
    if (!connection) throw new Error('MCP 连接未授权或未启用');
    return connection;
  }

  async call(connectionId: string, name: string, args: Record<string, unknown>, context: ToolExecutionContext): Promise<unknown> {
    const connection = this.authorized(connectionId, context);
    const session = await this.connect(connection, context.getSecret);
    const tool = session.tools.find(item => item.name === name);
    if (!tool) throw new Error('MCP 工具不存在，请刷新工具目录');
    const readOnly = tool.annotations?.readOnlyHint === true;
    if (!readOnly && !await context.requestApproval('call_mcp', `${connection.name}：${name}`, { connectionId, toolName: name, arguments: args })) throw new Error('MCP 调用未获批准');
    if (connection.kind === 'bridge' && !readOnly) return this.bridgeCall(session, connection, tool, args, context);
    this.validate(tool, args);
    context.signal.throwIfAborted(); context.assertAuthorized?.();
    if (!readOnly) context.markDispatched?.();
    try {
      return await session.client.callTool({ name, arguments: args }, undefined, { signal: context.signal, timeout: 60_000 });
    } catch (error) {
      throw attachStderr(error, session);
    }
  }

  private validate(tool: RemoteTool, args: Record<string, unknown>): void {
    const validate = schemaValidator.compile(tool.inputSchema);
    if (!validate(args)) throw new Error(`MCP 参数无效：${schemaValidator.errorsText(validate.errors)}`);
  }

  private async bridgeCall(session: Session, connection: ToolConnection, tool: RemoteTool, args: Record<string, unknown>, context: ToolExecutionContext): Promise<unknown> {
    const callId = (context as ToolExecutionContext & { callId?: string }).callId;
    const explicitId = typeof args.client_request_id === 'string' && args.client_request_id.trim() ? args.client_request_id.trim() : undefined;
    const requestId = explicitId ?? createHash('sha256').update(JSON.stringify([context.task.id, connection.id, tool.name, callId ?? args])).digest('hex');
    const active = this.mutations.get(requestId);
    if (active) return active;
    const operation = this.submitBridge(session, tool, args, context, requestId);
    this.mutations.set(requestId, operation);
    try { return await operation; } finally { this.mutations.delete(requestId); }
  }

  private async submitBridge(session: Session, tool: RemoteTool, args: Record<string, unknown>, context: ToolExecutionContext, requestId: string): Promise<unknown> {
    const directory = await workspacePath('.ai-team/bridge', context, true);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const receiptPath = path.join(directory, `${requestId}.json`);
    let previous: BridgeReceipt | undefined;
    try { previous = JSON.parse(await readFile(receiptPath, 'utf8')) as BridgeReceipt; } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (previous?.state === 'completed') return { clientRequestId: requestId, remoteTaskIds: previous.remoteTaskIds, result: previous.result, reused: true };
    if (previous) throw new Error(`Bridge 请求 ${requestId} 结果未知，请使用远端查询工具对账，禁止重复提交`);
    const properties = tool.inputSchema.properties as Record<string, unknown> | undefined;
    const remoteArgs = properties?.client_request_id ? { ...args, client_request_id: requestId } : args;
    this.validate(tool, remoteArgs);
    const receipt: BridgeReceipt = { requestId, tool: tool.name, state: 'pending', updatedAt: new Date().toISOString() };
    await saveReceipt(receiptPath, receipt);
    context.signal.throwIfAborted(); context.markDispatched?.();
    try {
      const result = await session.client.callTool({ name: tool.name, arguments: remoteArgs }, undefined, { signal: context.signal, timeout: 60_000 });
      receipt.state = 'completed'; receipt.remoteTaskIds = extractTaskIds(result); receipt.result = result;
      await saveReceipt(receiptPath, receipt);
      return { clientRequestId: requestId, remoteTaskIds: receipt.remoteTaskIds, result };
    } catch (error) { receipt.state = 'unknown'; await saveReceipt(receiptPath, receipt); throw attachStderr(error, session); }
  }

  private clearCatalog(connectionId: string): void {
    for (const [name, target] of this.aliases) if (target.connectionId === connectionId) this.aliases.delete(name);
    this.catalogErrors.delete(connectionId);
  }

  async remove(connectionId: string): Promise<void> {
    return this.serial(connectionId, async () => {
      const pending = this.sessions.get(connectionId);
      try {
        if (pending) {
          const session = await pending;
          session.closed = true; session.stderr = '';
          this.activeSessions.delete(connectionId);
          await session.client.close();
          if (this.sessions.get(connectionId) === pending) this.sessions.delete(connectionId);
        }
      } finally { this.activeSessions.delete(connectionId); this.clearCatalog(connectionId); }
    });
  }

  close(): Promise<void> {
    if (!this.closing) {
      this.closing = Promise.resolve().then(async () => {
        const ids = new Set([...this.sessions.keys(), ...this.queues.keys()]);
        await Promise.allSettled([...ids].map(id => this.remove(id)));
        this.activeSessions.clear(); this.aliases.clear(); this.catalogErrors.clear();
      });
    }
    return this.closing;
  }
}

function sanitizeStderr(stderr: string, secret?: string): string {
  let text = stderr.trim();
  if (!text) return '';
  if (secret) text = text.split(secret).join('[已隐藏]');
  return text.replace(/Bearer\s+\S+/gi, 'Bearer [已隐藏]')
    .replace(/\b(?:sk-|eyJ)[A-Za-z0-9_.-]{16,}/g, '[已隐藏]')
    .replace(/([?&](?:token|key|code|state)=)[^&\s]+/gi, '$1[已隐藏]');
}

function attachStderr(error: unknown, session: Session): unknown {
  if (error instanceof Error && error.name === 'AbortError') return error;
  const tail = sanitizeStderr(session.stderr, session.secret);
  if (!tail) return error;
  const base = error instanceof Error ? error.message : String(error);
  if (base.includes(tail)) return error;
  return new Error(`${base} (stderr: ${tail})`, error instanceof Error ? { cause: error } : undefined);
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
