import { isDeliverableArtifact } from '../domain/artifact-purpose.js';
import { latestArtifactVersions } from '../domain/artifact-versions.js';
import type {
  Artifact,
  ContextCheckpoint,
  Message,
  Run,
  SessionBinding,
  Task,
} from '../domain/types.js';
import { contextSourceHash } from '../runtime/context.js';
import type { Storage } from './storage.js';

/** Automatic delivery adds current files that this task has not already published. */
export function replyArtifactIds(
  storage: Storage,
  draft: Message,
  artifactIds: string[],
): string[] {
  const run = draft.runId ? storage.get<Run>('runs', draft.runId) : undefined;
  const sources = new Set(
    run
      ? storage.byField<Run>('runs', 'taskId', run.taskId).map((source) => source.id)
      : [draft.runId],
  );
  const published = new Set(
    storage
      .messages(draft.conversationId)
      .filter(
        (message) =>
          message.id !== draft.id &&
          message.sequence < draft.sequence &&
          sources.has(message.runId) &&
          message.authorBotId === draft.authorBotId &&
          message.status === 'committed',
      )
      .flatMap((message) => message.artifactIds),
  );
  const artifacts = artifactIds
    .map((id) => storage.get<Artifact>('artifacts', id))
    .filter((artifact): artifact is Artifact => !!artifact && isDeliverableArtifact(artifact));
  const tasks = new Map<string, Task>();
  for (const artifact of artifacts) {
    if (!artifact.taskId || artifact.botId || tasks.has(artifact.taskId)) continue;
    const task = storage.get<Task>('tasks', artifact.taskId);
    if (task) tasks.set(task.id, task);
  }
  return latestArtifactVersions(artifacts, tasks)
    .filter((artifact) => !published.has(artifact.id))
    .map((artifact) => artifact.id);
}

/** Repairs final automatic attachments while preserving explicit post_message deliveries. */
export function migrateReplyArtifacts(storage: Storage) {
  const migration = 'reply-artifact-delivery-v1';
  const contextMigration = 'reply-artifact-context-v2';
  if (storage.metadata(contextMigration)) return;
  storage.transaction(() => {
    const migrated = !!storage.metadata(migration);
    const previous = new Map<string, Message>();
    const posted = new Set(
      (
        storage
          .prepare(`SELECT json_extract(payload, '$.result.messageId') AS id
          FROM tool_operations WHERE json_extract(payload, '$.name') = 'post_message'
          AND json_type(payload, '$.result.messageId') = 'text'`)
          .all() as { id: string }[]
      ).map((row) => row.id),
    );
    const rows = storage
      .prepare(`SELECT m.payload, json_extract(t.payload, '$.artifactIds') AS artifactIds FROM messages m
      JOIN runs r ON r.id = json_extract(m.payload, '$.runId')
      JOIN tasks t ON t.id = json_extract(r.payload, '$.taskId')
      WHERE json_extract(r.payload, '$.status') = 'completed'
      AND json_extract(m.payload, '$.authorBotId') = json_extract(r.payload, '$.botId')
      AND m.conversation_id = json_extract(t.payload, '$.conversationId')
      AND json_extract(m.payload, '$.status') = 'committed'
      AND NOT EXISTS (SELECT 1 FROM messages later
        WHERE later.conversation_id = m.conversation_id AND later.sequence > m.sequence
        AND json_extract(later.payload, '$.runId') = json_extract(m.payload, '$.runId')
        AND json_extract(later.payload, '$.authorBotId') = json_extract(m.payload, '$.authorBotId')
        AND json_extract(later.payload, '$.status') = 'committed')
      ORDER BY m.conversation_id, m.sequence`)
      .all() as { payload: string; artifactIds: string }[];
    for (const row of rows) {
      const message = JSON.parse(row.payload) as Message;
      if (posted.has(message.id)) continue;
      const artifactIds = replyArtifactIds(storage, message, message.artifactIds);
      // The original automatic reply attached the task's entire artifact list.
      const originalIds: string[] = migrated ? JSON.parse(row.artifactIds) : message.artifactIds;
      if (JSON.stringify(originalIds) !== JSON.stringify(artifactIds))
        previous.set(message.id, { ...message, artifactIds: originalIds });
      if (JSON.stringify(artifactIds) !== JSON.stringify(message.artifactIds))
        storage.updateMessage({ ...message, artifactIds });
    }
    preserveContextSources(storage, previous);
    storage.setMetadata(migration, true);
    storage.setMetadata(contextMigration, true);
  });
}

/** Attachment display changes retain context only when the complete original source hash matches. */
function preserveContextSources(storage: Storage, previous: Map<string, Message>) {
  const conversations = new Set([...previous.values()].map((message) => message.conversationId));
  for (const conversationId of conversations) {
    const messages = storage.messages(conversationId);
    const rehash = (ids: string[], sourceHash?: string) => {
      const selected = new Set(ids);
      const sources = messages.filter((message) => selected.has(message.id));
      if (sources.length !== ids.length) return;
      const original = sources.map((message) => previous.get(message.id) ?? message);
      if (contextSourceHash(original) !== sourceHash) return;
      return contextSourceHash(sources);
    };
    for (const binding of storage.byField<SessionBinding>(
      'session_bindings',
      'conversationId',
      conversationId,
    )) {
      let checkpointRebased = false;
      for (const checkpoint of storage.byField<ContextCheckpoint & { sourceHash?: string }>(
        'context_checkpoints',
        'bindingId',
        binding.id,
      )) {
        const sourceHash = rehash(checkpoint.sourceMessageIds, checkpoint.sourceHash);
        if (!sourceHash || sourceHash === checkpoint.sourceHash) continue;
        storage.put('context_checkpoints', { ...checkpoint, sourceHash });
        checkpointRebased = true;
      }
      const key = `history-validity:${binding.id}`;
      const validity = storage.metadata<{ sourceIds: string[]; sourceHash: string }>(key);
      const sourceHash = validity && rehash(validity.sourceIds, validity.sourceHash);
      if (validity && sourceHash) storage.setMetadata(key, { ...validity, sourceHash });
      else if (checkpointRebased) {
        // A request may already have rebuilt the full projection after the attachment migration.
        // Re-select the verified checkpoint on the next request instead of retaining that expansion.
        storage.prepare('DELETE FROM metadata WHERE key = ?').run(key);
      }
    }
  }
}
