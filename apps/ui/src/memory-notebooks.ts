import type { Bot, MemoryEntry, Snapshot } from '../../../src/domain/types.js';
import {
  computeMemoryBudgetTokens, estimateMemoryTokens, memoryTopic,
} from '../../../src/domain/memory.js';

export interface MemoryTopicGroup {
  topic: string;
  entries: MemoryEntry[];
}

export interface MemoryNotebookData {
  id: string;
  name: string;
  bot?: Bot;
  entries: MemoryEntry[];
  target: Pick<MemoryEntry, 'scope' | 'ownerId'>;
  pinnedCount: number;
  pinnedTokens: number;
  budgetTokens: number;
  pinnedCapTokens: number;
  overflowIds: string[];
}

type Data = Pick<Snapshot, 'bots' | 'memories' | 'settings'>;

export function matchesMemoryQuery(entry: MemoryEntry, rawQuery: string): boolean {
  const needle = rawQuery.trim().toLocaleLowerCase();
  if (!needle) return true;
  if (entry.content.toLocaleLowerCase().includes(needle)) return true;
  if (entry.topic?.toLocaleLowerCase().includes(needle)) return true;
  if (entry.summary?.toLocaleLowerCase().includes(needle)) return true;
  if (entry.tags?.some(tag => tag.toLocaleLowerCase().includes(needle))) return true;
  return false;
}

export function groupMemoriesByTopic(entries: MemoryEntry[]): MemoryTopicGroup[] {
  const groups = new Map<string, MemoryEntry[]>();
  for (const entry of entries) {
    const topic = memoryTopic(entry);
    const list = groups.get(topic) ?? [];
    list.push(entry);
    groups.set(topic, list);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => {
      if (a === '未分类' && b !== '未分类') return 1;
      if (b === '未分类' && a !== '未分类') return -1;
      return a.localeCompare(b, 'zh-CN');
    })
    .map(([topic, items]) => ({ topic, entries: items }));
}

function enrichNotebook(notebook: Omit<MemoryNotebookData, 'pinnedCount' | 'pinnedTokens' | 'budgetTokens' | 'pinnedCapTokens' | 'overflowIds'>, mainBot?: Bot): MemoryNotebookData {
  notebook.entries.sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned) || b.updatedAt.localeCompare(a.updatedAt));
  const budgetOwner = notebook.bot ?? mainBot;
  const budgetTokens = computeMemoryBudgetTokens(budgetOwner?.contextWindow);
  const pinnedCapTokens = Math.floor(budgetTokens * 0.6);
  const pinnedEntries = notebook.entries
    .filter(entry => entry.pinned)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  let pinnedTokens = 0;
  let usedPinnedTokens = 0;
  const overflowIds: string[] = [];
  for (const entry of pinnedEntries) {
    const cost = estimateMemoryTokens(entry.content) + 12;
    pinnedTokens += cost;
    if (usedPinnedTokens + cost <= pinnedCapTokens) {
      usedPinnedTokens += cost;
    } else {
      overflowIds.push(entry.id);
    }
  }
  return {
    ...notebook,
    pinnedCount: pinnedEntries.length,
    pinnedTokens,
    budgetTokens,
    pinnedCapTokens,
    overflowIds,
  };
}

export function memoryNotebooks(data: Data, query = ''): MemoryNotebookData[] {
  const entries = data.memories.filter(entry => entry.status === 'approved' || entry.status === 'candidate');
  const groups = new Map<string, Omit<MemoryNotebookData, 'pinnedCount' | 'pinnedTokens' | 'budgetTokens' | 'pinnedCapTokens' | 'overflowIds'>>();
  const bots = [...data.bots].sort((a, b) => Number(b.id === data.settings.mainBotId) - Number(a.id === data.settings.mainBotId));
  const mainBot = data.bots.find(bot => bot.id === data.settings.mainBotId);
  for (const bot of bots) {
    if (bot.archived && !entries.some(entry => entry.scope === 'bot' && entry.ownerId === bot.id)) continue;
    groups.set(bot.id, { id: bot.id, name: bot.name, bot, entries: [], target: { scope: 'bot', ownerId: bot.id } });
  }
  const publicNotebook: Omit<MemoryNotebookData, 'pinnedCount' | 'pinnedTokens' | 'budgetTokens' | 'pinnedCapTokens' | 'overflowIds'> = {
    id: 'public',
    name: '团队公共记忆',
    entries: [],
    target: { scope: 'shared', ownerId: 'shared' },
  };
  for (const entry of entries) {
    if (entry.scope !== 'bot') {
      publicNotebook.entries.push(entry);
      continue;
    }
    const group = groups.get(entry.ownerId) ?? {
      id: entry.ownerId,
      name: '已移除成员',
      entries: [],
      target: { scope: 'bot' as const, ownerId: entry.ownerId },
    };
    group.entries.push(entry);
    groups.set(entry.ownerId, group);
  }
  const notebooks = [...groups.values(), publicNotebook].map(item => enrichNotebook(item, mainBot));
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return notebooks;
  return notebooks.filter(notebook =>
    notebook.name.toLocaleLowerCase().includes(needle)
    || notebook.bot?.role.toLocaleLowerCase().includes(needle)
    || notebook.entries.some(entry => matchesMemoryQuery(entry, needle)),
  );
}
