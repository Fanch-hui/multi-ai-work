export interface ConnectorDraftField {
  path: string[];
  label: string;
  kind: 'recipient' | 'subject' | 'body' | 'text' | 'list';
}

export interface ConnectorDraft {
  id: string;
  requestId: string;
  creationFingerprint?: string;
  conversationId: string;
  sourceTaskId: string;
  botId: string;
  connectionId: string;
  connectionConfiguration: string;
  toolName: string;
  title: string;
  arguments: Record<string, unknown>;
  fields: ConnectorDraftField[];
  revision: number;
  status: 'draft' | 'approved' | 'sending' | 'sent' | 'failed' | 'unknown' | 'cancelled';
  confirmedRevision?: number;
  confirmedAt?: string;
  dispatchTaskId?: string;
  operationId?: string;
  result?: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ConnectorDraftView extends ConnectorDraft {
  connectionName: string;
  botName: string;
  dispatchStatus?: string;
  sendBlockedReason?: string;
}

export function draftFieldValue(args: Record<string, unknown>, path: string[]): unknown {
  let value: unknown = args;
  for (const part of path) {
    if (!value || typeof value !== 'object' || !Object.hasOwn(value, part)) return undefined;
    value = (value as Record<string, unknown>)[part];
  }
  return value;
}

export function withDraftField(
  args: Record<string, unknown>,
  path: string[],
  value: string | string[],
): Record<string, unknown> {
  const updated = structuredClone(args);
  let target = updated;
  for (const part of path.slice(0, -1)) {
    const next = target[part];
    if (!next || typeof next !== 'object' || Array.isArray(next))
      throw new Error('草稿字段路径不存在');
    target = next as Record<string, unknown>;
  }
  const key = path.at(-1);
  if (!key || !Object.hasOwn(target, key)) throw new Error('草稿字段路径不存在');
  target[key] = value;
  return updated;
}
