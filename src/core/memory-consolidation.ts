import { createHash } from 'node:crypto';
import type {
  Bot, Connection, Conversation, MemoryConsolidationStatus, MemoryEntry, Task,
} from '../domain/types.js';
import { memoryPartitionKey, normalizedAllowedConversations } from '../domain/memory.js';
import { State } from './state.js';
import { TaskService, terminal } from './tasks.js';
import { memoryGuidance } from './memory-policy.js';
import type { MemoryBatchMeta } from './memory-merge.js';

export const CONSOLIDATION_POLICY_VERSION = 'v2';

export function computePartitionFingerprint(
  partitionKey: string,
  entries: MemoryEntry[],
  ownerRevision: number,
  connectionRevision: number,
  mode: 'auto' | 'manual' = 'auto',
): string {
  const sig = entries
    .map(entry => `${entry.id}@${entry.revision}:${entry.status}`)
    .sort()
    .join(',');
  return createHash('sha256')
    .update(`${CONSOLIDATION_POLICY_VERSION}|${mode}|${partitionKey}|${sig}|${ownerRevision}|${connectionRevision}`)
    .digest('hex');
}

export function schedulePartitionConsolidations(
  state: State,
  tasks: TaskService,
  options?: { manual?: boolean; targetScope?: MemoryEntry['scope']; targetOwnerId?: string },
): MemoryConsolidationStatus[] {
  const s = state.storage, settings = state.settings();
  const allTasks = s.all<Task>('tasks');
  const activeEntries = s.all<MemoryEntry>('memory_entries')
    .filter(item => item.status === 'candidate' || item.status === 'approved');

  const partitions = new Map<string, MemoryEntry[]>();
  for (const entry of activeEntries) {
    if (options?.targetScope && (entry.scope === 'bot') !== (options.targetScope === 'bot')) continue;
    if (options?.targetScope === 'bot' && options.targetOwnerId && entry.ownerId !== options.targetOwnerId) continue;
    const key = memoryPartitionKey(entry);
    const list = partitions.get(key) ?? [];
    list.push(entry);
    partitions.set(key, list);
  }

  const statuses: MemoryConsolidationStatus[] = [];

  for (const [partitionKey, entries] of partitions.entries()) {
    const first = entries[0];
    const candidates = entries.filter(item => item.status === 'candidate');
    const approved = entries.filter(item => item.status === 'approved');
    const shouldAutoRun = candidates.length > 0 || approved.length > 30;
    if (!options?.manual && !shouldAutoRun) continue;

    const owner = s.get<Bot>('bots', first.scope === 'bot' ? first.ownerId : settings.mainBotId!);
    const connection = owner && s.get<Connection>('connections', owner.connectionId);
    const allowedRooms = normalizedAllowedConversations(first);
    const room = s.all<Conversation>('conversations').find(item =>
      tasks.accepting(item.id)
      && item.memberIds.includes(owner?.id ?? '')
      && (first.scope !== 'bot' ? item.purpose === 'chief' : allowedRooms.includes(item.id)),
    );

    if (!owner?.model || owner.archived || owner.memoryMode === 'off' || !room || connection?.status !== 'ready') {
      continue;
    }

    const scopeTag = first.scope === 'bot' ? `bot:${first.ownerId}` : 'public';
    const partitionHash = createHash('sha256').update(partitionKey).digest('hex').slice(0, 16);
    const runningTask = allTasks.find(task =>
      task.kind === 'memory-review'
      && !terminal(task.status)
      && (
        task.requestId.startsWith(`memory:${scopeTag}:${partitionHash}:`)
        || task.requestId.startsWith(`memory:${partitionHash}:`)
        || s.metadata<MemoryBatchMeta>(`memory-batch:${task.id}`)?.partitionKey === partitionKey
      ),
    );
    if (runningTask) {
      statuses.push({ partitionKey, status: 'running', taskId: runningTask.id });
      continue;
    }

    const roomBusy = !options?.manual && allTasks.some(task =>
      task.conversationId === room.id && !task.kind && !terminal(task.status),
    );
    if (roomBusy) continue;

    const fingerprint = computePartitionFingerprint(
      partitionKey,
      entries,
      owner.revision,
      connection.revision,
      options?.manual ? 'manual' : 'auto',
    );
    const singleCandidatePrefix = candidates.length === 1 && !options?.manual && approved.length <= 30
      ? `memory:${scopeTag}:${candidates[0].id}:${candidates[0].revision}:${owner.revision}:${connection.revision}`
      : `memory:${scopeTag}:${partitionHash}:${fingerprint}`;

    const existingSame = allTasks.find(task =>
      task.requestId === singleCandidatePrefix
      || task.requestId === `memory:${scopeTag}:${partitionHash}:${fingerprint}`
      || task.requestId === `memory:${partitionHash}:${fingerprint}`,
    );
    if (existingSame) {
      if (existingSame.status === 'completed' || !terminal(existingSame.status)) {
        statuses.push({
          partitionKey,
          status: existingSame.status === 'completed' ? 'completed' : 'running',
          taskId: existingSame.id,
          lastCompletedAt: existingSame.updatedAt,
          lastResult: existingSame.result,
        });
        continue;
      }
      if (!options?.manual) continue;
    }

    const focusIds = (candidates.length ? candidates : approved).map(item => item.id);
    const goal = candidates.length
      ? `整理长期记忆 ${focusIds.join('、')}。用 manage_memory 读取本分区候选与已有记忆，${memoryGuidance}对长期有效的候选保存或 approve（补充简洁 topic 和一句话 summary）；存在语义相同或明确新纠正的同类条目可用 merge 原子合并；单次任务事实、无价值或重复内容则 revoke。保留原授权范围，不复制其他私聊内容。`
      : `整理长期记忆 ${focusIds.slice(0, 10).join('、')}。用 manage_memory 检查本分区已批准记忆（共 ${approved.length} 条），合并语义重复或已被新要求纠正的同事项条目，为缺少主题或摘要的条目补充简洁 topic 和 summary，允许无修改结束。长期未召回不等于失效，用户手动维护或置顶条目不可直接覆盖或停用。`;

    const requestId = existingSame ? `${singleCandidatePrefix}:retry:${Date.now()}` : singleCandidatePrefix;
    const task = tasks.create({
      conversationId: room.id,
      botId: owner.id,
      requestId,
      goal,
      expectedOutput: '完成实际记忆管理操作；最后只简短说明处理结果。',
    });
    s.put('tasks', { ...task, kind: 'memory-review' });
    const batchMeta: MemoryBatchMeta = {
      taskId: task.id,
      partitionKey,
      fingerprint,
      scope: first.scope,
      ownerId: first.ownerId,
      allowedConversationIds: allowedRooms,
      initialRevisions: Object.fromEntries(entries.map(entry => [entry.id, entry.revision])),
      touchedRevisions: {},
    };
    s.setMetadata(`memory-batch:${task.id}`, batchMeta);
    statuses.push({ partitionKey, status: 'running', taskId: task.id });
  }

  return statuses;
}
