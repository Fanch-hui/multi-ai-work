import { afterEach, describe, expect, it } from 'vitest';
import type { Artifact, Message, Run, Task } from '../src/domain/types.js';
import { Storage } from '../src/core/storage.js';
import { completeRunMessage } from '../src/core/run-message.js';
import { migrateReplyArtifacts } from '../src/core/reply-artifacts.js';
import { RunReplyWriter } from '../src/core/run-reply.js';

const time = '2026-10-19T12:00:00Z';
const opened: Storage[] = [];
afterEach(() => {
  for (const storage of opened.splice(0)) storage.close();
});

function setup() {
  const storage = new Storage(':memory:');
  opened.push(storage);
  const task: Task = {
    id: 'task',
    conversationId: 'room',
    botId: 'bot',
    goal: '完成报告',
    expectedOutput: '',
    dependencyIds: [],
    status: 'completed',
    runIds: ['run'],
    artifactIds: [],
    requestId: 'request',
    depth: 0,
    createdAt: time,
    updatedAt: time,
  };
  const run: Run = {
    id: 'run',
    taskId: task.id,
    botId: 'bot',
    bindingId: 'binding',
    status: 'completed',
    configRevision: 1,
    createdAt: time,
  };
  storage.put('tasks', task);
  storage.put('runs', run);
  return { storage, task, run };
}

function message(storage: Storage, id: string, extra: Partial<Message> = {}): Message {
  return storage.appendMessage({
    id,
    conversationId: 'room',
    authorType: 'bot',
    authorBotId: 'bot',
    runId: 'run',
    content: '',
    artifactIds: [],
    status: 'draft',
    createdAt: time,
    ...extra,
  });
}

function file(storage: Storage, id: string, extra: Partial<Artifact> = {}): Artifact {
  return storage.put('artifacts', {
    id,
    name: `${id}.txt`,
    path: `/artifacts/${id}.txt`,
    workingPath: '/work/report.txt',
    taskId: 'task',
    botId: 'bot',
    conversationId: 'room',
    mimeType: 'text/plain',
    sha256: id,
    size: 10,
    purpose: 'deliverable',
    createdAt: time,
    ...extra,
  });
}

describe('automatic reply artifact delivery', () => {
  it('keeps posted files once and adds only the latest unpublished deliverables', () => {
    const { storage } = setup();
    file(storage, 'old');
    file(storage, 'current', { createdAt: '2026-10-19T12:01:00Z' });
    file(storage, 'extra', { workingPath: '/work/notes.txt' });
    file(storage, 'preview', { workingPath: '/work/preview.png', purpose: 'intermediate' });
    message(storage, 'posted', {
      content: '文件已就绪',
      artifactIds: ['current'],
      status: 'committed',
    });
    const draft = message(storage, 'final');
    const completed = completeRunMessage(storage, draft, '详细说明', [
      'old',
      'current',
      'current',
      'extra',
      'preview',
    ]);
    expect(completed).toMatchObject({ content: '详细说明', artifactIds: ['extra'] });
    expect(storage.getMessage('posted')?.artifactIds).toEqual(['current']);
    expect(storage.all('artifacts')).toHaveLength(4);
  });

  it('keeps a new file when the final response is empty after a posted explanation', () => {
    const { storage } = setup();
    file(storage, 'report');
    message(storage, 'posted', { content: '开始交付', status: 'committed' });
    const completed = completeRunMessage(storage, message(storage, 'final'), '', ['report']);
    expect(completed).toMatchObject({ id: 'final', content: '', artifactIds: ['report'] });
  });

  it('does not append an empty final attachment bubble after files have been posted', () => {
    const { storage } = setup();
    file(storage, 'report');
    const posted = message(storage, 'posted', {
      artifactIds: ['report'],
      status: 'committed',
    });
    expect(completeRunMessage(storage, message(storage, 'final'), '', ['report'])).toEqual(posted);
    expect(storage.getMessage('final')).toBeUndefined();
  });

  it('retains file delivery across output boundaries and a resumed run', () => {
    const { storage, run } = setup();
    file(storage, 'report');
    message(storage, 'posted', { artifactIds: ['report'], status: 'committed' });
    storage.put('runs', { ...run, id: 'resumed', resumeFromRunId: run.id });
    const draft = message(storage, 'resumed-reply', { runId: 'resumed' });
    const writer = new RunReplyWriter(storage, draft, (error) => {
      throw error;
    });
    writer.append({
      id: 'progress',
      runId: 'resumed',
      type: 'text',
      data: { delta: '过程说明', messageKey: 'progress' },
      createdAt: time,
    });
    writer.next();
    writer.append({
      id: 'answer',
      runId: 'resumed',
      type: 'text',
      data: { delta: '最终说明', messageKey: 'answer' },
      createdAt: time,
    });
    writer.flush();
    writer.complete(writer.finalText('过程说明最终说明'), ['report']);
    writer.close();
    expect(storage.messages('room').map((item) => [item.content, item.artifactIds])).toEqual([
      ['', ['report']],
      ['过程说明', []],
      ['最终说明', []],
    ]);
  });
});

