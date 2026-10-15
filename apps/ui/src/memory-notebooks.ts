import type { Bot, MemoryEntry, Snapshot } from '../../../src/domain/types.js';

export interface MemoryNotebookData {
  id: string;
  name: string;
  bot?: Bot;
  entries: MemoryEntry[];
  target: Pick<MemoryEntry, 'scope' | 'ownerId'>;
}
type Data = Pick<Snapshot, 'bots' | 'memories' | 'settings'>;

export function memoryNotebooks(data: Data, query = ''): MemoryNotebookData[] {
  const entries = data.memories.filter(entry => entry.status === 'approved' || entry.status === 'candidate');
  const groups = new Map<string, MemoryNotebookData>();
  const bots = [...data.bots].sort((a, b) => Number(b.id === data.settings.mainBotId) - Number(a.id === data.settings.mainBotId));
  for (const bot of bots) {
    if (bot.archived && !entries.some(entry => entry.scope === 'bot' && entry.ownerId === bot.id)) continue;
    groups.set(bot.id, { id: bot.id, name: bot.name, bot, entries: [], target: { scope: 'bot', ownerId: bot.id } });
  }
  const publicNotebook: MemoryNotebookData = { id: 'public', name: '团队公共记忆', entries: [], target: { scope: 'shared', ownerId: 'shared' } };
  for (const entry of entries) {
    if (entry.scope !== 'bot') { publicNotebook.entries.push(entry); continue; }
    const group: MemoryNotebookData = groups.get(entry.ownerId) ?? { id: entry.ownerId, name: '已移除成员', entries: [], target: { scope: 'bot', ownerId: entry.ownerId } };
    group.entries.push(entry);
    groups.set(entry.ownerId, group);
  }
  const notebooks = [...groups.values(), publicNotebook];
  for (const notebook of notebooks) notebook.entries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const needle = query.trim().toLocaleLowerCase();
  return notebooks.filter(notebook => notebook.name.toLocaleLowerCase().includes(needle)
    || notebook.bot?.role.toLocaleLowerCase().includes(needle)
    || notebook.entries.some(entry => entry.content.toLocaleLowerCase().includes(needle)));
}
