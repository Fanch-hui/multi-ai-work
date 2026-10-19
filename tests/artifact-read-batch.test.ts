import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import type { Artifact, Run } from '../src/domain/types.js';
import { toolResultMessage } from '../src/runtime/tool-result-message.js';
import { setup } from './core-harness.js';

async function fixture() {
  const { core, root, bot } = await setup(async () => ({ text: '完成' }));
  core.scheduler.pause();
  const member = bot('资料助手', ['read_artifact']),
    workspace = core.state.snapshot().workspaces[0];
  const room = core.entities.createConversation({
    name: '资料',
    kind: 'private',
    memberIds: [member.id],
    workspaceId: workspace.id,
  });
  const task = core.tasks.create({ conversationId: room.id, botId: member.id, goal: '检查资料' });
  const run: Run = {
    id: 'read-run',
    taskId: task.id,
    botId: member.id,
    bindingId: 'binding',
    status: 'running',
    configRevision: 1,
    createdAt: '',
  };
  core.state.storage.put('runs', run);
  const controller = new AbortController();
  const context = core.tools.context(run, task, member, room, workspace, controller.signal);
  let call = 0;
  const execute = (args: Record<string, unknown>) =>
    core.tools.execute('read_artifact', args, `call-${call++}`, context, member);
  const add = async (name: string, content: string | Buffer, extra: Partial<Artifact> = {}) => {
    const path = join(root, name),
      bytes = Buffer.from(content);
    await writeFile(path, bytes);
    return context.registerArtifact({
      name,
      path,
      size: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      mimeType: 'text/plain',
      conversationId: room.id,
      requirementVersion: 2,
      superseded: false,
      ...extra,
    });
  };
  const batch = async (reads: Record<string, unknown>[]) =>
    JSON.parse(toolResultMessage('read', await execute({ reads })).content).reads;
  return { core, member, room, context, controller, add, execute, batch };
}

