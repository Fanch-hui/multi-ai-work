import OpenAI from 'openai';
import { networkErrorCode } from '../network.js';

export class InterruptedModelStreamError extends Error {
  readonly code = 'MODEL_STREAM_INTERRUPTED';
}

export class InactiveModelStreamError extends Error {
  readonly code = 'MODEL_STREAM_INACTIVE';
}

export class CompletedStreamTailError extends Error {}

const retryableNetworkCodes = new Set([
  'ECONNRESET',
  'ECONNABORTED',
  'ETIMEDOUT',
  'EPIPE',
  'EAI_AGAIN',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'UND_ERR_SOCKET',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'ERR_CONNECTION_CLOSED',
  'ERR_CONNECTION_RESET',
  'ERR_CONNECTION_ABORTED',
  'ERR_CONNECTION_TIMED_OUT',
  'ERR_TIMED_OUT',
  'ERR_NETWORK_CHANGED',
  'ERR_INTERNET_DISCONNECTED',
]);

export function isRecoverableStreamError(error: unknown): boolean {
  if (error instanceof InterruptedModelStreamError || error instanceof InactiveModelStreamError)
    return true;
  const code = networkErrorCode(error);
  if (code) return retryableNetworkCodes.has(code);
  return error instanceof OpenAI.APIConnectionTimeoutError;
}
