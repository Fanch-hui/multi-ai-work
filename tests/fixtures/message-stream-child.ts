import { Storage } from '../../src/core/storage.js';

const storage = new Storage(process.argv[2]);
storage.appendMessage({ id: 'message', conversationId: 'room', authorType: 'bot', runId: 'run',
  content: '', artifactIds: [], status: 'draft', createdAt: '2026-10-15T12:00:00Z' });
for (const [index, data] of [{ delta: '旧文字' }, { replace: '新文字' }, { delta: '，已保存尾文。' }].entries()) {
  storage.messageStream.append({ id: `fragment-${index}`, runId: 'run', type: 'text', data,
    createdAt: '2026-10-15T12:00:00Z' }, 'message');
}
const row = storage.prepare('SELECT stream_sequence FROM messages WHERE id = ?').get('message');
process.send?.({ type: 'persisted', row });
setInterval(() => {}, 1000);
