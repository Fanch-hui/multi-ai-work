import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { readFile } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { Artifact, Bot, Conversation, Task } from '../src/domain/types.js';
import type { ToolContentResult } from '../src/domain/provider.js';
import { importAttachmentBytes } from '../src/core/attachments.js';
import { accessibleArtifacts } from '../src/core/tool-access.js';
import { startHttp } from '../src/core/http.js';
import { setup, eventually } from './core-harness.js';

async function imageBytes(color = '#ef2345') {
  return sharp({ create: { width: 40, height: 24, channels: 3, background: color } })
    .png()
    .toBuffer();
}

describe('Core 图片资料', () => {
  it('保存真实图片并通过原生 MCP 返回图像，失败重试仍保留输入引用且拒绝其他私聊图片', async () => {
    let input!: Artifact,
      privateImage!: Artifact,
      rounds = 0;
    const { core, bot } = await setup(async (context) => {
      expect(context.images?.map((image) => image.artifactId)).toEqual([input.id]);
      const resolved = await context.resolveImage!(context.images![0]);
      expect((await sharp(Buffer.from(resolved.data, 'base64')).metadata()).width).toBe(40);
      await expect(
        context.resolveImage!({ artifactId: privateImage.id, mimeType: 'image/png' }),
      ).rejects.toThrow('授权范围');
      const env = Object.fromEntries(
        Object.entries({ ...process.env, ...context.nativeMcp.env }).filter(
          (entry): entry is [string, string] => entry[1] !== undefined,
        ),
      );
      const client = new Client({ name: 'image-reader', version: '1.0.0' });
      try {
        await client.connect(
          new StdioClientTransport({
            command: context.nativeMcp.command,
            args: context.nativeMcp.args,
            env,
            stderr: 'ignore',
          }),
        );
        const result = await client.callTool({
          name: 'read_artifact',
          arguments: { artifactId: input.id },
        });
        expect(result.isError).not.toBe(true);
        const image = (result.content as { type: string; mimeType?: string; data?: string }[]).find(
          (item) => item.type === 'image',
        );
        expect(image?.mimeType).toBe('image/png');
        expect((await sharp(Buffer.from(image!.data!, 'base64')).metadata()).height).toBe(24);
        const denied = await client.callTool({
          name: 'read_artifact',
          arguments: { artifactId: privateImage.id },
        });
        expect(denied.isError).toBe(true);
        expect(JSON.stringify(denied.content)).toContain('未授权');
      } finally {
        await client.close();
      }
      if (++rounds === 1) throw new Error('模型临时失败');
      return { text: '重试已读取图片' };
    });
    const member = bot('识图助手', ['read_artifact']);
    const workspaceId = core.state.snapshot().workspaces[0].id;
    const room = core.entities.createConversation({
      name: '图片',
      kind: 'private',
      memberIds: [member.id],
      workspaceId,
    });
    const other = core.entities.createConversation({
      name: '私密图片',
      kind: 'private',
      memberIds: [member.id],
      workspaceId,
    });
    const bytes = await imageBytes();
    input = await importAttachmentBytes(
      core.state,
      room.id,
      '图.png',
      'image/png',
      bytes.toString('base64'),
    );
    privateImage = await importAttachmentBytes(
      core.state,
      other.id,
      '私密.png',
      'image/png',
      (await imageBytes('#3456ef')).toString('base64'),
    );
    expect(await readFile(input.path)).toEqual(bytes);
    const server = await startHttp(core, false);
    try {
      const sent = core.tasks.send({
        conversationId: room.id,
        content: '',
        artifactIds: [input.id],
      });
      await eventually(
        () => core.state.storage.get<Task>('tasks', sent.taskIds[0])?.status === 'failed',
        10000,
      );
      expect(core.state.storage.get<Task>('tasks', sent.taskIds[0])?.error).toBe('模型临时失败');
      const retried = core.tasks.retry(sent.taskIds[0]);
      expect(retried.inputArtifactIds).toEqual([input.id]);
      await eventually(
        () =>
          ['completed', 'failed'].includes(
            core.state.storage.get<Task>('tasks', retried.id)?.status ?? '',
          ),
        10000,
      );
      expect(core.state.storage.get<Task>('tasks', retried.id)).toMatchObject({
        status: 'completed',
        inputArtifactIds: [input.id],
        artifactIds: [],
      });
      const operations = core.state.storage.all<{ result?: ToolContentResult }>('tool_operations');
      expect(
        operations.filter((item) => item.result?.content?.some((part) => part.type === 'image')),
      ).toHaveLength(2);
      const persisted = JSON.stringify({
        snapshot: core.state.snapshot(),
        operations,
        metadata: core.state.storage.db.prepare('SELECT value FROM metadata').all(),
        archive: core.state.storage.all('provider_archive'),
      });
      expect(persisted).not.toContain(bytes.toString('base64'));
      expect(persisted).not.toContain('data:image');
    } finally {
      await server.close();
    }
  });

  it('主管任务群继承输入，委派选择一张图片，回传成果与输入分开并校验来源绑定', async () => {
    let worker!: Bot, images!: Artifact[], group!: { conversation: Conversation; task: Task };
    let mainRounds = 0,
      groupRounds = 0,
      output!: Artifact;
    const { core, bot, connection } = await setup(async (context) => {
      if (context.bot.id === worker.id) {
        expect(context.images?.map((item) => item.artifactId)).toEqual([images[0].id]);
        expect(
          await context.executeTool('read_artifact', { artifactId: images[1].id }, 'not-selected'),
        ).toHaveProperty('error');
        expect(
          (
            (await context.executeTool(
              'read_artifact',
              { artifactId: images[0].id },
              'selected',
            )) as ToolContentResult
          ).content,
        ).toContainEqual(
          expect.objectContaining({
            type: 'image',
            image: expect.objectContaining({ artifactId: images[0].id }),
          }),
        );
        output = (await context.executeTool(
          'write_artifact',
          { path: 'image-report.md', format: 'markdown', content: '已核查选定图片' },
          'output',
        )) as Artifact;
        return { text: '图片检查完成' };
      }
      if (context.binding.conversationId === group?.conversation.id) {
        expect(context.images?.map((item) => item.artifactId)).toEqual(
          images.map((item) => item.id),
        );
        if (++groupRounds === 1) {
          const delegated = (await context.executeTool(
            'delegate_task',
            {
              botId: worker.id,
              goal: '检查第一张图片',
              expectedOutput: '报告',
              artifactIds: [images[0].id],
            },
            'delegate',
          )) as Task;
          expect(delegated.inputArtifactIds).toEqual([images[0].id]);
          expect(delegated.artifactIds).toEqual([]);
          return { text: '等待图片检查' };
        }
        return { text: '群报告完成' };
      }
      if (++mainRounds === 1) {
        group = (await context.executeTool(
          'create_task_group',
          { name: '图片检查', goal: '检查图片', memberIds: [worker.id] },
          'group',
        )) as typeof group;
        expect(group.task.inputArtifactIds).toEqual(images.map((item) => item.id));
        expect(group.task.artifactIds).toEqual([]);
        return { text: '等待任务群' };
      }
      expect(
        await context.executeTool('read_artifact', { artifactId: output.id }, 'returned'),
      ).toMatchObject({ content: '已核查选定图片' });
      return { text: '已核查回传成果' };
    });
    worker = bot('图片检查员', ['read_artifact', 'write_artifact']);
    await core.request('chief.configure', {
      input: { connectionId: connection.id, model: 'test' },
    });
    const mainId = core.state.settings().mainConversationId!;
    images = await Promise.all(
      ['#ef3456', '#3456ef'].map(async (color, i) =>
        importAttachmentBytes(
          core.state,
          mainId,
          `${i}.png`,
          'image/png',
          (await imageBytes(color)).toString('base64'),
        ),
      ),
    );
    const sent = core.tasks.send({
      conversationId: mainId,
      content: '合作检查图片',
      artifactIds: images.map((item) => item.id),
    });
    await eventually(
      () =>
        ['completed', 'failed'].includes(
          core.state.storage.get<Task>('tasks', sent.taskIds[0])?.status ?? '',
        ),
      10000,
    );
    const source = core.state.storage.get<Task>('tasks', sent.taskIds[0])!;
    expect(source).toMatchObject({
      status: 'completed',
      inputArtifactIds: images.map((item) => item.id),
      artifactIds: [output.id],
    });
    const child = core.state.storage.all<Task>('tasks').find((item) => item.botId === worker.id)!;
    expect(
      accessibleArtifacts(core.state, group.conversation, worker.id, child).map((item) => item.id),
    ).toContain(images[0].id);
    const detached = {
      ...group.conversation,
      sourceConversationId: undefined,
      sourceTaskId: undefined,
    };
    core.state.storage.put('conversations', detached);
    expect(
      accessibleArtifacts(core.state, detached, worker.id, child).map((item) => item.id),
    ).not.toContain(images[0].id);
    const other = core.entities.createConversation({
      name: '成员私聊',
      kind: 'private',
      memberIds: [worker.id],
      workspaceId: group.conversation.workspaceId,
    });
    expect(accessibleArtifacts(core.state, other, worker.id)).toEqual([]);
    expect(() =>
      core.tasks.send({
        conversationId: other.id,
        content: '查看图片',
        artifactIds: [images[0].id],
      }),
    ).toThrow('不在当前会话');
  });

  it('无来源关系不能伪造跨会话任务输入，伪装图片不能进入附件库', async () => {
    const { core, bot } = await setup(async () => ({ text: '答复' }));
    core.scheduler.pause();
    const member = bot('助手');
    const workspaceId = core.state.snapshot().workspaces[0].id;
    const first = core.entities.createConversation({
      name: '甲',
      kind: 'private',
      memberIds: [member.id],
      workspaceId,
    });
    const second = core.entities.createConversation({
      name: '乙',
      kind: 'private',
      memberIds: [member.id],
      workspaceId,
    });
    const input = await importAttachmentBytes(
      core.state,
      first.id,
      '图.png',
      'image/png',
      (await imageBytes()).toString('base64'),
    );
    expect(() =>
      core.tasks.create({
        conversationId: second.id,
        botId: member.id,
        goal: '读取图片',
        inputArtifactIds: [input.id],
      }),
    ).toThrow('未授权');
    await expect(
      importAttachmentBytes(
        core.state,
        first.id,
        '伪装.png',
        'image/png',
        Buffer.from('not an image').toString('base64'),
      ),
    ).rejects.toThrow('图片内容无效');
    expect(core.state.snapshot().artifacts).toHaveLength(1);
    expect(core.state.snapshot().tasks).toHaveLength(0);
  });
});