describe('成果批量读取', () => {
  it('保留单份接口，并在一次调用中按原顺序分页读取四份资料、共享文本额度', async () => {
    const { add, execute, batch } = await fixture();
    const artifacts = await Promise.all(
      Array.from({ length: 4 }, (_, index) => add(`${index}.txt`, `${index}`.repeat(30000))),
    );
    expect(await execute({ artifactId: artifacts[0].id })).toMatchObject({
      content: '0'.repeat(12000),
      offset: 0,
      nextOffset: 12000,
    });
    const results = await batch(
      artifacts.map((artifact) => ({ artifactId: artifact.id, offset: 1000, limit: 24000 })),
    );
    expect(results.map((item: { artifactId: string }) => item.artifactId)).toEqual(
      artifacts.map((item) => item.id),
    );
    expect(
      results.reduce((sum: number, item: { content: string }) => sum + item.content.length, 0),
    ).toBe(24000);
    results.forEach((item: Record<string, unknown>, index: number) =>
      expect(item).toMatchObject({
        name: `${index}.txt`,
        requirementVersion: 2,
        superseded: false,
        content: `${index}`.repeat(6000),
        offset: 1000,
        nextOffset: 7000,
        totalLength: 30000,
      }),
    );
  });

  it('短资料与失败项未用的额度留给后续项，越权项不泄露资料', async () => {
    const { core, room, add, batch } = await fixture();
    const short = await add('short.txt', '短资料'),
      long = await add('long.txt', '完整资料'.repeat(10000));
    const hidden = await add('hidden.txt', '其他私聊的内容');
    core.state.storage.put('artifacts', {
      ...hidden,
      conversationId: `${room.id}-other`,
      taskId: undefined,
    });
    const results = await batch([
      { artifactId: short.id },
      { artifactId: hidden.id },
      { artifactId: 'missing' },
      { artifactId: long.id, limit: 24000 },
    ]);
    expect(results[0].content).toBe('短资料');
    expect(results[1]).toEqual({ artifactId: hidden.id, offset: 0, error: '成果不存在或未授权' });
    expect(results[2]).toEqual({ artifactId: 'missing', offset: 0, error: '成果不存在或未授权' });
    expect(results[3].content.length).toBe(24000 - 3);
    expect(results[3].nextOffset).toBe(23997);
  });

  it('批内权限撤销立即阻止当前与后续资料返回', async () => {
    const { core, member, context, add, batch } = await fixture();
    const artifacts = await Promise.all([
      add('one.txt', '第一份'),
      add('two.txt', '第二份'),
      add('three.txt', '第三份'),
    ]);
    const original = context.readArtifact!,
      loaded: string[] = [];
    context.readArtifact = async (id) => {
      loaded.push(id);
      const bytes = await original(id);
      if (loaded.length === 2) core.state.storage.put('bots', { ...member, toolNames: [] });
      return bytes;
    };
    const results = await batch(artifacts.map((artifact) => ({ artifactId: artifact.id })));
    expect(results[0].content).toBe('第一份');
    expect(results.slice(1).map((item: { error: string }) => item.error)).toEqual([
      '当前未授权工具：read_artifact',
      '当前未授权工具：read_artifact',
    ]);
    expect(loaded).toEqual(artifacts.slice(0, 2).map((item) => item.id));
  });

  it('取消后停止剩余读取', async () => {
    const { context, controller, add, execute } = await fixture();
    const first = await add('one.txt', '第一份'),
      second = await add('two.txt', '第二份');
    const original = context.readArtifact!,
      loaded: string[] = [];
    context.readArtifact = async (id) => {
      loaded.push(id);
      const bytes = await original(id);
      controller.abort();
      return bytes;
    };
    await expect(
      execute({ reads: [{ artifactId: first.id }, { artifactId: second.id }] }),
    ).rejects.toThrow();
    expect(loaded).toEqual([first.id]);
  });

  it('混合图片、文本和PPTX保留可解析元数据及有序图像，单图格式兼容', async () => {
    const { add, execute } = await fixture();
    const png = await sharp({ create: { width: 2, height: 2, channels: 3, background: 'white' } })
      .png()
      .toBuffer();
    const first = await add('page-1.png', png, { mimeType: 'image/png' }),
      text = await add('source.txt', '说明');
    const second = await add('page-2.png', png, { mimeType: 'image/png' });
    const pptx = await add('source.pptx', '', {
      mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    });
    const result = toolResultMessage(
      'mixed',
      await execute({
        reads: [first, text, second, pptx].map((item) => ({ artifactId: item.id })),
      }),
    );
    const reads = JSON.parse(result.content).reads;
    expect(reads[0]).toMatchObject({
      artifactId: first.id,
      name: 'page-1.png',
      imageIndex: 0,
      requirementVersion: 2,
    });
    expect(reads[1].content).toBe('说明');
    expect(reads[2]).toMatchObject({ artifactId: second.id, imageIndex: 1 });
    expect(reads[3]).toMatchObject({ format: 'pptx', contentAvailable: false });
    expect(result.images?.map((item) => item.artifactId)).toEqual([first.id, second.id]);
    const single = toolResultMessage('single', await execute({ artifactId: first.id }));
    expect(single.content).toBe(`图片 ${first.name} (${first.id})`);
    expect(single.images?.[0].artifactId).toBe(first.id);
  });

  it('拒绝空批次、超过四项、混用入口及缺少入口', async () => {
    const { execute } = await fixture();
    for (const args of [
      { reads: [] },
      { reads: Array.from({ length: 5 }, () => ({ artifactId: 'id' })) },
      { reads: [{ artifactId: 'id' }], artifactId: 'id' },
      { reads: [{ artifactId: 'id' }], limit: 10 },
      {},
    ]) {
      expect(await execute(args)).toHaveProperty('error');
    }
  });
});
