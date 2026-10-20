import type { Artifact } from './types.js';

export function isDeliverableArtifact(artifact: Artifact): boolean {
  if (artifact.source === 'user-attachment') return false;
  if (artifact.purpose) return artifact.purpose === 'deliverable';
  if (
    ['mcp-image', 'context-compaction', 'context-reference-index'].includes(artifact.source ?? '')
  )
    return false;
  if (artifact.source === 'render_document') return false;
  if (artifact.source && artifact.name === `${artifact.source}完整结果.json`) return false;
  return true;
}
