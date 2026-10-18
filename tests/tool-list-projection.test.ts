import { describe, expect, it } from 'vitest';
import type { ModelMessage } from '../src/domain/provider.js';
import { estimateModelMessageTokens } from '../src/runtime/model-history.js';
import { projectListToolResult } from '../src/runtime/tool-list-projection.js';

const message = (result: unknown): ModelMessage => ({ role: 'tool', callId: 'list', content: JSON.stringify(result) });
const files = Array.from({ length: 1000 }, (_, index) => ({ path: `文件/${index}.txt` }));

describe('大列表结果预算', () => {
  it('短条目也受总预算约束，保留完整条目与原始分页，全文从字符零读取', () => {
    const original = message({ path: '/workspace', items: files, total: 2000, offset: 100, nextOffset: 1100,
      status: 'completed', error: null, version: 'v1', query: '资料' });
    const result = projectListToolResult(original, { id: 'full' }, 900, 'responses', 'find_files')!;
    const preview = JSON.parse(result.content);
    expect(estimateModelMessageTokens(result)).toBeLessThanOrEqual(900);
    expect(preview).toMatchObject({ path: '/workspace', total: 2000, status: 'completed', error: null, version: 'v1', query: '资料',
      previewOnly: true, originalPagination: { offset: 100, nextOffset: 1100 },
      fullResult: { tool: 'read_artifact', arguments: { artifactId: 'full', offset: 0 } } });
    expect(preview.nextOffset).toBeUndefined();
    expect(preview.previewOmission).toBeUndefined();
    expect(preview.items.length).toBeGreaterThan(0);
    expect(preview.items).toEqual(files.slice(0, preview.returnedItems));
    expect(preview.omittedItems).toBe(1000 - preview.items.length);
    expect(JSON.parse(original.content).items).toEqual(files);
  });

  it.each([
    ['list_directory', { path: 'a', name: 'a', type: 'file', size: 1 }],
    ['search_text', { path: 'a', line: 2, text: '目标', context: [{ line: 1, text: '上下文' }] }],
    ['list_artifacts', { id: 'artifact', name: '成果', path: '/a', size: 1, sha256: 'hash', requirementVersion: 2 }],
  ])('识别 %s 的真实列表结构并保留每项资料', (toolName, item) => {
    const items = Array.from({ length: 100 }, () => item);
    const result = projectListToolResult(message({ items, total: 100, nextOffset: null }), { id: 'full' }, 800, 'chat-completions', toolName)!;
    expect(estimateModelMessageTokens(result, 'chat-completions')).toBeLessThanOrEqual(800);
    expect(JSON.parse(result.content).items).toContainEqual(item);
  });

  it('消息搜索保持稳定消息标识和完整摘录，不伪造总匹配数', () => {
    const items = Array.from({ length: 100 }, (_, index) => ({ messageId: `m${index}`, sequence: index,
      authorType: 'user', createdAt: '2026-10-18', excerpt: '完整摘录'.repeat(50) }));
    const result = projectListToolResult(message(items), { id: 'full' }, 1200, 'responses', 'search_messages')!;
    const preview = JSON.parse(result.content);
    expect(preview.items.length).toBeGreaterThan(0);
    expect(preview.items).toEqual(items.slice(0, preview.returnedItems));
    expect(preview.total).toBeUndefined();
    expect(estimateModelMessageTokens(result)).toBeLessThanOrEqual(1200);
  });

  it('图像和消息归属保留，元数据及图片成本都计入预算', () => {
    const original = { ...message({ path: '/workspace', items: files, total: 1000 }),
      images: [{ artifactId: 'image', mimeType: 'image/png' }], contextArtifactIds: ['earlier'], sourceMessageId: 'source' };
    const result = projectListToolResult(original, { id: 'full' }, 2000, 'responses', 'find_files')!;
    expect(result.images).toEqual(original.images);
    expect(result.callId).toBe('list');
    expect(result.sourceMessageId).toBe('source');
    expect(result.contextArtifactIds).toEqual(['earlier', 'full']);
    expect(estimateModelMessageTokens(result)).toBeLessThanOrEqual(2000);
    expect(projectListToolResult(original, { id: 'full' }, 1000, 'responses', 'find_files')).toBeUndefined();
  });

  it('错误、未知格式、原生协议和小结果保持既有路径', () => {
    const list = { items: files, total: 1000 };
    for (const original of [message({ ...list, error: 'failure' }), message({ ...list, status: 'failed' }),
      message({ ...list, unexpected: { details: '保留' } }), message({ items: [{ other: 'unknown' }] }),
      { ...message(list), providerItems: [{ type: 'function_call_output', output: 'opaque' }] }]) {
      expect(projectListToolResult(original, { id: 'full' }, 900, 'responses', 'find_files')).toBeUndefined();
    }
    expect(projectListToolResult(message(list), { id: 'full' }, 900, 'responses', 'unknown')).toBeUndefined();
    expect(projectListToolResult(message({ items: files.slice(0, 1), total: 1 }), { id: 'full' }, 900, 'responses', 'find_files')).toBeUndefined();
    expect(projectListToolResult(message(list), { id: 'full' }, 10, 'responses', 'find_files')).toBeUndefined();
  });
});
