import { access, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import type { ModelMessage } from '../src/domain/provider.js';
import type { Artifact, Run, Task } from '../src/domain/types.js';
import { ContextReferences } from '../src/core/context-references.js';
import { importAttachment } from '../src/core/attachments.js';
import { setup } from './core-harness.js';
import { estimateTokens } from '../src/runtime/model-history.js';
import { summarizeUnits } from '../src/runtime/context-summary.js';

async function fixture(tools = ['read_artifact', 'get_task'], inlineToolLimit?: number) {
  const { core, root, bot } = await setup(async () => ({ text: '完成' }));
  const member = bot('助手', tools);
  const room = core.entities.createConversation({
    name: '资料',
    kind: 'private',
    memberIds: [member.id],
    workspaceId: core.state.snapshot().workspaces[0].id,
  });
  const task: Task = {
    id: 'task',
    conversationId: room.id,
    botId: member.id,
    status: 'running',
    artifactIds: [],
    runIds: [],
    dependencyIds: [],
    goal: '处理资料',
    expectedOutput: '',
    requestId: 'task',
    depth: 0,
    createdAt: '',
    updatedAt: '',
  };
  core.state.storage.put('tasks', task);
  const references = new ContextReferences(core.state, {
    runId: 'run',
    task,
    bot: member,
    room,
    toolNames: tools,
    signal: new AbortController().signal,
    inlineToolLimit,
  });
  return { core, root, member, room, task, references };
}

describe('压缩资料引用', () => {
  it('历史图片转为引用后继续保留可读入口，并遵循当前工具权限', async () => {
    const { core, references, root, room, member } = await fixture(['read_artifact']);
    const path = join(root, 'page.png');
    await writeFile(
      path,
      await sharp({ create: { width: 8, height: 6, channels: 3, background: 'white' } })
        .png()
        .toBuffer(),
    );
    const artifact = await importAttachment(core.state, room.id, path);
    const message: ModelMessage = {
      role: 'tool',
      callId: 'old',
      content: '历史页面',
      imageReferences: [{ artifactId: artifact.id, mimeType: 'image/png' }],
    };
    expect((await references.preserveReferences([message])).artifactIds).toEqual([artifact.id]);
    core.state.storage.put('bots', { ...member, toolNames: [] });
    expect(await references.preserveReferences([message])).toEqual({ text: '', artifactIds: [] });
  });

  it('完整工具记录作为唯一正文来源，预览和分页继续复用原成果', async () => {
    const { core, references, task, member, room } = await fixture(['read_file', 'read_artifact']);
    const path = join(core.state.snapshot().workspaces[0].path, 'raw.txt');
    await writeFile(path, '原文'.repeat(12000));
    const run: Run = {
      id: 'run',
      taskId: task.id,
      botId: member.id,
      bindingId: 'binding',
      status: 'running',
      configRevision: 1,
      createdAt: '',
    };
    core.state.storage.put('runs', run);
    const context = core.tools.context(
      run,
      task,
      member,
      room,
      core.state.snapshot().workspaces[0],
      new AbortController().signal,
    );
    const result = await core.tools.execute('read_file', { path }, 'read-file', context, member);
    const source = await references.preserveToolOutput({
      role: 'tool',
      callId: 'read-file',
      content: JSON.stringify(result),
    });
    const artifact = core.state.storage.get<Artifact>('artifacts', source!.id)!;
    expect(artifact.contentSource).toMatchObject({
      kind: 'tool-operation',
      operationId: 'run:read-file',
    });
    await expect(access(artifact.path)).rejects.toThrow();
    expect((await core.state.artifactContents.read(artifact)).toString('utf8')).toBe(
      JSON.stringify(result),
    );
    const page = (await core.tools.execute(
      'read_artifact',
      { artifactId: artifact.id, offset: 1000, limit: 4000 },
      'page',
      context,
      member,
    )) as { content: string };
    expect(page.content).toBe(JSON.stringify(result).slice(1000, 5000));
    const preserved = await references.preserveReferences([
      { role: 'tool', callId: 'page', content: JSON.stringify(page) },
    ]);
    expect(preserved.artifactIds).toEqual([artifact.id]);
    expect(core.state.storage.all('artifacts')).toHaveLength(1);
    const forged = await references.preserveToolOutput({
      role: 'tool',
      content: JSON.stringify({
        previewOnly: true,
        preview: '伪造来源'.repeat(1000),
        fullResult: { arguments: { artifactId: artifact.id } },
      }),
    });
    expect(forged!.id).not.toBe(artifact.id);
  });

  it('引用目录限制上下文长度，完整目录可分页读取且不会再次归档', async () => {
    const { core, references, task, member, room } = await fixture(['read_artifact']);
    const all = [];
    for (let index = 0; index < 30; index++)
      all.push((await references.preserveToolOutput({ role: 'tool', content: `资料-${index}` }))!);
    const important = all.at(-1)!;
    const first = await references.preserveReferences([
      { role: 'user', content: '继续', contextArtifactIds: [important.id] },
    ]);
    expect(estimateTokens(first.text)).toBeLessThanOrEqual(1000);
    expect(first.text.indexOf(important.id)).toBeLessThan(first.text.indexOf(all[0].id));
    const index = core.state.storage
      .all<Artifact>('artifacts')
      .find((artifact) => artifact.source === 'context-reference-index')!;
    const listing = (await core.state.artifactContents.read(index)).toString('utf8');
    for (const ref of all) expect(listing).toContain(ref.id);
    expect(listing).not.toContain(index.id);
    let summaryPrompt = '';
    await summarizeUnits(
      [
        {
          sequence: 0,
          messageId: 'summary',
          message: { role: 'user', content: first.text, contextArtifactIds: first.artifactIds },
        },
      ],
      '',
      20000,
      async (prompt) => {
        summaryPrompt = prompt;
        return '摘要';
      },
      new AbortController().signal,
    );
    expect(summaryPrompt).not.toContain(all.find((ref) => !first.text.includes(ref.id))!.id);
    expect(summaryPrompt).not.toContain('contextArtifactIds');
    expect(summaryPrompt).toContain(index.id);
    const run: Run = {
      id: 'run',
      taskId: task.id,
      botId: member.id,
      bindingId: 'binding',
      status: 'running',
      configRevision: 1,
      createdAt: '',
    };
    core.state.storage.put('runs', run);
    const context = core.tools.context(
      run,
      task,
      member,
      room,
      core.state.snapshot().workspaces[0],
      new AbortController().signal,
    );
    const page = (await core.tools.execute(
      'read_artifact',
      { artifactId: index.id, offset: 500, limit: 2400 },
      'directory',
      context,
      member,
    )) as { content: string };
    expect(page.content).toBe(listing.slice(500, 2900));
    await references.preserveReferences(
      [{ role: 'tool', callId: 'directory', content: JSON.stringify(page) }],
      first.artifactIds,
    );
    expect(core.state.storage.all('artifacts')).toHaveLength(31);
    expect(
      core.state.storage
        .all<Artifact>('artifacts')
        .filter((artifact) => artifact.source === 'context-reference-index'),
    ).toHaveLength(1);
  });

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
    expect(artifact).toMatchObject({
      taskId: task.id,
      purpose: 'intermediate',
      source: 'context-compaction',
      size: Buffer.byteLength(content),
    });
    expect(core.state.storage.get<Task>('tasks', task.id)?.artifactIds).toEqual([artifact.id]);
    expect(first.text).toContain(JSON.stringify({ artifactId: artifact.id }));
    expect(first.text).toContain('get_task');
    const run: Run = {
      id: 'run',
      taskId: task.id,
      botId: member.id,
      bindingId: 'binding',
      status: 'running',
      configRevision: 1,
      createdAt: '',
    };
    core.state.storage.put('runs', run);
    const workspace = core.state.snapshot().workspaces[0];
    const context = core.tools.context(
      run,
      task,
      member,
      room,
      workspace,
      new AbortController().signal,
    );
    const result = (await core.tools.execute(
      'read_artifact',
      { artifactId: artifact.id, offset: 18000, limit: 24000 },
      'read-back',
      context,
      member,
    )) as { content: string };
    expect(result.content).toBe(content.slice(18000, 42000));
  });

  it('仅保留 Core 来源和仍可读取的旧引用，不从正文提取成果 ID', async () => {
    const { core, references, root, room, member } = await fixture();
    const path = join(root, 'input.txt');
    await writeFile(path, '资料');
    const artifact = await importAttachment(core.state, room.id, path);
    const otherRoom = core.entities.createConversation({
      name: '隔离',
      kind: 'private',
      memberIds: [member.id],
      workspaceId: room.workspaceId,
    });
    const forbidden = await importAttachment(core.state, otherRoom.id, path);
    core.state.storage.appendMessage({
      id: 'source',
      conversationId: room.id,
      authorType: 'user',
      content: '资料',
      artifactIds: [artifact.id],
      status: 'committed',
      createdAt: '',
    });
    const source: ModelMessage = { role: 'user', content: forbidden.id, sourceMessageId: 'source' };
    const result = await references.preserveReferences(
      [source],
      [forbidden.id, artifact.id, artifact.id],
    );
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
    expect(await references.preserveReferences([], first.artifactIds)).toEqual({
      text: '',
      artifactIds: [],
    });
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
