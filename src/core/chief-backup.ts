import type { ChiefInput } from '../domain/chief-work.js';

export function restoreChiefInput(input: ChiefInput): ChiefInput {
  if (!['pending', 'routing', 'clarification'].includes(input.status)) return input;
  return {
    ...input,
    status: 'failed',
    routingTaskId: undefined,
    error: '备份已恢复，请确认项目与连接后重试这条消息。',
  };
}

export function restoreChiefMetadata(key: string, value: string): string {
  if (!key.startsWith('chief-work-reports:')) return value;
  const reports = JSON.parse(value) as { deliveredAt?: string; suspended?: boolean }[];
  return JSON.stringify(
    reports.map((report) => (report.deliveredAt ? report : { ...report, suspended: true })),
  );
}
