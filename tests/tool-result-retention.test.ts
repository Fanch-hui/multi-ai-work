import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Artifact } from '../src/domain/types.js';
import { BackupService } from '../src/core/backup.js';
import { ConversationService } from '../src/core/conversations.js';
import { setup } from './core-harness.js';

const content = '工具结果第一段\n中段的精确数据：12345\n最后一段';
function artifact(
  path: string,
  conversationId: string,
  source: Artifact['contentSource'],
): Artifact {
  return {
    id: 'tool-result',
    name: '工具完整结果.txt',
    path,
    conversationId,
    mimeType: 'text/plain',
    size: Buffer.byteLength(content),
    sha256: createHash('sha256').update(content).digest('hex'),
    purpose: 'intermediate',
    source: 'context-compaction',
    contentSource: source,
    createdAt: new Date().toISOString(),
  };
}

describe('工具结果缓存回收后的资料保留', () => {
  it.each(['tool-operation', 'stored-text'] as const)(
    '%s 缓存文件缺失时从备份快照导出全文，恢复后可独立读取和再次备份',
    async (kind) => {
      const { core, root } = await setup(async () => ({ text: '完成' }));
      core.scheduler.pause();
      const s = core.state.storage;
      const source: Artifact['contentSource'] =
        kind === 'tool-operation'
          ? { kind, operationId: 'operation', field: 'result', encoding: 'value' }
          : { kind, key: 'artifact-text:retained' };
      s.put('tool_operations', { id: 'operation', status: 'succeeded', result: content });
      s.setMetadata('artifact-text:retained', content);
      const original = artifact(
        join(root, 'artifacts', 'tool-result', 'tool-output.txt'),
        'conversation',
        source,
      );
      s.put('artifacts', original);
      const backup = new BackupService(core.state),
        created = await backup.create();
      expect(await readFile(join(created.path, 'artifacts', original.id), 'utf8')).toBe(content);
      expect(JSON.parse(await readFile(join(created.path, 'manifest.json'), 'utf8')).version).toBe(
        3,
      );

      await backup.restore(created.path);
      const restored = s.get<Artifact>('artifacts', original.id)!;
      expect(restored.contentSource).toBeUndefined();
      expect(await readFile(restored.path, 'utf8')).toBe(content);
      s.delete('tool_operations', 'operation');
      s.db.prepare('DELETE FROM metadata WHERE key = ?').run('artifact-text:retained');
      const second = await backup.create();
      expect(await readFile(join(second.path, 'artifacts', original.id), 'utf8')).toBe(content);
    },
  );

  it('删除会话前将被保留成果的原文落盘，也保留其他会话中引用同一操作的成果', async () => {
    const { core, root, bot } = await setup(async () => ({ text: '完成' }));
    core.scheduler.pause();
    const member = bot('成员'),
      s = core.state.storage;
    const room = core.entities.createConversation({
      name: '待删除',
      kind: 'private',
      memberIds: [member.id],
      workspaceId: core.state.snapshot().workspaces[0].id,
    });
    const task = core.tasks.create({
      conversationId: room.id,
      botId: member.id,
      goal: '读取工具资料',
    });
    s.put('runs', { id: 'source-run', taskId: task.id, status: 'completed' });
    s.put('tool_operations', {
      id: 'operation',
      runId: 'source-run',
      status: 'succeeded',
      result: content,
    });
    const original = {
      ...artifact(join(root, 'artifacts', 'tool-result', 'tool-output.txt'), room.id, {
        kind: 'tool-operation',
        operationId: 'operation',
        field: 'result',
        encoding: 'value',
      }),
      taskId: task.id,
    };
    s.put('artifacts', original);
    s.put('artifacts', {
      ...original,
      id: 'shared-result',
      path: join(root, 'artifacts', 'shared-result', 'tool-output.txt'),
      conversationId: 'other-room',
    });
    s.setMetadata(`context-projection:${task.id}:source`, { artifactId: original.id });
    s.setMetadata('artifact-text:unique', '需要长期保留的唯一原文');

    await new ConversationService(core.state, core.tasks, core.scheduler).delete(room.id);
    expect(s.get('tool_operations', 'operation')).toBeUndefined();
    expect(s.get('conversations', room.id)).toBeUndefined();
    for (const artifactId of [original.id, 'shared-result']) {
      const retained = s.get<Artifact>('artifacts', artifactId)!;
      expect(retained.contentSource).toBeUndefined();
      expect(await readFile(retained.path, 'utf8')).toBe(content);
    }
    expect(s.metadata(`context-projection:${task.id}:source`)).toBeUndefined();
    expect(s.metadata('artifact-text:unique')).toBe('需要长期保留的唯一原文');
    const backup = await new BackupService(core.state).create();
    expect(await readFile(join(backup.path, 'artifacts', original.id), 'utf8')).toBe(content);
  });

  it('原文无法通过校验时停止删除，保留原始记录与会话', async () => {
    const { core, root, bot } = await setup(async () => ({ text: '完成' }));
    core.scheduler.pause();
    const member = bot('成员'),
      s = core.state.storage;
    const room = core.entities.createConversation({
      name: '保留',
      kind: 'private',
      memberIds: [member.id],
      workspaceId: core.state.snapshot().workspaces[0].id,
    });
    const task = core.tasks.create({ conversationId: room.id, botId: member.id, goal: '保留资料' });
    s.put('runs', { id: 'source-run', taskId: task.id, status: 'completed' });
    s.put('tool_operations', {
      id: 'operation',
      runId: 'source-run',
      status: 'succeeded',
      result: '不匹配的内容',
    });
    s.put('artifacts', {
      ...artifact(join(root, 'artifacts', 'tool-result', 'tool-output.txt'), room.id, {
        kind: 'tool-operation',
        operationId: 'operation',
        field: 'result',
        encoding: 'value',
      }),
      taskId: task.id,
    });

    await expect(
      new ConversationService(core.state, core.tasks, core.scheduler).delete(room.id),
    ).rejects.toThrow();
    expect(s.get('conversations', room.id)).toBeDefined();
    expect(s.get('tasks', task.id)).toBeDefined();
    expect(s.get('tool_operations', 'operation')).toBeDefined();
  });
});
