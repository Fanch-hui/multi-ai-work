import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ModelMessage } from '../src/domain/provider.js';
import type { Artifact, Run, Task } from '../src/domain/types.js';
import { ContextReferences } from '../src/core/context-references.js';
import { importAttachment } from '../src/core/attachments.js';
import { setup } from './core-harness.js';

async function fixture(tools = ['read_artifact', 'get_task'], inlineToolLimit?: number) {
  const { core, root, bot } = await setup(async () => ({ text: '完成' }));
  const member = bot('助手', tools);
  const room = core.entities.createConversation({ name: '资料', kind: 'private', memberIds: [member.id], workspaceId: core.state.snapshot().workspaces[0].id });
  const task: Task = { id: 'task', conversationId: room.id, botId: member.id, status: 'running',
    artifactIds: [], runIds: [], dependencyIds: [], goal: '处理资料', expectedOutput: '', requestId: 'task', depth: 0, createdAt: '', updatedAt: '' };
  core.state.storage.put('tasks', task);
  const references = new ContextReferences(core.state, { runId: 'run', task, bot: member, room,
    toolNames: tools, signal: new AbortController().signal, inlineToolLimit });
  return { core, root, member, room, task, references };
}

describe('压缩资料引用', () => {
  it('完整保存大工具结果，重复压缩复用成果并允许分段读取', async () => {
    const { core, references, task, member, room } = await fixture();
    const content = '开头'.repeat(9000) + '必须保留的中段' + '结尾'.repeat(9000);
    const message: ModelMessage = { role: 'tool', callId: 'read', content };
    const first = await references.preserveReferences([message]);
    const second = await references.preserveReferences([message], first.artifactIds);
    expect(first.artifactIds).toHaveLength(1);
    expect(second.artifactIds).toEqual(first.artifactIds);
    const artifact = core.state.storage.get<Artifact>('artifacts', first.artifactIds[0])!;
    expect(await readFile(artifact.path, 'utf8')).toBe(content);
    expect(artifact).toMatchObject({ taskId: task.id, purpose: 'intermediate', source: 'context-compaction', size: Buffer.byteLength(content) });
    expect(core.state.storage.get<Task>('tasks', task.id)?.artifactIds).toEqual([artifact.id]);
    expect(first.text).toContain(JSON.stringify({ artifactId: artifact.id }));
    expect(first.text).toContain('get_task');
    const run: Run = { id: 'run', taskId: task.id, botId: member.id, bindingId: 'binding', status: 'running', configRevision: 1, createdAt: '' };
    core.state.storage.put('runs', run);
    const workspace = core.state.snapshot().workspaces[0];
    const context = core.tools.context(run, task, member, room, workspace, new AbortController().signal);
    const result = await core.tools.execute('read_artifact', { artifactId: artifact.id, offset: 18000, limit: 24000 }, 'read-back', context, member) as { content: string };
    expect(result.content).toBe(content.slice(18000, 42000));
  });

  it('仅保留 Core 来源和仍可读取的旧引用，不从正文提取成果 ID', async () => {
    const { core, references, root, room, member } = await fixture();
    const path = join(root, 'input.txt'); await writeFile(path, '资料');
    const artifact = await importAttachment(core.state, room.id, path);
    const otherRoom = core.entities.createConversation({ name: '隔离', kind: 'private', memberIds: [member.id], workspaceId: room.workspaceId });
    const forbidden = await importAttachment(core.state, otherRoom.id, path);
    core.state.storage.appendMessage({ id: 'source', conversationId: room.id, authorType: 'user', content: '资料',
      artifactIds: [artifact.id], status: 'committed', createdAt: '' });
    const source: ModelMessage = { role: 'user', content: forbidden.id, sourceMessageId: 'source' };
    const result = await references.preserveReferences([source], [forbidden.id, artifact.id, artifact.id]);
    expect(result.artifactIds).toEqual([artifact.id]);
    expect(result.text).not.toContain(forbidden.id);
    await rm(artifact.path);
    expect((await references.preserveReferences([], result.artifactIds)).artifactIds).toEqual([]);
  });

  it('权限撤销及实际工具缺失时不生成虚假读取引用', async () => {
    const { core, references, member } = await fixture();
    const message: ModelMessage = { role: 'tool', content: '资料'.repeat(17000) };
    const first = await references.preserveReferences([message]);
    core.state.storage.put('bots', { ...member, toolNames: [] });
    expect(await references.preserveReferences([], first.artifactIds)).toEqual({ text: '', artifactIds: [] });
    await expect(references.preserveReferences([message])).rejects.toThrow('当前授权');
    const withoutRead = await fixture(['get_task']);
    await expect(withoutRead.references.preserveReferences([message])).rejects.toThrow('当前授权');
    expect(withoutRead.core.state.storage.all<Artifact>('artifacts')).toEqual([]);
  });

  it('小窗口按实际预算保存中等长度工具结果，权限不足保留原上下文', async () => {
    const message: ModelMessage = { role: 'tool', content: '中段资料'.repeat(700) };
    const readable = await fixture(['read_artifact'], 1000);
    const preserved = await readable.references.preserveReferences([message]);
    expect(preserved.artifactIds).toHaveLength(1);
    const withoutRead = await fixture([], 1000);
    await expect(withoutRead.references.preserveReferences([message])).rejects.toThrow('当前授权');
    expect(withoutRead.core.state.storage.all<Artifact>('artifacts')).toEqual([]);
  });
});
