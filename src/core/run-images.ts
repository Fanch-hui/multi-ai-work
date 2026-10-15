import { stat } from 'node:fs/promises';
import type { Artifact, ImageMetadata } from '../domain/types.js';
import type { ModelImage } from '../domain/provider.js';
import type { ToolExecutionContext } from '../domain/tools.js';
import { imageMimeTypes, normalizeArtifactImage, resolveArtifactImage } from '../tools/images.js';
import type { State } from './state.js';

export function modelImage(artifact?: Artifact): ModelImage | undefined {
  if (!artifact || !imageMimeTypes.has(artifact.mimeType)) return undefined;
  return { artifactId: artifact.id, mimeType: artifact.image?.mimeType ?? artifact.mimeType,
    width: artifact.image?.width, height: artifact.image?.height };
}

export function imageResolver(state: State, context: ToolExecutionContext) {
  type EncodedImage = Awaited<ReturnType<typeof resolveArtifactImage>>;
  const cache = new Map<string, EncodedImage>();
  const pending = new Map<string, Promise<EncodedImage>>();
  const normalizing = new Map<string, Promise<ImageMetadata>>();
  const capacity = 32 * 1024 * 1024;
  let cachedBytes = 0;

  function authorized(id: string) {
    context.signal.throwIfAborted();
    const artifact = context.findArtifact(id);
    if (!artifact) throw new Error('图片不存在或不在当前任务授权范围');
    return artifact;
  }

  async function prepare(artifact: Artifact) {
    if (artifact.image) return artifact;
    const key = imageVersion(artifact);
    let work = normalizing.get(key);
    if (!work) {
      work = normalizeArtifactImage({ ...artifact });
      normalizing.set(key, work);
    }
    let image: ImageMetadata;
    try { image = await work; }
    finally { if (normalizing.get(key) === work) normalizing.delete(key); }
    const current = authorized(artifact.id);
    if (imageVersion({ ...current, image: undefined }) !== key
      || (current.image && JSON.stringify(current.image) !== JSON.stringify(image))) {
      throw new Error('图片已变化，请重新读取');
    }
    if (!current.image) {
      current.image = image;
      state.storage.put('artifacts', current);
    }
    return current;
  }

  function remember(key: string, image: EncodedImage) {
    const bytes = image.data.length;
    if (bytes > capacity || cache.has(key)) return;
    while (cachedBytes + bytes > capacity) {
      const oldest = cache.keys().next().value!;
      cachedBytes -= cache.get(oldest)!.data.length;
      cache.delete(oldest);
    }
    cache.set(key, image);
    cachedBytes += bytes;
  }

  return async (image: ModelImage) => {
    const artifact = await prepare(authorized(image.artifactId));
    const version = imageVersion(artifact);
    const metadata = await stat(artifact.image!.path);
    const key = JSON.stringify([version, metadata.dev, metadata.ino, metadata.size, metadata.mtimeMs, metadata.ctimeMs]);
    let result = cache.get(key);
    if (!result) {
      let work = pending.get(key);
      if (!work) {
        work = resolveArtifactImage(artifact);
        pending.set(key, work);
      }
      try { result = await work; }
      finally { if (pending.get(key) === work) pending.delete(key); }
    }
    if (imageVersion(authorized(image.artifactId)) !== version) throw new Error('图片已变化，请重新读取');
    remember(key, result);
    return { ...result };
  };
}

function imageVersion(artifact: Artifact) {
  return JSON.stringify([artifact.id, artifact.path, artifact.mimeType, artifact.sha256, artifact.image]);
}
