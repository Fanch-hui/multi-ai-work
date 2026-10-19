import { fork } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Message, RunEvent, Task } from '../src/domain/types.js';
import { RunTextWriter } from '../src/core/message-stream.js';
import { Storage } from '../src/core/storage.js';
import { taskActivity } from '../src/core/task-activity.js';

const at = '2026-10-15T12:00:00Z';
const temporary: { directory: string; storage?: Storage }[] = [];
const draft = (id = 'message', runId = 'run'): Omit<Message, 'sequence'> => ({
  id,
  conversationId: 'room',
  authorType: 'bot',
  runId,
  content: '',
  artifactIds: [],
  status: 'draft',
  createdAt: at,
});
const text = (id: string, data: RunEvent['data'], runId = 'run', createdAt = at): RunEvent => ({
  id,
  runId,
  type: 'text',
  data,
  createdAt,
});
function open() {
  const directory = mkdtempSync(join(tmpdir(), 'message-stream-'));
  const item = { directory, storage: new Storage(join(directory, 'test.sqlite')) };
  temporary.push(item);
  item.storage.appendMessage(draft());
  return item.storage;
}
function persisted(storage: Storage, id = 'message') {
  const row = storage
    .prepare('SELECT payload, stream_sequence FROM messages WHERE id = ?')
    .get(id) as { payload: string; stream_sequence: number };
  return { message: JSON.parse(row.payload) as Message, sequence: row.stream_sequence };
}
function allEvents(storage: Storage): RunEvent[] {
  return (
    storage.prepare('SELECT payload FROM run_events ORDER BY rowid').all() as { payload: string }[]
  ).map((row) => JSON.parse(row.payload) as RunEvent);
}
afterEach(() => {
  vi.useRealTimers();
  for (const item of temporary.splice(0)) {
    if (item.storage?.db.open) item.storage.close();
    rmSync(item.directory, { recursive: true, force: true });
  }
});

