import type { ChiefInput } from '../domain/chief-work.js';

export function restoreChiefInput(input: ChiefInput): ChiefInput {
  if (!['pending', 'routing'].includes(input.status)) return input;
  return {
    ...input,
    status: 'failed',
    routingTaskId: undefined,
    error: '备份已恢复，请确认项目与连接后重试这条消息。',
  };
}
