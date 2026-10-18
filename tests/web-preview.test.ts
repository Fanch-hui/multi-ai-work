import { describe, expect, it } from 'vitest';
import { webResultPreview } from '../src/tools/web-preview.js';

describe('web result previews', () => {
  it('deduplicates search URLs, bounds snippets and retains original source dates', () => {
    const original = { query: 'test', service: 'HTTP', fetchedAt: '2026-10-18', truncated: false,
      results: { results: [
        { title: 'First', url: 'https://example.com/a', content: '正文'.repeat(500), published_date: 'Last Monday', score: 0.9 },
        { title: 'Duplicate', link: 'https://example.com/a', snippet: 'duplicate' },
        ...Array.from({ length: 11 }, (_, index) => ({ url: `https://example.com/${index}`, snippet: 'short', date: '2026-10-17' }))
      ] } };
    const before = structuredClone(original);
    const preview = webResultPreview('search_web', {}, original)!;
    const results = preview.results as Record<string, unknown>[];
    expect(results).toHaveLength(10);
    expect(results[0]).toEqual({ url: 'https://example.com/a', title: 'First', snippet: '正文'.repeat(300),
      snippetTruncated: true, published_date: 'Last Monday' });
    expect(results[1].date).toBe('2026-10-17');
    expect(preview).toMatchObject({ query: 'test', service: 'HTTP', fetchedAt: '2026-10-18', truncated: false,
      previewOnly: true, snippetKind: 'source_text', returnedResults: 12, omittedResults: 2 });
    expect(original).toEqual(before);
  });

  it('preserves server pagination and distinguishes total matches from returned results', () => {
    const pagination = { total: 250, totalResults: 250, count: 1, hasMore: true, nextCursor: 'next', cursor: 'current',
      nextOffset: 11, page: 2, offset: 10, pagination: { totalPages: 25, next: 3 } };
    const payload = { ...pagination, results: [{ url: 'https://example.com/', content: 'original', date: '2026-10-17' }] };
    const before = structuredClone(payload);
    for (const preview of [
      webResultPreview('search_web', {}, { results: payload }),
      webResultPreview('call_mcp', { toolName: 'tavily_search' }, { structuredContent: payload })
    ]) {
      expect(preview).toMatchObject({ ...pagination, returnedResults: 1, omittedResults: 0 });
      expect((preview!.results as Record<string, unknown>[])[0].date).toBe('2026-10-17');
    }
    expect(payload).toEqual(before);
  });

  it('provides original webpage excerpts with bounded deduplicated links', () => {
    const original = { url: 'https://example.com/page', title: 'Page', content: '原文'.repeat(4_000),
      fetchedAt: '2026-10-18T12:00:00Z', truncated: false,
      links: [{ url: 'https://example.com/0', title: 'First' },
        ...Array.from({ length: 15 }, (_, index) => ({ url: `https://example.com/${index}`, title: `Link ${index}` }))] };
    const before = structuredClone(original);
    const preview = webResultPreview('fetch_web', {}, original)!;
    expect(preview).toMatchObject({ url: original.url, title: original.title, fetchedAt: original.fetchedAt,
      truncated: false, excerpt: original.content.slice(0, 5_000), excerptKind: 'source_text', excerptTruncated: true, omittedLinks: 3 });
    expect(preview.links).toHaveLength(12);
    expect((preview.links as unknown[])[0]).toEqual(original.links[0]);
    expect(original).toEqual(before);
  });

  it('recognizes structured Tavily search and JSON text responses', () => {
    const payload = { query: 'test', results: [{ title: 'Source', url: 'https://example.com/', content: 'source text', publishedDate: '18 Oct 2026' }] };
    const structured = webResultPreview('call_mcp', { toolName: 'tavily_search' }, { structuredContent: payload });
    const text = webResultPreview('call_mcp', { toolName: 'tavily-search' }, { content: [{ type: 'text', text: JSON.stringify(payload) }] });
    expect(text).toEqual(structured);
    expect((structured!.results as Record<string, unknown>[])[0]).toMatchObject({ snippet: 'source text', publishedDate: '18 Oct 2026' });
  });

  it('extracts Tavily webpages and leaves missing publication dates unknown', () => {
    const payload = { results: [{ url: 'https://example.com/', raw_content: 'long webpage'.repeat(800), title: 'Page' }], failed_results: [] };
    const preview = webResultPreview('call_mcp', { toolName: 'tavily-extract' }, { structuredContent: payload })!;
    const page = (preview.results as Record<string, unknown>[])[0];
    expect(page).toMatchObject({ title: 'Page', excerptKind: 'source_text', excerptTruncated: true });
    expect(page.excerpt).toHaveLength(5_000);
    expect(page).not.toHaveProperty('date');
    expect(page).not.toHaveProperty('fetchedAt');
  });

  it.each([
    ['search_web', {}, { results: 'unknown text', sources: [] }],
    ['search_web', {}, { results: { message: 'unknown structure' } }],
    ['search_web', {}, { results: { results: [{ url: 'https://example.com/', error: 'access denied' }] } }],
    ['search_web', {}, { results: { error: 'unavailable', results: [{ url: 'https://example.com/' }] } }],
    ['fetch_web', {}, { url: 'https://example.com/', content: 'text', error: 'partial failure' }],
    ['call_mcp', { toolName: 'another-search' }, { structuredContent: { results: [{ url: 'https://example.com/' }] } }],
    ['call_mcp', { toolName: 'tavily_search' }, { isError: true, content: [{ type: 'text', text: 'failure' }] }],
    ['call_mcp', { toolName: 'tavily-search' }, { content: [{ type: 'text', text: '# Results\nhttps://example.com/' }] }],
    ['call_mcp', { toolName: 'tavily_extract' }, { structuredContent: { results: [{ url: 'https://example.com/', raw_content: 'text' }], failed_results: [{ error: 'failed' }] } }],
    ['call_mcp', { toolName: 'tavily_search' }, { structuredContent: { results: [{ url: 'https://example.com/' }] }, content: [{ type: 'image', data: 'image' }] }]
  ])('preserves unknown, failed or media-bearing results: %s', (name, args, result) => {
    expect(webResultPreview(name as string, args as Record<string, unknown>, result)).toBeUndefined();
  });
});