describe('逐段持久化的流式消息', () => {
  it('快照立即投影追加与替换，重复事件及反复合并不造成重复或遗漏', () => {
    const storage = open();
    const first = text('first', { delta: '旧' });
    storage.messageStream.append(first, 'message');
    storage.messageStream.append(first, 'message');
    storage.messageStream.append(text('second', { delta: '草稿' }), 'message');
    expect(storage.getMessage('message')?.content).toBe('旧草稿');
    expect(persisted(storage).message.content).toBe('');
    storage.messageStream.flush('message');
    expect(persisted(storage)).toMatchObject({ sequence: 2, message: { content: '旧草稿' } });
    storage.messageStream.append(text('replace', { replace: '最终' }), 'message');
    storage.messageStream.append(text('third', { delta: '答复' }), 'message');
    expect(storage.messages('room')[0].content).toBe('最终答复');
    storage.messageStream.flush('message');
    storage.messageStream.flush('message');
    expect(persisted(storage)).toMatchObject({ sequence: 4, message: { content: '最终答复' } });
    expect(allEvents(storage).map((event) => event.data.streamSequence)).toEqual([1, 2, 3, 4]);
  });

  it('旧格式、其他运行和已提交或已废弃消息事件不参与正文重放', () => {
    const storage = open();
    storage.event(text('legacy', { delta: '历史事件' }));
    expect(storage.messageStream.append(text('missing-msg', { delta: '不存在' }), 'missing')).toBe(
      false,
    );
    expect(
      storage.messageStream.append(text('wrong-run', { delta: '串入' }, 'another-run'), 'message'),
    ).toBe(false);
    expect(storage.messageStream.append(text('actual-1', { delta: '正' }), 'message')).toBe(true);
    expect(storage.messageStream.append(text('actual-2', { delta: '确' }), 'message')).toBe(true);
    const projected = storage.getMessage('message')!;
    expect(projected.content).toBe('正确');
    storage.updateMessage({ ...projected, status: 'committed' });
    expect(storage.messageStream.append(text('late', { delta: '迟到' }), 'message')).toBe(false);
    storage.appendMessage({ ...draft('discarded-msg'), status: 'discarded' as Message['status'] });
    expect(
      storage.messageStream.append(text('discarded-delta', { delta: '废弃' }), 'discarded-msg'),
    ).toBe(false);
    storage.messageStream.flush('message');
    storage.messageStream.flush('discarded-msg');
    expect(storage.getMessage('message')).toMatchObject({ status: 'committed', content: '正确' });
    expect(storage.getMessage('discarded-msg')?.content).toBe('');
    expect(
      allEvents(storage)
        .filter((event) => ['actual-1', 'actual-2'].includes(event.id))
        .map((event) => event.data.streamSequence),
    ).toEqual([1, 2]);
    expect(
      allEvents(storage)
        .filter((event) =>
          ['legacy', 'missing-msg', 'wrong-run', 'late', 'discarded-delta'].includes(event.id),
        )
        .every((event) => event.data.streamSequence === undefined),
    ).toBe(true);
  });

  it('定时合并减少完整正文写入，并保持每个已提交片段可见', () => {
    vi.useFakeTimers();
    const storage = open(),
      writer = new RunTextWriter(storage, (error) => {
        throw error;
      });
    storage.db.exec(`CREATE TABLE message_writes (id INTEGER);
      CREATE TRIGGER count_message_writes AFTER UPDATE ON messages BEGIN INSERT INTO message_writes VALUES (1); END`);
    for (let index = 0; index < 500; index++)
      writer.append(text(`delta-${index}`, { delta: '文' }), 'message');
    expect(storage.getMessage('message')?.content).toBe('文'.repeat(500));
    expect(storage.prepare('SELECT COUNT(*) AS count FROM message_writes').get()).toEqual({
      count: 0,
    });
    vi.advanceTimersByTime(120);
    expect(persisted(storage).message.content).toBe('文'.repeat(500));
    expect(storage.prepare('SELECT COUNT(*) AS count FROM message_writes').get()).toEqual({
      count: 1,
    });
    expect(storage.prepare('SELECT COUNT(*) AS count FROM run_events').get()).toEqual({
      count: 500,
    });
    writer.close();
  });

  it('切换回复、替换及关闭立即合并，旧定时器不覆盖提交或复活删除消息', () => {
    vi.useFakeTimers();
    const storage = open(),
      writer = new RunTextWriter(storage, (error) => {
        throw error;
      });
    storage.appendMessage(draft('next'));
    writer.append(text('first', { delta: '旧回复' }), 'message');
    writer.append(text('next-first', { delta: '重试前' }), 'next');
    expect(persisted(storage).message.content).toBe('旧回复');
    writer.append(text('replace', { replace: '重试后' }), 'next');
    expect(persisted(storage, 'next').message.content).toBe('重试前');
    storage.updateMessage({
      ...storage.getMessage('message')!,
      content: '已发布',
      status: 'committed',
    });
    storage.deleteMessage('next');
    vi.advanceTimersByTime(120);
    expect(storage.getMessage('message')?.content).toBe('已发布');
    expect(storage.getMessage('next')).toBeUndefined();
    storage.appendMessage(draft('last'));
    writer.append(text('last', { delta: '最后回复' }), 'last');
    storage.updateMessage({ ...storage.getMessage('last')!, status: 'committed' });
    vi.advanceTimersByTime(120);
    expect(storage.getMessage('last')).toMatchObject({ content: '最后回复', status: 'committed' });
    storage.appendMessage(draft('close'));
    writer.append(text('close', { delta: '关闭前尾文' }), 'close');
    writer.close();
    expect(persisted(storage, 'close').message.content).toBe('关闭前尾文');
    expect(persisted(storage, 'last').message.content).toBe('最后回复');
    vi.runAllTimers();
    expect(storage.getMessage('message')?.content).toBe('已发布');
  });

  it('SQLite 拒绝片段写入时，失败内容不会进入正文投影', () => {
    const storage = open(),
      writer = new RunTextWriter(storage, () => {});
    storage.db.exec(`CREATE TRIGGER reject_fragment BEFORE INSERT ON run_events BEGIN
      SELECT RAISE(ABORT, '片段写入失败'); END`);
    expect(() => writer.append(text('rejected', { delta: '未保存' }), 'message')).toThrow(
      '片段写入失败',
    );
    expect(storage.getMessage('message')?.content).toBe('');
    expect(allEvents(storage)).toEqual([]);
    writer.close();
  });

  it('定时合并读取失败上报错误，已提交片段保留供恢复', () => {
    vi.useFakeTimers();
    const storage = open(),
      failed = vi.fn(),
      writer = new RunTextWriter(storage, failed);
    writer.append(text('saved', { delta: '已保存' }), 'message');
    const original = storage.messageStream.project.bind(storage.messageStream);
    const failRead = vi.spyOn(storage.messageStream, 'project').mockImplementation(() => {
      throw new Error('读取失败');
    });
    vi.advanceTimersByTime(120);
    expect(failed).toHaveBeenCalledOnce();
    expect(() => writer.append(text('not-saved', { delta: '未保存' }), 'message')).toThrow(
      '读取失败',
    );
    failRead.mockRestore();
    expect(
      original({ payload: JSON.stringify(persisted(storage).message), stream_sequence: 0 }).message
        .content,
    ).toBe('已保存');
    expect(allEvents(storage)).toHaveLength(1);
    storage.messageStream.recover();
    expect(persisted(storage).message.content).toBe('已保存');
  });

  it('合并事务写失败不推进游标，已提交片段可在恢复时完整合并', () => {
    vi.useFakeTimers();
    const storage = open(),
      failed = vi.fn(),
      writer = new RunTextWriter(storage, failed);
    writer.append(text('saved', { delta: '已保存' }), 'message');
    storage.db.exec(`CREATE TRIGGER reject_message BEFORE UPDATE ON messages BEGIN
      SELECT RAISE(ABORT, '正文写入失败'); END`);
    vi.advanceTimersByTime(120);
    expect(failed.mock.calls[0][0].message).toContain('正文写入失败');
    expect(persisted(storage)).toMatchObject({ sequence: 0, message: { content: '' } });
    expect(storage.getMessage('message')?.content).toBe('已保存');
    storage.db.exec('DROP TRIGGER reject_message');
    storage.messageStream.recover();
    storage.messageStream.recover();
    expect(persisted(storage)).toMatchObject({ sequence: 1, message: { content: '已保存' } });
  });

  it('文本与替换保留真实活动时间，正文合并不制造新模型活动', () => {
    const storage = open();
    const task: Task = {
      id: 'task',
      botId: 'bot',
      conversationId: 'room',
      status: 'running',
      runIds: ['run'],
      dependencyIds: [],
      artifactIds: [],
      goal: '',
      expectedOutput: '',
      requestId: 'request',
      depth: 0,
      createdAt: at,
      updatedAt: at,
    };
    storage.put('runs', {
      id: 'run',
      taskId: 'task',
      botId: 'bot',
      bindingId: 'binding',
      status: 'running',
      configRevision: 1,
      createdAt: at,
    });
    const activityAt = '2026-10-15T12:00:01Z';
    storage.messageStream.append(text('actual', { delta: '正文' }, 'run', activityAt), 'message');
    storage.messageStream.append(
      text('retry-replace', { replace: '' }, 'run', '2026-10-15T12:00:02Z'),
      'message',
    );
    storage.messageStream.flush('message');
    expect(taskActivity(storage, task)).toMatchObject({
      phase: 'responding',
      lastModelActivityAt: activityAt,
      lastActivityAt: activityAt,
    });
  });

  it('子进程强杀后恢复已提交但尚未合并的追加和替换，不重不漏', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'message-stream-kill-'));
    const item: { directory: string; storage?: Storage } = { directory };
    temporary.push(item);
    const file = join(directory, 'test.sqlite');
    const child = fork(
      fileURLToPath(new URL('./fixtures/message-stream-child.ts', import.meta.url)),
      [file],
      {
        execArgv: [
          '--import',
          pathToFileURL(createRequire(import.meta.url).resolve('tsx/esm')).href,
        ],
        stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      },
    );
    let stderr = '',
      timer: ReturnType<typeof setTimeout> | undefined;
    child.stderr?.on('data', (chunk) => {
      stderr += String(chunk);
    });
    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
    try {
      const ack = await new Promise<unknown>((resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`片段保存未确认: ${stderr}`)), 10000);
        child.once('message', resolve);
        child.once('error', reject);
        child.once('exit', () => reject(new Error(`片段保存前退出: ${stderr}`)));
      });
      expect(ack).toEqual({ type: 'persisted', row: { stream_sequence: 0 } });
      child.kill('SIGKILL');
      await exited;
      item.storage = new Storage(file);
      expect(persisted(item.storage)).toMatchObject({
        sequence: 3,
        message: { content: '新文字，已保存尾文。' },
      });
      item.storage.close();
      item.storage = new Storage(file);
      expect(item.storage.messages('room')[0].content).toBe('新文字，已保存尾文。');
    } finally {
      clearTimeout(timer);
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await exited;
    }
  }, 15000);
});
