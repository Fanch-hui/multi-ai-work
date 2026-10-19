import { z } from 'zod';
import type { ToolConnection } from '../domain/types.js';
import type { ToolRegistry } from '../domain/tools.js';
import { toolConfiguration } from '../domain/tool-connection.js';
import type { Vault } from '../security/vault.js';
import { tavilySearchTool } from '../tools/search.js';
import { EntityService } from './entities.js';
import { publicError, required } from './errors.js';
import { State, id } from './state.js';

export class ToolConnections {
  private versions = new Map<string, symbol>();
  private mutations = new Map<string, Promise<void>>();
  private closed = false;
  constructor(
    private state: State,
    private entities: EntityService,
    private vault: Vault,
    private registry: ToolRegistry,
  ) {}

  async save(input: unknown): Promise<ToolConnection | undefined> {
    const fields = z.object({ id: z.string().optional() }).passthrough().parse(input);
    const toolId = fields.id ?? id(),
      version = this.invalidate(toolId);
    const connection = await this.mutate(toolId, async () => {
      const saved = await this.entities.saveTool({ ...fields, id: toolId });
      await this.registry.removeConnection?.(toolId);
      return saved;
    });
    if (this.closed) throw new Error('工具连接服务已关闭');
    if (!connection.enabled || this.versions.get(toolId) !== version)
      return this.state.storage.get('tool_connections', toolId);
    try {
      return await this.probe(toolId);
    } catch {
      if (!this.closed) return this.state.storage.get('tool_connections', toolId);
    }
  }

  delete(toolId: string): Promise<void> {
    this.invalidate(toolId);
    return this.mutate(toolId, async () => {
      const connection = this.state.storage.get<ToolConnection>('tool_connections', toolId);
      this.state.storage.delete('tool_connections', toolId);
      this.state.changed();
      await this.registry.removeConnection?.(toolId);
      if (connection?.secretRef) await this.vault.delete(connection.secretRef);
    });
  }

  async probe(toolId: string): Promise<ToolConnection> {
    if (this.closed) throw new Error('工具连接服务已关闭');
    const connection = required(
      this.state.storage.get<ToolConnection>('tool_connections', toolId),
      '工具连接不存在',
    );
    const version = this.versions.get(toolId);
    try {
      const names = await this.registry.probeConnection(connection, (ref) => this.vault.get(ref));
      return this.finish(connection, version, {
        toolNames: names,
        status: 'ready',
        error: undefined,
        searchBackend:
          connection.kind === 'mcp' && tavilySearchTool(names)
            ? 'tavily'
            : connection.searchBackend,
      });
    } catch (error) {
      this.finish(connection, version, { status: 'error', error: publicError(error) });
      throw error;
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    await Promise.allSettled(this.mutations.values());
  }

  private invalidate(toolId: string): symbol {
    if (this.closed) throw new Error('工具连接服务已关闭');
    const version = Symbol();
    this.versions.set(toolId, version);
    return version;
  }

  private mutate<T>(toolId: string, action: () => Promise<T>): Promise<T> {
    const operation = (this.mutations.get(toolId) ?? Promise.resolve()).then(action);
    const tail = operation.then(
      () => undefined,
      () => undefined,
    );
    this.mutations.set(toolId, tail);
    void tail.then(() => {
      if (this.mutations.get(toolId) === tail) this.mutations.delete(toolId);
    });
    return operation;
  }

  private finish(
    connection: ToolConnection,
    version: symbol | undefined,
    result: Partial<ToolConnection>,
  ): ToolConnection {
    if (this.closed) throw new Error('工具连接服务已关闭');
    const current = required(
      this.state.storage.get<ToolConnection>('tool_connections', connection.id),
      '工具连接已删除',
    );
    if (
      this.versions.get(connection.id) !== version ||
      toolConfiguration(current) !== toolConfiguration(connection)
    )
      return current;
    const updated = { ...current, ...result };
    this.state.storage.put('tool_connections', updated);
    this.state.changed();
    return updated;
  }
}
