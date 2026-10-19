import type {
  MemoryDirectory,
  MemoryEntry,
  MemorySelection,
  MemoryTopicDirectoryItem,
  MemoryUsage,
} from '../domain/memory.js';
import { memorySummary, memoryTopic } from '../domain/memory.js';
import { estimateTokens } from './model-history.js';

const stopWords = new Set([
  '请帮我',
  '帮我',
  '请问',
  '一下',
  '一个',
  '我们',
  '你们',
  '他们',
  '这个',
  '那个',
  '进行',
  '完成',
  '处理',
  '当前',
  '任务',
  '用户',
  '以后',
  '需要',
  '可以',
  '什么',
  '怎么',
  '如何',
  '继续',
  '工作',
  '当前任务',
  '交付要求',
]);

export interface QueryTerms {
  ftsTerms: string[];
  shortTerms: string[];
  allTerms: string[];
  ftsQuery?: string;
}

export function extractQueryTerms(query: string): QueryTerms {
  const normalized = query.toLocaleLowerCase().trim();
  if (!normalized) return { ftsTerms: [], shortTerms: [], allTerms: [] };
  const rawTokens = normalized.match(/[\p{L}\p{N}_-]+/gu) ?? [];
  const asciiTokens = normalized.match(/[a-z0-9_-]+/gu) ?? [];
  const hanWords = normalized.match(/[\p{Script=Han}]+/gu) ?? [];
  const ftsSet = new Set<string>();
  const shortSet = new Set<string>();

  for (const token of asciiTokens) {
    if (stopWords.has(token) && rawTokens.length > 1) continue;
    const chars = Array.from(token);
    if (chars.length >= 3) ftsSet.add(token);
    else if (chars.length >= 2 || (rawTokens.length === 1 && !hanWords.length)) shortSet.add(token);
  }

  for (const word of hanWords) {
    const cleaned = rawTokens.length > 1 || hanWords.length > 1 ? stripHanStopWords(word) : [word];
    for (const segment of cleaned) {
      const chars = Array.from(segment);
      if (chars.length === 0) continue;
      if (chars.length === 1 && hanWords.length === 1 && rawTokens.length === 1) {
        shortSet.add(segment);
        continue;
      }
      if (chars.length === 2) {
        shortSet.add(segment);
        continue;
      }
      if (chars.length >= 3) {
        if (chars.length <= 6) ftsSet.add(segment);
        for (let i = 0; i <= chars.length - 3 && ftsSet.size < 24; i++) {
          const trigram = chars.slice(i, i + 3).join('');
          if (!stopWords.has(trigram)) ftsSet.add(trigram);
        }
        for (let i = 0; i <= chars.length - 2 && shortSet.size < 32; i++) {
          const bigram = chars.slice(i, i + 2).join('');
          if (!stopWords.has(bigram)) shortSet.add(bigram);
        }
      }
    }
  }

  if (!ftsSet.size && !shortSet.size) {
    for (const token of rawTokens.slice(0, 8)) {
      if (Array.from(token).length >= 3) ftsSet.add(token);
      else shortSet.add(token);
    }
  }

  const ftsTerms = [...ftsSet].slice(0, 24);
  const shortTerms = [...shortSet].slice(0, 32);
  const allTerms = [...new Set([...ftsTerms, ...shortTerms])];
  const ftsQuery = ftsTerms.length
    ? ftsTerms.map((term) => `"${term.replaceAll('"', '""')}"`).join(' OR ')
    : undefined;
  return { ftsTerms, shortTerms, allTerms, ftsQuery };
}

function stripHanStopWords(word: string): string[] {
  let result = [word];
  for (const stop of stopWords) {
    if (Array.from(stop).length < 2) continue;
    result = result.flatMap((part) => part.split(stop).filter(Boolean));
  }
  return result.length ? result : [word];
}

export interface ScoredMemory {
  entry: MemoryEntry;
  relevanceScore: number;
  totalScore: number;
}

