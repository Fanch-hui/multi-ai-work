import { load } from 'cheerio';

const LINK_LIMIT = 100;
const LINK_BUDGET = 12_000;

export interface WebLink {
  url: string;
  title: string;
}

function readableUrl(value: string, base?: string): string | undefined {
  try {
    const url = new URL(value, base);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password
      ? url.href
      : undefined;
  } catch {
    return undefined;
  }
}

function cleanText(value: string): string {
  return value
    .replace(/[\t\r\f ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function collectLinks(candidates: Iterable<WebLink>): { links: WebLink[]; truncated: boolean } {
  const links: WebLink[] = [];
  const seen = new Set<string>();
  let size = 0;
  let truncated = false;
  for (const candidate of candidates) {
    if (seen.has(candidate.url)) continue;
    seen.add(candidate.url);
    const title = cleanText(candidate.title).slice(0, 512);
    const length = candidate.url.length + title.length;
    if (links.length >= LINK_LIMIT || size + length > LINK_BUDGET) {
      truncated = true;
      continue;
    }
    links.push({ url: candidate.url, title });
    size += length;
  }
  return { links, truncated };
}

export function extractWebContent(text: string, contentType: string, url: string) {
  if (!/html/i.test(contentType)) {
    return { title: '', content: text, links: [] as WebLink[], truncated: false };
  }
  const $ = load(text);
  const title = cleanText($('title').first().text()).slice(0, 512);
  const base = readableUrl($('base[href]').first().attr('href') ?? '', url) ?? url;
  $(
    'script, style, noscript, template, iframe, object, embed, svg, nav, header, footer, aside, form, [hidden], [aria-hidden="true"]',
  ).remove();
  const main = $('main, article, [role="main"]').first();
  const root = main.length ? main : $('body');
  const candidates: WebLink[] = [];
  root.find('a[href]').each((_index, element) => {
    const link = $(element);
    const href = readableUrl(link.attr('href') ?? '', base);
    if (href) candidates.push({ url: href, title: link.text() || link.attr('aria-label') || '' });
  });
  const { links, truncated: linksTruncated } = collectLinks(candidates);
  root.find('br').replaceWith('\n');
  root
    .find('p, div, section, article, h1, h2, h3, h4, h5, h6, li, tr, pre, blockquote')
    .append('\n');
  const content = cleanText(root.text());
  return { title, content, links, truncated: linksTruncated };
}

function* resultLinks(value: unknown): Generator<WebLink> {
  if (Array.isArray(value)) {
    for (const item of value) yield* resultLinks(item);
    return;
  }
  if (!value || typeof value !== 'object') return;
  const item = value as Record<string, unknown>;
  const href = [item.url, item.link, item.href].find((candidate) => typeof candidate === 'string');
  const url = typeof href === 'string' ? readableUrl(href) : undefined;
  if (url) yield { url, title: typeof item.title === 'string' ? item.title : '' };
  for (const child of Object.values(item)) yield* resultLinks(child);
}

export function extractSearchResults(text: string) {
  try {
    const results: unknown = JSON.parse(text);
    const { links: sources, truncated } = collectLinks(resultLinks(results));
    return { results, sources, truncated };
  } catch {
    return { results: text, sources: [] as WebLink[], truncated: false };
  }
}
