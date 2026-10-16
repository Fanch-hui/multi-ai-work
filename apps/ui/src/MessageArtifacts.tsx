import type { Artifact, Conversation, Snapshot } from '../../../src/domain/types.js';
import { isDeliverableArtifact } from '../../../src/domain/artifact-purpose.js';
import type { Mutate } from './store.js';
import { ArtifactItem } from './Artifacts.js';
import { artifactProducer } from './artifact-groups.js';
import { ImageAttachment, isImageAttachment } from './ImageAttachment.js';

export function MessageArtifacts({ ids, user, conversation, data, mutate }: {
  ids: string[]; user: boolean; conversation: Conversation;
  data: Pick<Snapshot, 'artifacts' | 'tasks' | 'bots'>; mutate: Mutate;
}) {
  const artifacts = new Map(data.artifacts.map(artifact => [artifact.id, artifact]));
  const files = ids.map(id => artifacts.get(id)).filter((artifact): artifact is Artifact =>
    !!artifact && (user || artifact.source === 'user-attachment' || isDeliverableArtifact(artifact)));
  if (!files.length) return null;
  if (!user && conversation.kind === 'group') {
    const tasks = new Map(data.tasks.map(task => [task.id, task]));
    const bots = new Map(data.bots.map(bot => [bot.id, bot]));
    return <details className="mt-3 min-w-0 text-xs text-slate-600">
      <summary className="w-fit cursor-pointer rounded-md px-2 py-1.5 tabular-nums hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-blue-500">
        {files.length} 个文件
      </summary>
      <ul className="@container mt-2 list-none divide-y divide-slate-100 overflow-hidden rounded-xl border border-slate-200 bg-white">
        {files.map(artifact => <li key={artifact.id}><ArtifactItem artifact={artifact}
          producer={artifactProducer(artifact, tasks, bots)} showProducer layout="row" mutate={mutate} /></li>)}
      </ul>
    </details>;
  }
  return <div className="mt-3 flex flex-wrap gap-2">
    {files.map(artifact => isImageAttachment(artifact)
      ? <ImageAttachment artifact={artifact} key={artifact.id} conversationId={conversation.id} />
      : <div className="w-full" key={artifact.id}><ArtifactItem artifact={artifact} mutate={mutate} dense /></div>)}
  </div>;
}
