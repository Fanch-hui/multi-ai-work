import { join } from 'node:path';
import { rm } from 'node:fs/promises';
import type { Artifact, Conversation } from '../domain/types.js';
import { required } from './errors.js';
import { id, now, type State } from './state.js';

export async function prepareRoutineInputs(state: State, artifactIds: string[]) {
  const prepared: { original: Artifact; bytes: Buffer; newId: string }[] = [];
  for (const artifactId of new Set(artifactIds)) {
    const original = required(
      state.storage.get<Artifact>('artifacts', artifactId),
      '输入资料不存在',
    );
    prepared.push({ original, bytes: await state.artifactContents.read(original), newId: id() });
  }
  return {
    save(conversationId: string) {
      return prepared.map(({ original, bytes, newId }) => {
        const current = required(
          state.storage.get<Artifact>('artifacts', original.id),
          '输入资料已删除，请重新选择',
        );
        if (current.sha256 !== original.sha256) throw new Error('输入资料已变化，请重新选择');
        if (current.conversationId === conversationId) return current.id;
        const shared = state.artifactObjects.publish(newId, original.name, bytes);
        state.storage.put('artifacts', {
          ...original,
          ...shared,
          id: newId,
          conversationId,
          chiefContextId: state.storage.get<Conversation>('conversations', conversationId)
            ?.chiefContextId,
          contentSource: undefined,
          image: undefined,
          seriesId: undefined,
          previousArtifactId: undefined,
          workingPath: undefined,
          source: 'routine-input',
          purpose: 'intermediate',
          createdAt: now(),
        } satisfies Artifact);
        return newId;
      });
    },
    async discard() {
      for (const { newId } of prepared) {
        if (state.storage.get('artifacts', newId)) continue;
        await rm(join(state.dataDirectory, 'artifacts', newId), { recursive: true, force: true });
      }
    },
  };
}
