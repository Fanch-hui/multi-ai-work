import type { Connection } from '../../../src/domain/types.js';

export function modelLabel(connection: Pick<Connection, 'models'> | undefined, modelId: string | undefined,
  fallback = '待配置模型'): string {
  if (!modelId) return fallback;
  return connection?.models.find(model => model.id === modelId)?.name.trim() || modelId;
}
