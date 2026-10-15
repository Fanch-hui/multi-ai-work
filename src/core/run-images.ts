import type { Artifact } from '../domain/types.js';
import type { ModelImage } from '../domain/provider.js';
import type { ToolExecutionContext } from '../domain/tools.js';
import { imageMimeTypes, resolveArtifactImage } from '../tools/images.js';
import type { State } from './state.js';

export function modelImage(artifact?: Artifact): ModelImage | undefined {
  if (!artifact || !imageMimeTypes.has(artifact.mimeType)) return undefined;
  return { artifactId: artifact.id, mimeType: artifact.image?.mimeType ?? artifact.mimeType,
    width: artifact.image?.width, height: artifact.image?.height };
}

export function imageResolver(state: State, context: ToolExecutionContext) {
  return async (image: ModelImage) => {
    context.signal.throwIfAborted();
    const artifact = context.findArtifact(image.artifactId);
    if (!artifact) throw new Error('图片不存在或不在当前任务授权范围');
    const result = await resolveArtifactImage(artifact);
    state.storage.put('artifacts', artifact);
    return result;
  };
}
