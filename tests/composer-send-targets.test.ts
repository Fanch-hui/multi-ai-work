import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Bot, Connection, Conversation, Task, Workspace } from '../src/domain/types.js';
import { State } from '../src/core/state.js';
import { TaskService } from '../src/core/tasks.js';
import { ComposerDraftStore, composerSubmission } from '../apps/ui/src/composer-drafts.js';

const resources: { state: State; root: string }[] = [];
afterEach(async () => {
  for (const { state, root } of resources.splice(0)) {
    state.storage.close(); await rm(root, { recursive: true, force: true });
  }
});
async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'composer-targets-')), state = new State(root);
  resources.push({ state, root });
  const connection: Connection = { id: 'connection', name: 'test', provider: 'custom', status: 'ready', models: [], concurrency: 1,
    revision: 1, createdAt: new Date().toISOString() };
  state.storage.put('connections', connection);
  for (const id of ['selected', 'other-a', 'other-b']) state.storage.put('bots', {
    id, name: id, role: '', instructions: '', connectionId: connection.id, model: 'test', color: '',
    toolNames: [], skillIds: [], memoryMode: 'off', revision: 1, archived: false,
  } satisfies Bot);
  const room: Conversation = { id: 'group', name: 'group', kind: 'group', memberIds: ['selected', 'other-a', 'other-b'],
    workspaceId: state.storage.all<Workspace>('workspaces')[0].id, createdAt: new Date().toISOString() };
  state.storage.put('conversations', room);
  const drafts = new ComposerDraftStore(), tasks = new TaskService(state);
  return { state, room, drafts, tasks };
}

describe('composer send targets', () => {
  it.each(['removed', 'archived'])('rejects a %s explicit recipient and retains the original draft', async reason => {
    const { state, room, drafts, tasks } = await setup();
    drafts.edit(room.id, { content: '仅发给选定成员', targets: ['selected'] });
    if (reason === 'removed') room.memberIds = ['other-a', 'other-b'];
    else state.storage.put('bots', { ...state.storage.get<Bot>('bots', 'selected')!, archived: true });
    state.storage.put('conversations', room);
    const pending = drafts.beginSend(room.id)!;
    const input = composerSubmission(room, pending);
    expect(input.targetBotIds).toEqual(['selected']);
    expect(() => tasks.send(input)).toThrow('有效成员');
    drafts.finishSend(room.id, pending.requestId, '智能体不是当前会话的有效成员');
    expect(drafts.read(room.id)).toMatchObject({ content: pending.content, targets: ['selected'],
      requestId: pending.requestId, sending: false });
    expect(state.storage.messages(room.id)).toEqual([]);
    expect(state.storage.all('tasks')).toEqual([]);

    drafts.edit(room.id, { targets: ['other-a'] });
    const retry = drafts.beginSend(room.id)!;
    tasks.send(composerSubmission(room, retry));
    drafts.finishSend(room.id, retry.requestId);
    expect(state.storage.all<Task>('tasks').map(task => task.botId)).toEqual(['other-a']);
    expect(drafts.read(room.id).content).toBe('');
  });

  it('still broadcasts a group draft without explicit recipients', async () => {
    const { state, room, drafts, tasks } = await setup();
    drafts.edit(room.id, { content: '所有成员请回复' });
    const input = composerSubmission(room, drafts.beginSend(room.id)!);
    expect(input.targetBotIds).toBeUndefined();
    tasks.send(input);
    expect(state.storage.all<Task>('tasks').map(task => task.botId)).toEqual(room.memberIds);
  });
});