export function scoreMemoryEntry(
  entry: MemoryEntry,
  terms: QueryTerms,
  options?: { ftsRank?: number; roleTerms?: string[]; usage?: MemoryUsage },
): ScoredMemory {
  const content = entry.content.toLocaleLowerCase();
  const topic = (entry.topic ?? '').toLocaleLowerCase();
  const summary = memorySummary(entry).toLocaleLowerCase();
  const tags = (entry.tags ?? []).map((tag) => tag.toLocaleLowerCase());
  const ftsScore =
    options?.ftsRank !== undefined ? Math.min(12, Math.max(0.2, -options.ftsRank)) * 3 : 0;
  let keywordScore = 0;
  for (const term of terms.allTerms) {
    if (topic && topic.includes(term)) keywordScore += 6;
    if (tags.some((tag) => tag.includes(term) || term.includes(tag))) keywordScore += 5;
    if (summary.includes(term)) keywordScore += 4;
    if (content.includes(term)) keywordScore += 3;
  }
  let roleScore = 0;
  for (const rawRole of options?.roleTerms ?? []) {
    const role = rawRole.toLocaleLowerCase().trim();
    if (!role) continue;
    if (
      tags.some((tag) => tag.includes(role) || role.includes(tag)) ||
      (topic && topic.includes(role))
    ) {
      roleScore += 2;
    }
  }
  const relevanceScore = ftsScore + keywordScore + roleScore;
  const userMaintained = entry.createdBy === 'user' || entry.updatedBy === 'user';
  const authorityBonus = userMaintained ? 2.5 : 0;
  const scopeBonus = entry.scope === 'team' ? 0.6 : entry.scope === 'bot' ? 0.4 : 0.2;
  const activeReads = options?.usage?.activeReadCount ?? entry.usage?.activeReadCount ?? 0;
  const heatBonus = Math.min(1.5, Math.log2(1 + activeReads) * 0.4);
  const pinnedBonus = entry.pinned ? 4 : 0;
  return {
    entry,
    relevanceScore,
    totalScore: relevanceScore + authorityBonus + scopeBonus + heatBonus + pinnedBonus,
  };
}

export interface MemorySelectOptions {
  query?: string;
  roleTerms?: string[];
  budgetTokens?: number;
  bodyBudgetTokens?: number;
  directoryBudgetTokens?: number;
  maxRelevantEntries?: number;
  ftsRanks?: ReadonlyMap<string, number>;
  usageById?: ReadonlyMap<string, MemoryUsage>;
}

export function emptyMemorySelection(budgetTokens = 2000): MemorySelection {
  return {
    pinnedEntries: [],
    relevantEntries: [],
    fullEntries: [],
    omittedEntries: [],
    directory: { topics: [], totalRemaining: 0, hasMore: false },
    estimatedTokens: 0,
    budgetTokens,
  };
}

function formatFullEntryLine(entry: MemoryEntry): string {
  const badges = [
    entry.pinned ? '[置顶]' : '',
    entry.topic?.trim() ? `[${entry.topic.trim()}]` : '',
  ]
    .filter(Boolean)
    .join('');
  return `[${entry.id}@${entry.revision}]${badges ? ` ${badges}` : ''} ${entry.content}`;
}

function formatOmittedLine(entry: MemoryEntry): string {
  const badges = [
    entry.pinned ? '[置顶]' : '',
    entry.topic?.trim() ? `[${entry.topic.trim()}]` : '',
  ]
    .filter(Boolean)
    .join('');
  return `[${entry.id}@${entry.revision}]${badges ? ` ${badges}` : ''} 摘要：${memorySummary(entry)}（未注入全文，可用 recall_memory 按 ID 展开）`;
}

function formatTopicLine(item: MemoryTopicDirectoryItem): string {
  return `- ${item.topic}（${item.count} 条）：${item.summary} [ID: ${item.ids.join('、')}]`;
}

