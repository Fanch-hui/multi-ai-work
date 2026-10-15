import type { ToolConnection } from './types.js';

export function toolConfiguration(connection: ToolConnection): string {
  const { name, kind, transport, url, command, args, secretRef, enabled } = connection;
  return JSON.stringify({ name, kind, transport, url, command, args, secretRef, enabled });
}
