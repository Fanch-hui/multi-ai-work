import { describe, expect, it } from 'vitest';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Bot, Run, Skill, Task, ToolConnection } from '../src/domain/types.js';
import type { ToolDefinition } from '../src/domain/provider.js';
import { startHttp } from '../src/core/http.js';
import { setup } from './core-harness.js';

describe('current Native tool catalog', () => {
  it('rebuilds tools from current member, workspace, skill and connection grants through the HTTP entry', async () => {
    const { core, root, bot } = await setup(async () => ({ text: '' }));
    core.scheduler.pause();
    const s = core.state.storage, workspace = core.state.snapshot().workspaces[0];
    for (const skill of s.all<Skill>('skills')) s.delete('skills', skill.id);
    const skill: Skill = { id: 'catalog-skill', name: 'Catalog skill', path: join(root, 'SKILL.md'), content: 'Example', description: '' };
    await writeFile(skill.path, skill.content);
    const connection: ToolConnection = { id: 'catalog-search', name: 'Search', kind: 'search', enabled: true, url: 'https://example.com', toolNames: [], status: 'ready' };
    s.put('skills', skill); s.put('tool_connections', connection);
    const initial = bot('Catalog member', ['read_file', 'write_file', 'read_skill', 'search_web', 'call_mcp']);
    const member = core.entities.saveBot({ ...initial, skillIds: [skill.id], toolConnectionIds: [connection.id] });
    const room = core.entities.createConversation({ name: 'Catalog room', kind: 'private', memberIds: [member.id], workspaceId: workspace.id });
    const task: Task = { id: 'catalog-task', conversationId: room.id, botId: member.id, dependencyIds: [], goal: 'work', expectedOutput: '', status: 'running',
      runIds: ['catalog-run'], artifactIds: [], requestId: 'catalog-request', depth: 0, createdAt: '2026-10-18', updatedAt: '2026-10-18' };
    const run: Run = { id: 'catalog-run', taskId: task.id, botId: member.id, bindingId: 'catalog-binding', status: 'running', configRevision: member.revision, createdAt: '2026-10-18' };
    s.put('tasks', task); s.put('runs', run);
    const context = core.tools.context(run, task, member, room, workspace, new AbortController().signal);
    core.executor.nativeContexts.set('catalog-test', { context, bot: member, runId: run.id });
    const server = await startHttp(core, false);
    const headers = { authorization: 'Bearer catalog-test' };
    const tools = async () => {
      const response = await fetch(`${server.url}/native/tools`, { headers });
      expect(response.ok).toBe(true);
      return (await response.json() as ToolDefinition[]).map(tool => tool.name);
    };
    try {
      expect(await tools()).toEqual(expect.arrayContaining(['read_file', 'write_file', 'read_skill', 'search_web']));
      const edited = core.entities.saveBot({ ...member, toolNames: ['list_directory', 'write_file', 'read_skill', 'search_web', 'call_mcp'], skillIds: [], toolConnectionIds: [] });
      s.put('workspaces', { ...workspace, writable: false });
      const current = await tools();
      expect(current).toContain('list_directory');
      for (const name of ['read_file', 'write_file', 'read_skill', 'search_web', 'call_mcp']) expect(current).not.toContain(name);
      const denied = await fetch(`${server.url}/native/call`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'read_file', args: { path: 'missing.txt' }, callId: 'revoked-read' }) });
      expect(await denied.json()).toMatchObject({ error: '当前未授权工具：read_file' });

      core.entities.saveBot({ ...edited, skillIds: [skill.id], toolConnectionIds: [connection.id] });
      s.put('workspaces', workspace);
      expect(await tools()).toEqual(expect.arrayContaining(['list_directory', 'write_file', 'read_skill', 'search_web']));
      s.put('tool_connections', { ...connection, enabled: false });
      expect(await tools()).not.toContain('search_web');
      s.put('bots', { ...s.get<Bot>('bots', member.id)!, archived: true });
      expect(await tools()).toEqual([]);
    } finally { core.executor.nativeContexts.delete('catalog-test'); await server.close(); }
  });
});
