import { stat } from 'node:fs/promises';
import type { Artifact, ImageMetadata } from '../domain/types.js';
import type { ModelImage } from '../domain/provider.js';
import type { ToolExecutionContext } from '../domain/tools.js';
import { imageMimeTypes, normalizeArtifactImage } from '../tools/images.js';
import { MODEL_IMAGE_ENCODING_VERSION, resolveModelArtifactImage } from '../tools/model-images.js';
import type { State } from './state.js';

export function modelImage(artifact?: Artifact): ModelImage | undefined {
  if (!artifact || !imageMimeTypes.has(artifact.mimeType)) return undefined;
  return { artifactId: artifact.id, mimeType: artifact.image?.mimeType ?? artifact.mimeType,
    width: artifact.image?.width, height: artifact.image?.height };
}

type EncodedImage = Awaited<ReturnType<typeof resolveModelArtifactImage>>;
interface ImageLruCache {
  entries: Map<string, { value: EncodedImage; bytes: number }>;
  bytes: number;
}
const MAX_IMAGE_CACHE_BYTES = 32 * 1024 * 1024;
const sharedImageCache: ImageLruCache = { entries: new Map(), bytes: 0 };

export function clearRunImageCache(): void {
  sharedImageCache.entries.clear();
  sharedImageCache.bytes = 0;
}

function readLru(store: ImageLruCache, key: string): EncodedImage | undefined {
  const entry = store.entries.get(key);
  if (!entry) return undefined;
  store.entries.delete(key);
  store.entries.set(key, entry);
  return entry.value;
}

function writeLru(store: ImageLruCache, key: string, value: EncodedImage): void {
  const bytes = value.data.length;
  if (bytes > MAX_IMAGE_CACHE_BYTES) return;
  const existing = store.entries.get(key);
  if (existing) {
    store.bytes -= existing.bytes;
    store.entries.delete(key);
  }
  while (store.bytes + bytes > MAX_IMAGE_CACHE_BYTES && store.entries.size > 0) {
    const oldest = store.entries.keys().next().value!;
    store.bytes -= store.entries.get(oldest)!.bytes;
    store.entries.delete(oldest);
  }
  store.entries.set(key, { value, bytes });
  store.bytes += bytes;
}

export function imageResolver(state: State, context: ToolExecutionContext) {
  const store: ImageLruCache = context.runId ? sharedImageCache : { entries: new Map(), bytes: 0 };
  const pending = new Map<string, Promise<EncodedImage>>();
  const normalizing = new Map<string, Promise<ImageMetadata>>();

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

  return async (image: ModelImage) => {
    const artifact = await prepare(authorized(image.artifactId));
    const version = imageVersion(artifact);
    const metadata = await stat(artifact.path);
    const identity = artifact.sha256
      ? `sha256:${artifact.sha256}`
      : `path:${artifact.path}:${metadata.mtimeMs}:${metadata.size}`;
    const key = JSON.stringify([MODEL_IMAGE_ENCODING_VERSION, identity, version, metadata.dev, metadata.ino,
      metadata.size, metadata.mtimeMs, metadata.ctimeMs]);
    let result = readLru(store, key);
    if (!result) {
      let work = pending.get(key);
      if (!work) {
        work = resolveModelArtifactImage(artifact);
        pending.set(key, work);
      }
      try { result = await work; }
      finally { if (pending.get(key) === work) pending.delete(key); }
    }
    if (imageVersion(authorized(image.artifactId)) !== version) throw new Error('图片已变化，请重新读取');
    writeLru(store, key, result);
    return { ...result };
  };
}

function imageVersion(artifact: Artifact) {
  return JSON.stringify([artifact.id, artifact.path, artifact.mimeType, artifact.sha256, artifact.image]);
}
