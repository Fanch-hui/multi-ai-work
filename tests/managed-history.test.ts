import { afterEach, describe, expect, it } from 'vitest';
import { Storage } from '../src/core/storage.js';
import type { State } from '../src/core/state.js';
import type { ModelMessage, RunContext } from '../src/domain/provider.js';
import type { Message, Run } from '../src/domain/types.js';
import { ManagedHistory, type ProviderArchive } from '../src/core/managed-history.js';

const databases: Storage[] = [];
afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

function fixture() {
  const storage = new Storage(':memory:');
  databases.push(storage);
  const state = { storage } as State;
  const input = {
    runId: 'run',
    binding: { id: 'binding', generation: 1, conversationId: 'room' },
    bot: { id: 'bot' },
    connection: { protocol: 'responses' },
    messages: [],
    instructions: 'instructions',
    tools: [],
  } as unknown as RunContext;
  const source = storage.appendMessage({
    id: 'source',
    conversationId: 'room',
    authorType: 'user',
    content: 'input',
    artifactIds: [],
    status: 'committed',
    createdAt: '',
    sequence: 0,
  } as Message);
  storage.put('runs', { id: input.runId } as Run);
  const reply = storage.appendMessage({
    id: 'reply',
    conversationId: 'room',
    authorType: 'bot',
    authorBotId: 'bot',
    runId: input.runId,
    content: 'output',
    artifactIds: [],
    status: 'committed',
    createdAt: '',
    sequence: 0,
  } as Message);
  const messages: ModelMessage[] = [
    { role: 'user', content: 'input', sourceMessageId: source.id, sourceSequence: source.sequence },
    { role: 'assistant', content: 'output' },
  ];
  const histories = new ManagedHistory(state);
  return { storage, histories, input, source, reply, messages };
}

describe('managed history ownership', () => {
  it('commits complete evidence and a smaller working projection with original sources', () => {
    const f = fixture();
    f.storage.transaction(() =>
      f.histories.commit({
        input: f.input,
        messages: f.messages,
        draft: f.reply,
        cutoff: f.source.sequence,
        output: 'output',
        projected: [f.messages[1]],
      }),
    );
    expect(f.histories.has('binding')).toBe(true);
    expect(
      f.storage
        .get<ProviderArchive>('provider_archive', 'run')
        ?.entries.map((entry) => entry.message),
    ).toEqual(f.messages);
    const loaded = f.histories.load(f.input, f.storage.messages('room'), f.reply.sequence);
    expect(loaded.historyIsCurrent).toBe(true);
    expect(loaded.history).toEqual([
      { messageId: f.reply.id, sequence: f.reply.sequence, message: f.messages[1] },
    ]);
    expect(loaded.loadArchiveHistory()?.map((entry) => entry.message)).toEqual(f.messages);
  });

  it('propagates projection storage failures and rolls back the archive and delta clearing', () => {
    const f = fixture();
    f.storage.put('provider_archive', {
      id: 'run',
      bindingId: 'binding',
      entries: [],
      output: 'before',
    });
    f.storage.put('managed_progress_deltas', { id: 'delta', runId: 'run' });
    f.storage.db.exec(
      "CREATE TRIGGER fail_history BEFORE INSERT ON metadata WHEN NEW.key = 'history:binding' BEGIN SELECT RAISE(ABORT, 'history write failed'); END",
    );
    expect(() =>
      f.storage.transaction(() =>
        f.histories.commit({
          input: f.input,
          messages: f.messages,
          draft: f.reply,
          cutoff: f.source.sequence,
          output: 'output',
        }),
      ),
    ).toThrow('history write failed');
    expect(f.storage.get<ProviderArchive>('provider_archive', 'run')?.output).toBe('before');
    expect(f.storage.all('managed_progress_deltas')).toHaveLength(1);
    expect(f.histories.has('binding')).toBe(false);
  });
});
