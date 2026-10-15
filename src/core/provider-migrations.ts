import type { Bot, Connection, SessionBinding } from '../domain/types.js';
import type { Storage } from './storage.js';

type LegacyConnection = Omit<Connection, 'provider'> & {
  provider: string; geminiRuntime?: string; geminiAuthMode?: string;
};

export function migrateProviders(storage: Storage): void {
  storage.transaction(() => {
    const migrated = new Set<string>();
    for (const connection of storage.all<LegacyConnection>('connections')) {
      if (connection.provider !== 'gemini') continue;
      const { geminiRuntime, geminiAuthMode, ...current } = connection;
      storage.put('connections', { ...current, provider: 'antigravity',
        name: /^(Gemini|Gemini ACP)$/i.test(current.name) ? 'Antigravity CLI' : current.name,
        executable: undefined, executableMode: 'auto', authMode: 'local',
        model: undefined, models: [], version: undefined, accountScope: undefined,
        capabilities: undefined, error: undefined, status: 'untested', revision: current.revision + 1 });
      migrated.add(connection.id);
    }
    for (const bot of storage.all<Bot>('bots')) {
      if (migrated.has(bot.connectionId)) storage.put('bots', { ...bot, model: '', reasoning: undefined,
        contextWindow: undefined, outputReserve: undefined, revision: bot.revision + 1 });
    }
    for (const binding of storage.all<SessionBinding>('session_bindings')) {
      if (migrated.has(binding.connectionId)) storage.put('session_bindings', {
        ...binding, nativeSessionId: undefined, connectionRevision: -1 });
    }
  });
}
