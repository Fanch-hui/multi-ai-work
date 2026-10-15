import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Bot, Connection, SessionBinding } from '../src/domain/types.js';
import { Storage } from '../src/core/storage.js';
import { migrateProviders } from '../src/core/provider-migrations.js';

let storage: Storage | undefined, folder: string | undefined;
afterEach(async () => { storage?.close(); if (folder) await rm(folder, { recursive: true, force: true }); });

describe('原生供应商迁移', () => {
  it('保留智能体、原始消息与历史绑定，更新连接并使旧原生会话失效，重复执行不改写数据', async () => {
    folder = await mkdtemp(join(tmpdir(), 'multi-ai-provider-migration-'));
    storage = new Storage(join(folder, 'team.sqlite'));
    storage.put('connections', { id: 'native', name: 'Gemini ACP', provider: 'gemini', concurrency: 3,
      status: 'error', error: '旧错误', executable: '/old/runtime', executableMode: 'explicit',
      profilePath: join(folder, 'profile'), model: 'old-model', models: [{ id: 'old-model' }],
      geminiAuthMode: 'app', geminiRuntime: 'gemini-cli', accountScope: 'old-scope', revision: 2, createdAt: 'before' });
    const managed: Connection = { id: 'managed', name: 'ChatGPT', provider: 'chatgpt', concurrency: 1,
      status: 'ready', models: [], revision: 4, createdAt: 'before' };
    storage.put('connections', managed);
    const bot: Bot = { id: 'member', connectionId: 'native', name: '助手', role: '研究', instructions: '查证资料',
      model: 'old-model', reasoning: 'high', color: 'blue', toolNames: ['list_bots'], skillIds: [],
      memoryMode: 'manual', revision: 5, archived: false };
    storage.put('bots', bot);
    const binding: SessionBinding = { id: 'binding', botId: bot.id, conversationId: 'room', connectionId: 'native',
      generation: 3, configRevision: 5, connectionRevision: 2, workspaceId: 'workspace',
      nativeSessionId: 'old-native-session', lastDeliveredSequence: 2 };
    storage.put('session_bindings', binding);
    const message = storage.appendMessage({ id: 'message', conversationId: 'room', authorType: 'bot',
      authorBotId: bot.id, content: '原始答复', artifactIds: [], status: 'committed', createdAt: 'before' });
    migrateProviders(storage);
    expect(storage.get<Connection>('connections', 'native')).toMatchObject({ id: 'native', provider: 'antigravity',
      name: 'Antigravity CLI', executableMode: 'auto', status: 'untested', models: [], revision: 3, concurrency: 3 });
    expect(storage.get<Connection>('connections', 'native')).not.toHaveProperty('geminiAuthMode');
    expect(storage.get<Connection>('connections', 'managed')).toEqual(managed);
    expect(storage.get<Bot>('bots', bot.id)).toEqual({ ...bot, model: '', reasoning: undefined, revision: 6 });
    expect(storage.get<SessionBinding>('session_bindings', binding.id)).toEqual({ ...binding,
      nativeSessionId: undefined, connectionRevision: -1 });
    expect(storage.messages()).toEqual([message]);
    const snapshot = { connections: storage.all('connections'), bots: storage.all('bots'), bindings: storage.all('session_bindings') };
    migrateProviders(storage);
    expect({ connections: storage.all('connections'), bots: storage.all('bots'), bindings: storage.all('session_bindings') }).toEqual(snapshot);
  });
});
