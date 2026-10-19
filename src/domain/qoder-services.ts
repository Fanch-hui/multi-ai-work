import type { Bot, QoderService } from './types.js';

export const qoderServiceNames = [
  'WebSearch',
  'WebFetch',
  'ImageSearch',
  'ImageGen',
  'SecurityScan',
] as const;
export const qoderServices: { id: QoderService; label: string; hint: string }[] = [
  { id: 'WebSearch', label: '网页搜索', hint: '使用 Qoder 原生服务搜索公开资料。' },
  { id: 'WebFetch', label: '网页读取', hint: '读取并提取公共网页内容。' },
  { id: 'ImageSearch', label: '图片搜索', hint: '查找配图，返回图片及来源地址。' },
  { id: 'ImageGen', label: '图片生成', hint: '生成图片并保存为当前任务成果，需要可写工作区。' },
  {
    id: 'SecurityScan',
    label: '代码安全扫描',
    hint: '使用本机 Qoder 登录，将指定代码提交至官方扫描服务，可能消耗积分。',
  },
];

export function enabledQoderServices(
  bot: Pick<Bot, 'qoderServices' | 'toolNames'>,
): QoderService[] {
  if (bot.qoderServices !== undefined) return [...new Set(bot.qoderServices)];
  return qoderServiceNames.filter((name) => {
    if (name === 'WebFetch') return bot.toolNames.includes('fetch_web');
    if (name === 'WebSearch' || name === 'ImageSearch') return bot.toolNames.includes('search_web');
    if (name === 'ImageGen')
      return (
        bot.toolNames.includes('write_artifact') && bot.toolNames.includes('register_artifact')
      );
    return bot.toolNames.includes('read_file');
  });
}
