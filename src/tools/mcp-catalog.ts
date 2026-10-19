import { createHash } from 'node:crypto';
import type { ToolConnection } from '../domain/types.js';

export interface McpToolTarget {
  connectionId: string;
  toolName: string;
}
export interface McpCatalogDiagnostic {
  connectionId: string;
  message: string;
}

export function remoteToolAlias(connection: Pick<ToolConnection, 'id'>, toolName: string): string {
  const normalize = (value: string) => value.replace(/[^a-zA-Z0-9_-]/g, '_');
  const hash = createHash('sha256')
    .update(JSON.stringify([connection.id, toolName]))
    .digest('hex')
    .slice(0, 10);
  const namespace = normalize(connection.id).slice(0, 18);
  const prefix = `mcp__${namespace}__`;
  const name = normalize(toolName).slice(0, 64 - prefix.length - hash.length - 2);
  return `${prefix}${name}__${hash}`;
}