describe('saved automatic reply attachments', () => {
  it('repairs earlier final attachments and preserves files, text and explicit reposts', () => {
    const { storage } = setup();
    file(storage, 'old');
    file(storage, 'report', { createdAt: '2026-10-19T12:01:00Z' });
    const posted = message(storage, 'posted', {
      content: '交付文件',
      artifactIds: ['report'],
      status: 'committed',
    });
    const final = message(storage, 'final', {
      content: '最终说明',
      artifactIds: ['old', 'report'],
      status: 'committed',
    });
    storage.put('tool_operations', {
      id: 'post',
      runId: 'run',
      name: 'post_message',
      status: 'succeeded',
      result: { messageId: posted.id },
    });
    migrateReplyArtifacts(storage);
    expect(storage.getMessage(final.id)).toEqual({ ...final, artifactIds: [] });
    expect(storage.getMessage(posted.id)).toEqual(posted);
    expect(storage.all('artifacts')).toHaveLength(2);
    const repaired = storage.messages('room');
    migrateReplyArtifacts(storage);
    expect(storage.messages('room')).toEqual(repaired);
  });

  it('keeps the last explicit repost and files sent to another conversation', () => {
    const { storage } = setup();
    file(storage, 'report');
    message(storage, 'first', { artifactIds: ['report'], status: 'committed' });
    const posted = message(storage, 'repost', {
      content: '再次发送',
      artifactIds: ['report'],
      status: 'committed',
    });
    const shared = message(storage, 'shared', {
      conversationId: 'team',
      artifactIds: ['report'],
      status: 'committed',
    });
    storage.put('tool_operations', {
      id: 'repost',
      runId: 'run',
      name: 'post_message',
      status: 'succeeded',
      result: { messageId: posted.id },
    });
    migrateReplyArtifacts(storage);
    expect(storage.getMessage(posted.id)).toEqual(posted);
    expect(storage.getMessage(shared.id)).toEqual(shared);
    expect(storage.messages('room').flatMap((item) => item.artifactIds)).toEqual([
      'report',
      'report',
    ]);
  });

  it('propagates a storage failure and retries the repair after the transaction rolls back', () => {
    const { storage } = setup();
    file(storage, 'report');
    message(storage, 'posted', { artifactIds: ['report'], status: 'committed' });
    const final = message(storage, 'final', {
      content: '最终说明',
      artifactIds: ['report'],
      status: 'committed',
    });
    storage.db.exec(`CREATE TEMP TRIGGER reject_repair BEFORE UPDATE ON messages
      WHEN OLD.id = 'final' BEGIN SELECT RAISE(ABORT, 'fixture storage failure'); END`);
    expect(() => migrateReplyArtifacts(storage)).toThrow('fixture storage failure');
    expect(storage.getMessage('final')).toEqual(final);
    expect(storage.metadata('reply-artifact-delivery-v1')).toBeUndefined();
    storage.db.exec('DROP TRIGGER reject_repair');
    migrateReplyArtifacts(storage);
    expect(storage.getMessage('final')).toEqual({ ...final, artifactIds: [] });
    expect(storage.metadata('reply-artifact-delivery-v1')).toBe(true);
  });
});
