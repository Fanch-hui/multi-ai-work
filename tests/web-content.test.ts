import { describe, expect, it } from 'vitest';
import { extractSearchResults, extractWebContent } from '../src/tools/web-content.js';

describe('web content extraction', () => {
  it('extracts real HTML DOM content, title and resolved links without running scripts', () => {
    const output = extractWebContent(`<!doctype html><title>工具 &amp; 资料</title>
      <base href="/docs/"><nav>导航广告<a href="/ad">广告</a></nav>
      <main><h1>资料</h1><p>甲 &lt; 乙 &nbsp; &#20013;</p>
      <p><a href="guide">指南</a><a href="guide">重复</a>
      <a href="https://example.net/reference">参考</a><a href="javascript:alert(1)">脚本</a>
      <a href="https://name:password@example.com">凭据链接</a></p>
      <div hidden>隐藏内容</div><script>throw new Error('must not run')</script></main><footer>版权噪音</footer>`,
    'text/html; charset=utf-8', 'https://example.com/index');
    expect(output.title).toBe('工具 & 资料');
    expect(output.content).toContain('资料\n');
    expect(output.content).toContain('甲 < 乙');
    expect(output.content).toContain('中');
    expect(output.content).not.toMatch(/导航广告|隐藏内容|must not run|版权噪音/);
    expect(output.links).toEqual([
      { url: 'https://example.com/docs/guide', title: '指南' },
      { url: 'https://example.net/reference', title: '参考' }
    ]);
    expect(output.truncated).toBe(false);
  });

  it('falls back to body content and keeps plain text literal', () => {
    expect(extractWebContent('<title>Title</title><body><p>Body</p></body>', 'text/html', 'https://example.com').content).toBe('Body');
    expect(extractWebContent('<script>literal text</script>', 'text/plain', 'https://example.com')).toEqual({
      title: '', content: '<script>literal text</script>', links: [], truncated: false
    });
  });

  it('preserves full fetched text for Core archiving and bounds link metadata', () => {
    const output = extractWebContent(`<main>${'x'.repeat(80_001)}${Array.from({ length: 101 }, (_, index) => `<a href="/${index}">link</a>`).join('')}</main>`, 'text/html', 'https://example.com');
    expect(output.content.length).toBeGreaterThan(80_000);
    expect(output.links).toHaveLength(100);
    expect(output.truncated).toBe(true);
    expect(extractWebContent('x'.repeat(80_001), 'text/plain', 'https://example.com')).toMatchObject({ content: 'x'.repeat(80_001), truncated: false });
  });
});

describe('search result extraction', () => {
  it('preserves original result fields and only reports supplied sources', () => {
    const original = { total: 3, results: [
      { title: 'A', url: 'https://example.com/a', snippet: 'real snippet', score: 0.8 },
      { title: 'Duplicate', link: 'https://example.com/a' },
      { href: 'https://example.net/b', date: '2026-10-12' },
      { title: 'Unsupported', url: 'file:///private/file' },
      { title: 'Relative', url: '/ambiguous' }
    ] };
    const output = extractSearchResults(JSON.stringify(original));
    expect(output.results).toEqual(original);
    expect(output.sources).toEqual([
      { url: 'https://example.com/a', title: 'A' },
      { url: 'https://example.net/b', title: '' }
    ]);
    expect(output.truncated).toBe(false);
  });

  it('keeps JSON results intact for Core compaction and bounds source metadata', () => {
    const original = { results: Array.from({ length: 101 }, (_, index) => ({ url: `https://example.com/${index}`, snippet: 'x'.repeat(1_000) })) };
    const output = extractSearchResults(JSON.stringify(original));
    expect(output.results).toEqual(original);
    expect(output.sources).toHaveLength(100);
    expect(output.truncated).toBe(true);
  });

  it('preserves a non-JSON search response for Core archiving without inventing sources', () => {
    const output = extractSearchResults('x'.repeat(80_001));
    expect(output.results).toHaveLength(80_001);
    expect(output.sources).toEqual([]);
    expect(output.truncated).toBe(false);
  });
});