function buildTopicItems(entries: MemoryEntry[]): MemoryTopicDirectoryItem[] {
  const groups = new Map<string, MemoryEntry[]>();
  for (const entry of entries) {
    const topic = memoryTopic(entry);
    const list = groups.get(topic) ?? [];
    list.push(entry);
    groups.set(topic, list);
  }
  return [...groups.entries()].map(([topic, list]) => {
    const previews = list
      .slice(0, 2)
      .map((item) => memorySummary(item, 36))
      .join('；');
    return {
      topic,
      count: list.length,
      summary: previews,
      ids: list.slice(0, 4).map((item) => item.id),
    };
  });
}

export function selectMemoryContext(
  entries: MemoryEntry[],
  options: MemorySelectOptions = {},
): MemorySelection {
  const budgetTokens = Math.max(120, options.budgetTokens ?? 2000);
  if (!entries.length) return emptyMemorySelection(budgetTokens);
  const maxRelevant = Math.max(1, options.maxRelevantEntries ?? 6);
  const terms = extractQueryTerms(options.query ?? '');
  const score = (entry: MemoryEntry) =>
    scoreMemoryEntry(entry, terms, {
      ftsRank: options.ftsRanks?.get(entry.id),
      roleTerms: options.roleTerms,
      usage: options.usageById?.get(entry.id),
    });

  const pinnedCandidates = entries
    .filter((entry) => entry.pinned)
    .map(score)
    .sort(
      (a, b) => b.totalScore - a.totalScore || b.entry.updatedAt.localeCompare(a.entry.updatedAt),
    )
    .map((item) => item.entry);

  const scoredUnpinned = entries
    .filter((entry) => !entry.pinned)
    .map(score)
    .sort(
      (a, b) => b.totalScore - a.totalScore || b.entry.updatedAt.localeCompare(a.entry.updatedAt),
    );

  const matched = scoredUnpinned.filter((item) => item.relevanceScore > 0);
  const unmatched = scoredUnpinned.filter((item) => item.relevanceScore === 0);
  const relevantCandidates = (matched.length > 0 ? matched : unmatched)
    .slice(0, maxRelevant)
    .map((item) => item.entry);
  const directoryPool = (
    matched.length > 0
      ? [...matched.slice(maxRelevant), ...unmatched]
      : unmatched.slice(maxRelevant)
  ).map((item) => item.entry);

  const initialBodyBudget = options.bodyBudgetTokens ?? Math.floor(budgetTokens * 0.75);
  const initialDirBudget = options.directoryBudgetTokens ?? budgetTokens - initialBodyBudget;
  const headerTokens = estimateTokens('长期记忆（背景资料）：\n') + 16;

  const rawTopics = buildTopicItems(directoryPool);
  const dirHeaderTokens = rawTopics.length
    ? estimateTokens(
        '其他获准记忆主题目录（未注入全文，需要时用 recall_memory 按关键词、主题或 ID 展开）：\n',
      )
    : 0;
  const rawDirTokens = rawTopics.length
    ? dirHeaderTokens +
      rawTopics.reduce((sum, item) => sum + estimateTokens(formatTopicLine(item)) + 2, 0)
    : 0;
  const reservedDirTokens = Math.min(initialDirBudget, rawDirTokens);
  const effectiveBodyBudget = Math.max(40, budgetTokens - headerTokens - reservedDirTokens);

  const pinnedEntries: MemoryEntry[] = [];
  const relevantEntries: MemoryEntry[] = [];
  const fullEntries: MemoryEntry[] = [];
  const overflowCandidates: MemoryEntry[] = [];
  let usedTokens = headerTokens;

  for (const entry of pinnedCandidates) {
    const cost = estimateTokens(formatFullEntryLine(entry)) + 2;
    if (usedTokens + cost <= headerTokens + effectiveBodyBudget) {
      pinnedEntries.push(entry);
      fullEntries.push(entry);
      usedTokens += cost;
    } else {
      overflowCandidates.push(entry);
    }
  }

  for (const entry of relevantCandidates) {
    const cost = estimateTokens(formatFullEntryLine(entry)) + 2;
    if (usedTokens + cost <= headerTokens + effectiveBodyBudget) {
      relevantEntries.push(entry);
      fullEntries.push(entry);
      usedTokens += cost;
    } else {
      overflowCandidates.push(entry);
    }
  }

  const omittedEntries: MemoryEntry[] = [];
  const extraDirectoryEntries: MemoryEntry[] = [];
  const omittedHeaderTokens = overflowCandidates.length
    ? estimateTokens('未注入全文的记忆摘要（可用 recall_memory 按 ID 读取完整正文）：\n')
    : 0;
  let omittedHeaderCounted = false;

  for (const entry of overflowCandidates) {
    const cost =
      estimateTokens(formatOmittedLine(entry)) +
      2 +
      (omittedHeaderCounted ? 0 : omittedHeaderTokens);
    if (
      usedTokens + cost <= budgetTokens - reservedDirTokens ||
      (!directoryPool.length && usedTokens + cost <= budgetTokens)
    ) {
      if (!omittedHeaderCounted) {
        usedTokens += omittedHeaderTokens;
        omittedHeaderCounted = true;
      }
      omittedEntries.push(entry);
      usedTokens += estimateTokens(formatOmittedLine(entry)) + 2;
    } else {
      extraDirectoryEntries.push(entry);
    }
  }

  const finalDirectoryPool = [...extraDirectoryEntries, ...directoryPool];
  const allTopics = buildTopicItems(finalDirectoryPool);
  const selectedTopics: MemoryTopicDirectoryItem[] = [];
  if (allTopics.length) {
    const dirHeaderCost = estimateTokens(
      `其他获准记忆主题目录（共 ${finalDirectoryPool.length} 条未注入全文，可用 recall_memory 搜索或按 ID 展开）：\n`,
    );
    if (usedTokens + dirHeaderCost < budgetTokens) {
      usedTokens += dirHeaderCost;
      for (const topicItem of allTopics) {
        const cost = estimateTokens(formatTopicLine(topicItem)) + 2;
        if (usedTokens + cost <= budgetTokens && selectedTopics.length < 8) {
          selectedTopics.push(topicItem);
          usedTokens += cost;
        } else {
          break;
        }
      }
    }
  }

  const coveredCount = selectedTopics.reduce((sum, item) => sum + item.count, 0);
  const directory: MemoryDirectory = {
    topics: selectedTopics,
    totalRemaining: finalDirectoryPool.length,
    hasMore: coveredCount < finalDirectoryPool.length,
  };

  const selection: MemorySelection = {
    pinnedEntries,
    relevantEntries,
    fullEntries,
    omittedEntries,
    directory,
    estimatedTokens: 0,
    budgetTokens,
  };
  const rendered = formatMemorySelection(selection);
  selection.estimatedTokens = rendered ? estimateTokens(rendered) : 0;
  return selection;
}

