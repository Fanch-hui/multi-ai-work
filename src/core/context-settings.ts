import type { Bot, Connection } from '../domain/types.js';
import type { Storage } from './storage.js';

type LegacyConnection = Connection & { contextWindow?: number; model?: string; outputReserve?: number };

export function migrateContextSettings(storage: Storage): void {
  storage.transaction(() => {
    const bots = storage.all<Bot>('bots');
    for (const connection of storage.all<LegacyConnection>('connections')) {
      if (!['contextWindow', 'model', 'outputReserve'].some(key => Object.hasOwn(connection, key))) continue;
      const { contextWindow, model, outputReserve, ...current } = connection;
      const managed = connection.provider === 'chatgpt' || connection.provider === 'custom';
      for (const bot of bots.filter(item => item.connectionId === connection.id)) {
        const inherited = { ...bot, model: bot.model || model || '',
          contextWindow: bot.contextWindow ?? (managed ? contextWindow : undefined),
          outputReserve: bot.outputReserve ?? (managed ? outputReserve : undefined) };
        if (inherited.model === bot.model && inherited.contextWindow === bot.contextWindow && inherited.outputReserve === bot.outputReserve) continue;
        storage.put('bots', { ...inherited, revision: bot.revision + 1 });
      }
      storage.put('connections', current);
    }
  });
}
