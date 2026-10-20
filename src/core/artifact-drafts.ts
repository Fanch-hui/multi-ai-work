import type { Artifact } from '../domain/types.js';
import type { State } from './state.js';

const day = 24 * 60 * 60 * 1000;
const prefix = 'artifact-draft:';
interface DraftLease {
  conversationId: string;
  touchedAt: number;
}
export interface AttachmentDraft {
  conversationId: string;
  artifactIds: string[];
}

export function trackAttachmentDraft(state: State, artifact: Artifact) {
  state.storage.setMetadata(`${prefix}${artifact.id}`, {
    conversationId: artifact.conversationId,
    touchedAt: Date.now(),
  } satisfies DraftLease);
}

export class ArtifactDrafts {
  constructor(private state: State) {}

  retain(drafts: AttachmentDraft[]) {
    for (const draft of drafts) {
      for (const id of new Set(draft.artifactIds)) {
        const artifact = this.state.storage.get<Artifact>('artifacts', id);
        if (
          artifact?.source !== 'user-attachment' ||
          artifact.conversationId !== draft.conversationId ||
          !this.state.storage.metadata(`${prefix}${id}`)
        )
          continue;
        trackAttachmentDraft(this.state, artifact);
      }
    }
    return { retained: true };
  }

  expired(): Artifact[] {
    const rows = this.state.storage.db
      .prepare('SELECT key,value FROM metadata WHERE key LIKE ?')
      .all(`${prefix}%`) as { key: string; value: string }[];
    const expired: Artifact[] = [];
    for (const row of rows) {
      const id = row.key.slice(prefix.length);
      const artifact = this.state.storage.get<Artifact>('artifacts', id);
      if (!artifact || this.referenced(id)) {
        this.forget(id);
        continue;
      }
      const lease = JSON.parse(row.value) as DraftLease;
      if (lease.touchedAt < Date.now() - day) expired.push(artifact);
    }
    return expired;
  }

  forget(id: string) {
    this.state.storage.db.prepare('DELETE FROM metadata WHERE key = ?').run(`${prefix}${id}`);
  }

  isExpired(id: string): boolean {
    const lease = this.state.storage.metadata<DraftLease>(`${prefix}${id}`);
    const artifact = this.state.storage.get<Artifact>('artifacts', id);
    return (
      !!lease &&
      artifact?.source === 'user-attachment' &&
      lease.touchedAt < Date.now() - day &&
      !this.referenced(id)
    );
  }

  private referenced(id: string): boolean {
    const value = JSON.stringify(id);
    for (const table of ['messages', 'tasks', 'context_checkpoints', 'provider_archive']) {
      const exists = this.state.storage.db
        .prepare(`SELECT 1 FROM ${table} WHERE instr(payload, ?) > 0 LIMIT 1`)
        .get(value);
      if (exists) return true;
    }
    return false;
  }
}
