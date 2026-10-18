import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import type { ManagedProgress, ManagedProgressChange, RunContext } from '../src/domain/provider.js';
import type { Message, Run, SessionBinding, Task } from '../src/domain/types.js';
import { Storage } from '../src/core/storage.js';
import { loadManagedProgress, progressForRun, recoverManagedRuns, saveManagedProgress } from '../src/core/managed-progress.js';
import { BackupService } from '../src/core/backup.js';
import type { State } from '../src/core/state.js';

const resources: { root: string; storage: Storage }[] = [];
afterEach(async () => {
  for (const item of resources.splice(0)) { item.storage.close(); await rm(item.root, { recursive: true, force: true }); }
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'managed-deltas-'));
  const resource = { root, storage: new Storage(join(root, 'team.sqlite')) }; resources.push(resource);
  const run = { id: 'run', taskId: 'task', status: 'running' } as Run;
  const task = { id: 'task', botId: 'bot', conversationId: 'room', status: 'interrupted', runIds: ['run'], resumeFromRunId: 'run' } as Task;
  const binding = { id: 'binding', generation: 1, workspaceId: 'workspace' } as SessionBinding;
  const draft = { id: 'draft' } as Message;
  const acknowledged: string[][] = [];
  const input = { userInput: { acknowledge: (ids: string[]) => { acknowledged.push(ids); } } } as RunContext;
  const calls = ['one', 'two', 'three'].map(id => ({ id, name: 'read_file', arguments: '{}' }));
  const progress: ManagedProgress = { messages: [{ role: 'user', content: 'source', sourceMessageId: 'input' },
    { role: 'assistant', content: 'working', toolCalls: calls, providerItems: [{ encrypted_content: 'opaque-state' }] }],
    currentStart: 0, archiveStart: 0, contextSignature: 'signature', text: 'working', pendingInputIds: ['input'],
    turnId: 'turn', attempt: 2, phase: 'tools', compaction: { archived: [{ role: 'user', content: 'full history' }], start: 1 } };
  const save = (change?: ManagedProgressChange) => saveManagedProgress(resource.storage, run, task, binding, draft, 5, input, progress, change);
  const result = (id: string) => {
    progress.messages.push({ role: 'tool', callId: id, content: `result-${id}` });
    save({ type: 'tool-result', assistantIndex: 1, callId: id });
  };
  save(); acknowledged.length = 0;
  return { ...resource, resource, run, task, binding, progress, save, result, acknowledged };
}

