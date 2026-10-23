import { createHash } from 'node:crypto';
import { readFileSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Artifact, Bot, Conversation, Task } from '../domain/types.js';
import { isDeliverableArtifact } from '../domain/artifact-purpose.js';
import { artifactContentLookup, sourceContent } from './artifact-content-source.js';
import { id, now, type State } from './state.js';
import { required } from './errors.js';
import { previousArtifactSeries } from './artifact-review-series.js';
import { reviewTargets } from './artifact-review-targets.js';

export function retainedReviewArtifacts(state: State, artifactIds: string[]): Artifact[] {
  return artifactIds.map((artifactId) => {
    const artifact = required(state.storage.get<Artifact>('artifacts', artifactId), '成果已删除');
    if (state.storage.get('conversations', artifact.conversationId))
      throw new Error('仅来源对话已删除的成果可以转入其他会话');
    if (!isDeliverableArtifact(artifact)) throw new Error('请选择正式交付成果');
    return artifact;
  });
}

export function transferReviewBot(
  state: State,
  room: Conversation,
  artifacts: Artifact[],
  source?: Task,
): string {
  const chiefId = state.settings().mainBotId;
  const botId = room.chiefId === chiefId ? chiefId : (artifacts[0].botId ?? source?.botId);
  if (
    !botId ||
    (room.chiefId !== chiefId &&
      (room.kind !== 'private' ||
        !artifacts.every((item) => (item.botId ?? source?.botId) === botId)))
  )
    throw new Error('请选择管家对话或原产出成员的私聊');
  const bot = required(state.storage.get<Bot>('bots', botId), '接收成员不存在');
  if (bot.archived || !room.memberIds.includes(botId))
    throw new Error('接收成员不是当前会话的有效成员');
  return botId;
}

export function transferReviewInputs(state: State, room: Conversation, artifacts: Artifact[]) {
  const inputs: Artifact[] = [];
  const created: Artifact[] = [];
  try {
    for (const artifact of artifacts) {
      const key = `review-transfer-input:${room.id}:${artifact.id}`;
      const existingId = state.storage.metadata<string>(key);
      const existing = existingId && state.storage.get<Artifact>('artifacts', existingId);
      if (existing && existing.conversationId === room.id && existing.sha256 === artifact.sha256) {
        inputs.push(existing);
        continue;
      }
      const inputId = id();
      const content = artifact.contentSource
        ? sourceContent(artifact.contentSource, artifactContentLookup(state.storage))
        : undefined;
      const bytes = content === undefined ? readFileSync(artifact.path) : Buffer.from(content);
      if (
        bytes.length !== artifact.size ||
        createHash('sha256').update(bytes).digest('hex') !== artifact.sha256
      )
        throw new Error('成果内容已变化，请重新选择');
      const { seriesId, related } = previousArtifactSeries(state, artifact);
      const copy: Artifact = {
        ...artifact,
        ...state.artifactObjects.publish(inputId, artifact.name, bytes),
        id: inputId,
        conversationId: room.id,
        contentSource: undefined,
        seriesId,
        source: 'review-transfer',
        createdAt: now(),
      };
      inputs.push(copy);
      created.push(copy);
      for (const version of related) state.storage.put('artifacts', { ...version, seriesId });
      state.storage.put('artifacts', copy);
      state.storage.setMetadata(key, copy.id);
      state.storage.setMetadata(
        `review-transfer-target:${copy.id}`,
        reviewTargets(state, [artifact])[0],
      );
    }
    return { inputs, created };
  } catch (error) {
    removeTransferredFiles(state, created);
    throw error;
  }
}

export function removeTransferredFiles(state: State, inputs: Artifact[]) {
  for (const input of inputs) {
    if (state.artifactObjects.owns(input))
      rmSync(dirname(input.path), { recursive: true, force: true });
    if (input.objectHash) state.artifactObjects.removeUnused(input.objectHash);
  }
}
