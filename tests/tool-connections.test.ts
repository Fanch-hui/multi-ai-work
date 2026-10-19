import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ToolRegistry } from '../src/domain/tools.js';
import type { ToolConnection } from '../src/domain/types.js';
import { State } from '../src/core/state.js';
import { EntityService } from '../src/core/entities.js';
import { ToolConnections } from '../src/core/tool-connections.js';
import { Vault } from '../src/security/vault.js';

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const resources: { state: State; tools: ToolConnections; root: string }[] = [];
afterEach(async () => {
  for (const { state, tools, root } of resources.splice(0)) {
    await tools.close();
    state.storage.close();
    await rm(root, { recursive: true, force: true });
  }
});
async function setup(probe: ToolRegistry['probeConnection']) {
  const root = await mkdtemp(join(tmpdir(), 'team-tool-connections-'));
  const state = new State(root),
    vault = new Vault(join(root, 'unused-vault'));
  const registry: ToolRegistry = {
    definitions: () => [],
    execute: async () => undefined,
    probeConnection: probe,
    removeConnection: async () => {},
    close: async () => {},
  };
  const tools = new ToolConnections(state, new EntityService(state, vault), vault, registry);
  const connection: ToolConnection = {
    id: 'service',
    name: 'Local service',
    kind: 'mcp',
    transport: 'stdio',
    command: process.execPath,
    args: [],
    enabled: true,
    toolNames: [],
    status: 'untested',
  };
  state.storage.put('tool_connections', connection);
  resources.push({ state, tools, root });
  return { state, tools, connection };
}

describe('tool connection changes during discovery', () => {
  it.each(['success', 'error'])(
    'does not recreate a deleted connection after a late %s',
    async (outcome) => {
      const gate = deferred<string[]>();
      const { state, tools } = await setup(() => gate.promise);
      const pending = tools.probe('service').catch((error) => error as Error);
      await tools.delete('service');
      if (outcome === 'success') gate.resolve(['old-tool']);
      else gate.reject(new Error('old discovery failed'));
      expect(await pending).toBeInstanceOf(Error);
      expect(state.storage.get('tool_connections', 'service')).toBeUndefined();
    },
  );

  it('retains a disabled connection when previous discovery completes', async () => {
    const gate = deferred<string[]>();
    const { state, tools, connection } = await setup(() => gate.promise);
    const pending = tools.probe(connection.id);
    await tools.save({ ...connection, enabled: false });
    gate.resolve(['old-tool']);
    await pending;
    expect(state.storage.get('tool_connections', connection.id)).toMatchObject({
      enabled: false,
      status: 'untested',
      toolNames: [],
    });
  });

  it('keeps the new configuration and catalog when old discovery returns', async () => {
    const gate = deferred<string[]>();
    const { state, tools, connection } = await setup((item) =>
      item.name === 'Replacement' ? Promise.resolve(['new-tool']) : gate.promise,
    );
    const pending = tools.probe(connection.id);
    await tools.save({ ...connection, name: 'Replacement', args: ['new-configuration'] });
    gate.resolve(['old-tool']);
    await pending;
    expect(state.storage.get('tool_connections', connection.id)).toMatchObject({
      name: 'Replacement',
      args: ['new-configuration'],
      status: 'ready',
      toolNames: ['new-tool'],
    });
  });

  it('does not apply discovery to a connection recreated with the same id', async () => {
    const gate = deferred<string[]>();
    const { state, tools, connection } = await setup((item) =>
      item.name === 'Replacement' ? Promise.resolve(['new-tool']) : gate.promise,
    );
    const pending = tools.probe(connection.id);
    await tools.delete(connection.id);
    await tools.save({ ...connection, name: 'Replacement' });
    gate.resolve(['old-tool']);
    await pending;
    expect(state.storage.get('tool_connections', connection.id)).toMatchObject({
      name: 'Replacement',
      toolNames: ['new-tool'],
    });
  });

  it('continues saving after invalid configuration fails', async () => {
    const { tools, connection } = await setup(async () => []);
    await expect(tools.save({ ...connection, command: 'relative-command' })).rejects.toThrow(
      '绝对路径',
    );
    expect(await tools.save({ ...connection, enabled: false })).toMatchObject({
      id: connection.id,
      enabled: false,
    });
  });

  it('persists HTTP request options and normalizes existing search configurations', async () => {
    const { state, tools } = await setup(async () => ['search_web']);
    const fields = {
      id: 'search',
      name: 'Search',
      kind: 'search',
      transport: 'http',
      url: 'https://api.deepseek.com/v1/tools/search',
    };
    expect(await tools.save(fields)).toMatchObject({ id: fields.id, status: 'ready' });
    expect(state.storage.get<ToolConnection>('tool_connections', fields.id)).toMatchObject({
      searchBackend: 'http',
      searchMethod: 'GET',
      searchQueryField: 'q',
    });
    expect(await tools.save({ ...fields, searchBackend: 'deepseek' })).toMatchObject({
      searchBackend: 'http',
      searchMethod: 'POST',
      searchQueryField: 'query',
      status: 'ready',
    });
    expect(
      await tools.save({ ...fields, searchMethod: 'POST', searchQueryField: ' keyword ' }),
    ).toMatchObject({
      searchBackend: 'http',
      searchMethod: 'POST',
      searchQueryField: 'keyword',
      status: 'ready',
    });
    await expect(tools.save({ ...fields, searchQueryField: ' ' })).rejects.toThrow();
    await expect(tools.save({ ...fields, searchMethod: 'DELETE' })).rejects.toThrow();
  });

  it('does not overwrite request options changed during discovery', async () => {
    const gate = deferred<string[]>();
    const { state, tools, connection } = await setup(() => gate.promise);
    const initial = {
      ...connection,
      kind: 'search' as const,
      transport: 'http' as const,
      searchMethod: 'GET' as const,
    };
    state.storage.put('tool_connections', initial);
    const pending = tools.probe(initial.id);
    state.storage.put('tool_connections', {
      ...initial,
      searchMethod: 'POST',
      searchQueryField: 'keyword',
    });
    gate.resolve(['old-tool']);
    await pending;
    expect(state.storage.get('tool_connections', initial.id)).toMatchObject({
      searchMethod: 'POST',
      searchQueryField: 'keyword',
      status: 'untested',
      toolNames: [],
    });
  });

  it('does not access closed storage when discovery completes after shutdown', async () => {
    const gate = deferred<string[]>();
    const { state, tools } = await setup(() => gate.promise);
    const pending = tools.probe('service').catch((error) => error as Error);
    await tools.close();
    state.storage.close();
    resources.splice(
      resources.findIndex((resource) => resource.state === state),
      1,
    );
    gate.resolve(['old-tool']);
    expect(((await pending) as Error).message).toBe('工具连接服务已关闭');
    await rm(state.dataDirectory, { recursive: true, force: true });
  });
});
