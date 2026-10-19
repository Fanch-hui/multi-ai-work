import { describe, expect, it } from 'vitest';
import { readFile, writeFile } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { createHash } from 'node:crypto';
import { Document, Packer, Paragraph } from 'docx';
import type { Artifact, Task } from '../src/domain/types.js';
import { readDocument } from '../src/tools/documents.js';
import { setup, eventually } from './core-harness.js';

describe('原始资料交付', () => {
  it('原文件按字节归档，Bot 可读会话资料，备份后仍可解析 Office', async () => {
    let selected = '',
      artifactId = '';
    const { core, root, bot } = await setup(
      async (context) => {
        expect(context.prompt).toContain(artifactId);
        const result = (await context.executeTool(
          'read_artifact',
          { artifactId },
          'read-source',
        )) as { content: string };
        expect(result.content).toContain('先核查来源');
        return { text: '已按原始资料处理' };
      },
      async () => ({ path: selected }),
    );
    const member = bot('助手', ['read_artifact']);
    const room = core.entities.createConversation({
      name: '私聊',
      kind: 'private',
      memberIds: [member.id],
      workspaceId: core.state.snapshot().workspaces[0].id,
    });
    selected = join(root, 'original.docx');
    const bytes = await Packer.toBuffer(
      new Document({ sections: [{ children: [new Paragraph('原始约束：先核查来源。')] }] }),
    );
    await writeFile(selected, bytes);
    const imported = (await core.request('conversations.attach', { conversationId: room.id })) as {
      artifact: Artifact;
    };
    artifactId = imported.artifact.id;
    expect(imported.artifact.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
    expect(await readFile(imported.artifact.path)).toEqual(bytes);
    await writeFile(selected, '原文件后来发生变化');
    const sent = core.tasks.send({
      conversationId: room.id,
      content: '请核查资料',
      artifactIds: [artifactId],
    });
    await eventually(
      () => core.state.storage.get<Task>('tasks', sent.taskIds[0])?.status === 'completed',
    );
    expect(core.state.snapshot().messages[0].artifactIds).toEqual([artifactId]);
    const backup = (await core.request('backup.create')) as { path: string };
    await core.request('backup.restore', backup);
    const restored = core.state.storage.get<Artifact>('artifacts', artifactId)!;
    expect(extname(restored.path)).toBe('.docx');
    expect(JSON.stringify(await readDocument(restored.path))).toContain('先核查来源');
  });

  it('私聊资料不能通过外部 ID 注入另一个会话', async () => {
    let selected = '';
    const { core, root, bot } = await setup(
      async () => ({ text: '答复' }),
      async () => ({ path: selected }),
    );
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
    selected = join(root, 'source.txt');
    await writeFile(selected, '甲会话的资料');
    const imported = (await core.request('conversations.attach', { conversationId: first.id })) as {
      artifact: Artifact;
    };
    expect(() =>
      core.tasks.send({
        conversationId: second.id,
        content: '读取',
        artifactIds: [imported.artifact.id],
      }),
    ).toThrow('不在当前会话');
    expect(core.state.snapshot().tasks).toHaveLength(0);
  });
});