describe('incremental managed checkpoints', () => {
  it('reopens SQLite and restores out-of-order tool results in model call order once', async () => {
    const f = await fixture();
    const baseline = f.storage.get('provider_archive', f.run.id);
    f.result('three'); f.result('one');
    f.save({ type: 'tool-result', assistantIndex: 1, callId: 'one' });
    expect(f.storage.get('provider_archive', f.run.id)).toEqual(baseline);
    expect(f.storage.all('managed_progress_deltas')).toHaveLength(3);
    f.storage.close(); f.resource.storage = new Storage(join(f.root, 'team.sqlite'));
    const saved = loadManagedProgress(f.resource.storage, f.task, f.binding)!;
    expect(saved.progress.messages.filter(message => message.role === 'tool').map(message => message.callId)).toEqual(['one', 'three']);
    expect(saved.progress).toMatchObject({ currentStart: 0, archiveStart: 0, contextSignature: 'signature', attempt: 2,
      pendingInputIds: ['input'], compaction: f.progress.compaction });
    expect(saved.progress.messages[1].providerItems).toEqual(f.progress.messages[1].providerItems);
    expect(progressForRun(f.resource.storage, 'run')?.progress).toEqual(saved.progress);
  });

  it('serializes only the completed result and compacts deltas at a full boundary', async () => {
    const f = await fixture();
    f.storage.changes.take();
    Object.defineProperty(f.progress.messages[0], 'toJSON', { configurable: true, value: () => { throw new Error('history serialized'); } });
    f.result('two');
    expect(f.storage.changes.take().entities.size).toBe(0);
    expect(f.acknowledged).toEqual([['input']]);
    delete (f.progress.messages[0] as unknown as { toJSON?: unknown }).toJSON;
    f.progress.phase = 'ready'; f.progress.turnId = 'next-turn'; f.save();
    expect(f.storage.all('managed_progress_deltas')).toEqual([]);
    expect(progressForRun(f.storage, 'run')?.progress).toEqual(f.progress);
  });

  it('materializes deltas when recovering a crashed run before clearing them', async () => {
    const f = await fixture(); f.result('two');
    f.storage.put('runs', f.run); f.storage.put('tasks', f.task);
    recoverManagedRuns(f.storage, ['run']);
    expect(f.storage.get<Task>('tasks', 'task')).toMatchObject({ status: 'recovering', resumeFromRunId: 'run' });
    expect(f.storage.all('managed_progress_deltas')).toEqual([]);
    expect(progressForRun(f.storage, 'run')?.progress.messages.at(-1)).toMatchObject({ callId: 'two', content: 'result-two' });
    expect(loadManagedProgress(f.storage, f.task, f.binding)?.progress.messages.filter(message => message.role === 'tool')).toHaveLength(1);
  });

  it('blocks input acknowledgement when saving a tool delta fails', async () => {
    const f = await fixture();
    f.storage.db.exec("CREATE TRIGGER fail_delta BEFORE INSERT ON managed_progress_deltas BEGIN SELECT RAISE(ABORT, 'disk failure'); END");
    expect(() => f.result('one')).toThrow('disk failure');
    expect(f.acknowledged).toEqual([]);
    expect(progressForRun(f.storage, 'run')?.progress.messages.filter(message => message.role === 'tool')).toEqual([]);
  });

  it('seeds a complete baseline for a resumed run before accepting later deltas', async () => {
    const f = await fixture(); f.storage.delete('provider_archive', 'run');
    f.result('one');
    expect(f.storage.all('managed_progress_deltas')).toEqual([]);
    f.result('two');
    expect(f.storage.all('managed_progress_deltas')).toHaveLength(2);
    expect(progressForRun(f.storage, 'run')?.progress.messages.filter(message => message.role === 'tool')).toHaveLength(2);
  });

  it('replays the latest streaming assistant alongside already completed tool results', async () => {
    const f = await fixture();
    f.progress.messages[1].toolCalls = f.progress.messages[1].toolCalls!.slice(0, 1);
    f.save({ type: 'assistant-item', assistantIndex: 1 }); f.result('one');
    f.progress.messages[1].toolCalls!.push({ id: 'two', name: 'read_file', arguments: '{"path":"later"}' });
    f.progress.messages[1].providerItems!.push({ type: 'function_call', call_id: 'two' });
    f.progress.messages[1].content = 'new assistant text'; f.progress.text = 'new assistant text';
    f.progress.pendingInputIds = [];
    f.save({ type: 'assistant-item', assistantIndex: 1 }); f.result('two');
    const restored = loadManagedProgress(f.storage, f.task, f.binding)!;
    expect(restored.progress.messages[1]).toEqual(f.progress.messages[1]);
    expect(restored.progress.messages.slice(2).map(message => message.callId)).toEqual(['one', 'two']);
    expect(restored.progress).toMatchObject({ text: 'new assistant text', pendingInputIds: [], compaction: f.progress.compaction });
    expect(f.storage.all('managed_progress_deltas')).toHaveLength(4);
  });

  it.each([false, true])('restores backups with a delta table present: %s', async oldBackup => {
    const f = await fixture(); f.result('one');
    const state = { storage: f.storage, dataDirectory: f.root, changed: () => {} } as unknown as State;
    const backup = new BackupService(state), created = await backup.create();
    if (oldBackup) {
      const source = new Database(join(created.path, 'team.sqlite')); source.exec('DROP TABLE managed_progress_deltas'); source.close();
      await writeFile(join(created.path, 'manifest.json'), JSON.stringify({ version: 1, artifacts: [] }));
    }
    await backup.restore(created.path);
    expect(f.storage.all('managed_progress_deltas')).toEqual([]);
    expect(progressForRun(f.storage, 'run')).toBeUndefined();
  });
});
