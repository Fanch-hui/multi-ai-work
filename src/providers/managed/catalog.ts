import type { ModelInfo } from '../../domain/types.js';
import { providerFetch } from '../network.js';

type CatalogRecord = Record<string, unknown>;
const officialCatalogUrl = 'https://raw.githubusercontent.com/openai/codex/main/codex-rs/models-manager/models.json';
export const OFFICIAL_CATALOG_TTL_MS = 30 * 60 * 1000;
export const OFFICIAL_CATALOG_FAILURE_BACKOFF_MS = 30 * 1000;
let cachedModels: ModelInfo[] | undefined;
let expiresAt = 0;
let retryAfter = 0;
let officialCatalog: Promise<ModelInfo[]> | undefined;

export function resetOfficialCatalogCache(): void {
  cachedModels = undefined;
  expiresAt = 0;
  retryAfter = 0;
  officialCatalog = undefined;
}

function record(value: unknown): CatalogRecord | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as CatalogRecord : undefined;
}

function reasoningOptions(model: CatalogRecord): string[] | undefined {
  const options = [model.supported_reasoning_levels, model.supported_reasoning_efforts,
    model.supportedReasoningEfforts, model.reasoning_efforts];
  if (!options.some(Array.isArray)) return undefined;
  const values = options.flatMap(options => Array.isArray(options) ? options : []).map(option => {
    const item = record(option);
    return typeof option === 'string' ? option : item?.effort ?? item?.reasoningEffort ?? item?.reasoning_effort;
  }).filter((value): value is string => typeof value === 'string' && value.length > 0 && value === value.trim());
  return [...new Set(values)];
}

function imageCapability(model: CatalogRecord): ModelInfo['imageInput'] {
  const modalities = model.input_modalities ?? model.inputModalities ?? record(model.modalities)?.input;
  if (Array.isArray(modalities) && modalities.every(value => typeof value === 'string')) {
    return modalities.includes('image') ? 'supported' : 'unsupported';
  }
  const supported = model.supports_images ?? model.supportsImages;
  return typeof supported === 'boolean' ? supported ? 'supported' : 'unsupported' : undefined;
}

function modelInfo(model: CatalogRecord, id: string): ModelInfo {
  const name = model.display_name ?? model.displayName;
  const window = model.context_window ?? model.contextWindow;
  const maximum = model.max_context_window ?? model.maxContextWindow;
  const reasoning = reasoningOptions(model);
  const imageInput = imageCapability(model);
  return { id, name: typeof name === 'string' && name ? name : id,
    ...(typeof window === 'number' && Number.isFinite(window) && window > 0 ? { contextWindow: window } : {}),
    ...(typeof maximum === 'number' && Number.isFinite(maximum) && maximum > 0
      ? { maxContextWindow: maximum, maxContextWindowSource: 'provider' as const } : {}),
    ...(reasoning ? { reasoning, reasoningSource: 'provider' as const } : {}),
    ...(imageInput ? { imageInput, imageInputSource: 'provider' as const } : {}) };
}

export function decodeModelCatalog(raw: unknown, oauth: boolean): ModelInfo[] | undefined {
  const body = record(raw);
  const models = oauth ? body?.models : body?.data;
  if (!Array.isArray(models)) return undefined;
  return models.flatMap(value => {
    const model = record(value);
    const id = oauth ? model?.slug : model?.id;
    if (!model || typeof id !== 'string' || !id || (oauth && model.visibility !== 'list')) return [];
    return [modelInfo(model, id)];
  });
}

export async function loadOfficialModelCatalog(fetcher: typeof fetch = providerFetch): Promise<ModelInfo[]> {
  const response = await fetcher(officialCatalogUrl, {
    redirect: 'error', credentials: 'omit', signal: AbortSignal.timeout(3_000),
  });
  if (!response.ok) throw new Error('官方模型目录暂不可用');
  const raw = record(await response.json());
  if (!Array.isArray(raw?.models)) return [];
  return raw.models.flatMap(value => {
    const model = record(value);
    if (!model || typeof model.slug !== 'string' || !model.slug) return [];
    const info = modelInfo({ context_window: model.context_window, max_context_window: model.max_context_window,
      supported_reasoning_levels: model.supported_reasoning_levels, input_modalities: model.input_modalities }, model.slug);
    if (!info.reasoning && !info.maxContextWindow && !info.imageInput) return [];
    return [info];
  });
}

function cachedOfficialCatalog(): Promise<ModelInfo[]> {
  const now = Date.now();
  if (cachedModels && now < expiresAt) return Promise.resolve(cachedModels);
  if (officialCatalog) return officialCatalog;
  if (!cachedModels && now < retryAfter) return Promise.resolve([]);
  const pending = loadOfficialModelCatalog().then(models => {
    cachedModels = models;
    expiresAt = Date.now() + OFFICIAL_CATALOG_TTL_MS;
    retryAfter = 0;
    return models;
  }).catch(error => {
    const current = Date.now();
    retryAfter = current + OFFICIAL_CATALOG_FAILURE_BACKOFF_MS;
    if (cachedModels) {
      expiresAt = current + OFFICIAL_CATALOG_FAILURE_BACKOFF_MS;
      return cachedModels;
    }
    throw error;
  }).finally(() => {
    if (officialCatalog === pending) officialCatalog = undefined;
  });
  officialCatalog = pending;
  return pending;
}

export async function supplementChatGptCatalog(models: ModelInfo[], loadCatalog = cachedOfficialCatalog): Promise<ModelInfo[]> {
  if (models.every(model => model.reasoning !== undefined && model.maxContextWindow !== undefined && model.imageInput !== undefined)) return models;
  try {
    const officialModels = new Map((await loadCatalog()).map(model => [model.id, model]));
    return models.map(model => {
      const official = officialModels.get(model.id);
      const reasoning = model.reasoning === undefined && official?.reasoning?.length
        ? { reasoning: official.reasoning, reasoningSource: 'official-catalog' as const } : {};
      const maximum = model.maxContextWindow === undefined && official?.maxContextWindow
        ? { maxContextWindow: official.maxContextWindow, maxContextWindowSource: 'official-catalog' as const } : {};
      const image = (model.imageInput === undefined || model.imageInput === 'unverified') && official?.imageInput
        ? { imageInput: official.imageInput, imageInputSource: 'official-catalog' as const } : {};
      return Object.keys(reasoning).length || Object.keys(maximum).length || Object.keys(image).length
        ? { ...model, ...reasoning, ...maximum, ...image } : model;
    });
  } catch { return models; }
}