export function formatMemorySelection(selection: MemorySelection): string {
  if (
    !selection.fullEntries.length &&
    !selection.omittedEntries.length &&
    !selection.directory.topics.length
  ) {
    return '';
  }
  const sections: string[] = ['长期记忆（背景资料）：'];
  if (selection.fullEntries.length) {
    sections.push(selection.fullEntries.map(formatFullEntryLine).join('\n'));
  }
  if (selection.omittedEntries.length) {
    sections.push(
      [
        '未注入全文的记忆摘要（可用 recall_memory 按 ID 读取完整正文）：',
        ...selection.omittedEntries.map(formatOmittedLine),
      ].join('\n'),
    );
  }
  if (selection.directory.topics.length) {
    sections.push(
      [
        `其他获准记忆主题目录（共 ${selection.directory.totalRemaining} 条未注入全文，可用 recall_memory 搜索或按 ID 展开${selection.directory.hasMore ? '，更多条目可分页检索' : ''}）：`,
        ...selection.directory.topics.map(formatTopicLine),
      ].join('\n'),
    );
  } else if (selection.directory.totalRemaining > 0) {
    sections.push(
      `另有 ${selection.directory.totalRemaining} 条获准记忆因预算限制未展示，可用 recall_memory 检索。`,
    );
  }
  return sections.join('\n');
}
