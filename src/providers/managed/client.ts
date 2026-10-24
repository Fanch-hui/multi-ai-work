import OpenAI from 'openai';
import type { Connection, Capabilities, ModelInfo } from '../../domain/types.js';
import type { ProbeContext } from '../../domain/provider.js';
import { decodeModelCatalog, supplementChatGptCatalog } from './catalog.js';
import { providerFetch, providerNetworkError } from '../network.js';
import { isTransientModelError, modelErrorDetails } from './retry.js';
import { InactiveModelStreamError, InterruptedModelStreamError } from './request-errors.js';

export class ProviderAuthorizationError extends Error {
  constructor(readonly failure: Error) {
    super(failure.message, { cause: failure });
  }
}

export function endpoint(connection: Connection): string {
  if (connection.provider === 'chatgpt') return 'https://api.openai.com/v1';
  if (!connection.baseUrl) throw new Error('请填写 API 地址');
  const url = new URL(connection.baseUrl);
  if (url.username || url.password || url.search || url.hash)
    throw new Error('API 地址不能包含凭据或查询参数');
  if (
    url.protocol !== 'https:' &&
    !(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))
  ) {
    throw new Error('远程 API 地址必须使用 HTTPS');
  }
  return url.toString().replace(/\/$/, '');
}
export function createClient(
  baseUrl: string,
  token?: string,
  fetcher: typeof fetch = providerFetch,
): OpenAI {
  return new OpenAI({
    baseURL: baseUrl,
    apiKey: token ?? 'unauthenticated',
    maxRetries: 0,
    timeout: 120_000,
    fetch: (input, init) => {
      const headers = new Headers(init?.headers);
      if (!token) headers.delete('authorization');
      return fetcher(input, { ...init, headers, redirect: 'error' });
    },
  });
}
export function capabilities(verified: boolean): Capabilities {
  return {
    runtimeKind: 'managed-model',
    contextOwner: 'app',
    tools: verified ? 'supported' : 'unverified',
    resume: 'supported',
    imageInput: 'supported',
    compaction: 'supported',
    contextUsage: 'unverified',
    permissionEnforcement: 'gateway',
  };
}
export async function modelCatalog(
  context: ProbeContext,
  token: string | undefined,
  oauth: boolean,
): Promise<ModelInfo[]> {
  const response = await providerFetch(`${endpoint(context.connection)}/models`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    redirect: 'error',
    signal: AbortSignal.any([context.signal, AbortSignal.timeout(30_000)]),
  });
  if (!response.ok) {
    if (!oauth && [404, 405, 501].includes(response.status)) return [];
    throw new Error(`模型目录读取失败（HTTP ${response.status}）`);
  }
  const models = decodeModelCatalog(await response.json(), oauth);
  if (!models) {
    if (oauth) throw new Error('ChatGPT 模型目录格式无效');
    return [];
  }
  return oauth ? supplementChatGptCatalog(models) : models;
}
export function providerError(error: unknown): Error {
  if (error instanceof InactiveModelStreamError || error instanceof InterruptedModelStreamError)
    return error;
  if (error instanceof ProviderAuthorizationError) return error.failure;
  if (
    error instanceof OpenAI.APIConnectionError &&
    error.cause instanceof ProviderAuthorizationError
  )
    return error.cause.failure;
  if (error instanceof OpenAI.APIConnectionError) return providerNetworkError(error);
  const safeDetails = modelErrorDetails(error);
  const { status, code } = safeDetails;
  if (error instanceof OpenAI.APIError || status || code) {
    const details = [status ? `HTTP ${status}` : '', code ?? ''].filter(Boolean).join('，');
    const message = isTransientModelError(error) ? '模型服务繁忙，请稍后重试' : '模型请求失败';
    return Object.assign(new Error(`${message}${details ? `（${details}）` : ''}`), safeDetails);
  }
  return error instanceof Error ? error : new Error('模型请求失败');
}
