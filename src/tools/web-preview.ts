type RecordValue = Record<string, unknown>;

const SEARCH_LIMIT = 10;
const SNIPPET_LIMIT = 600;
const EXCERPT_LIMIT = 5_000;
const LINK_LIMIT = 12;
const DATE_FIELDS = ['date', 'published_date', 'publishedDate', 'publication_date', 'published_at', 'updated_at'];
const METADATA_FIELDS = ['query', 'connectionId', 'service', 'backend', 'fetchedAt', 'truncated'];
const PAGINATION_FIELDS = ['total', 'totalResults', 'count', 'hasMore', 'nextCursor', 'cursor', 'nextOffset', 'page', 'offset', 'pagination'];

function record(value: unknown): RecordValue | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : undefined;
}

function hasError(value: RecordValue): boolean {
  return value.isError === true || value.success === false || value.status === 'error'
    || Boolean(value.error) || Array.isArray(value.errors) && value.errors.length > 0
    || Array.isArray(value.failed_results) && value.failed_results.length > 0;
}

function supplied(value: RecordValue, fields: string[]): RecordValue {
  return Object.fromEntries(fields.filter(field => value[field] !== undefined).map(field => [field, value[field]]));
}

function stringField(value: RecordValue, fields: string[]): string | undefined {
  return fields.map(field => value[field]).find(candidate => typeof candidate === 'string') as string | undefined;
}

function urlOf(value: RecordValue): string | undefined {
  const candidate = stringField(value, ['url', 'link', 'href']);
  if (!candidate) return undefined;
  try {
    const url = new URL(candidate);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : undefined;
  } catch { return undefined; }
}

function parsed(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value) as unknown; } catch { return undefined; }
}

function resultItems(value: unknown): unknown[] | undefined {
  if (Array.isArray(value)) return value;
  const object = record(value);
  if (!object || hasError(object)) return undefined;
  const webPages = record(object.webPages);
  return [object.results, object.items, object.organic_results, webPages?.value].find(Array.isArray);
}

function dates(value: RecordValue): RecordValue {
  return Object.fromEntries(DATE_FIELDS.filter(field => typeof value[field] === 'string').map(field => [field, value[field]]));
}

function pagination(value: RecordValue): RecordValue {
  return Object.fromEntries(PAGINATION_FIELDS.filter(field => {
    const item = value[field];
    return item === null || ['string', 'number', 'boolean'].includes(typeof item) || Boolean(record(item));
  }).map(field => [field, value[field]]));
}

function searchPreview(payload: unknown, metadata: RecordValue): RecordValue | undefined {
  const items = resultItems(payload);
  if (!items?.length) return undefined;
  const results: RecordValue[] = [];
  const seen = new Set<string>();
  let uniqueCount = 0;
  for (const value of items) {
    const item = record(value);
    if (!item || hasError(item)) return undefined;
    const url = urlOf(item);
    if (!url) return undefined;
    if (seen.has(url)) continue;
    seen.add(url);
    uniqueCount++;
    if (results.length === SEARCH_LIMIT) continue;
    const text = stringField(item, ['snippet', 'description', 'content', 'raw_content']) ?? '';
    results.push({ url, title: (stringField(item, ['title', 'name']) ?? '').slice(0, 512),
      snippet: text.slice(0, SNIPPET_LIMIT), snippetTruncated: text.length > SNIPPET_LIMIT, ...dates(item) });
  }
  return { ...supplied(metadata, METADATA_FIELDS), ...pagination(metadata), ...pagination(record(payload) ?? {}),
    previewOnly: true, snippetKind: 'source_text', results, returnedResults: uniqueCount, omittedResults: uniqueCount - results.length };
}

function pagePreview(page: RecordValue): RecordValue | undefined {
  const url = urlOf(page);
  const content = stringField(page, ['content', 'raw_content']);
  if (!url || content === undefined || hasError(page)) return undefined;
  const candidates = page.links;
  if (candidates !== undefined && !Array.isArray(candidates)) return undefined;
  const links: RecordValue[] = [];
  const seen = new Set<string>();
  for (const value of candidates ?? []) {
    const link = record(value);
    const href = link && urlOf(link);
    if (!link || !href) return undefined;
    if (seen.has(href)) continue;
    seen.add(href);
    if (links.length < LINK_LIMIT) links.push({ url: href, title: (stringField(link, ['title', 'text']) ?? '').slice(0, 512) });
  }
  return { ...supplied(page, METADATA_FIELDS), url, title: (stringField(page, ['title']) ?? '').slice(0, 512),
    ...dates(page), previewOnly: true, excerptKind: 'source_text', excerpt: content.slice(0, EXCERPT_LIMIT),
    excerptTruncated: content.length > EXCERPT_LIMIT, links, omittedLinks: seen.size - links.length };
}

function mcpPayload(result: RecordValue): unknown {
  if (Array.isArray(result.content) && result.content.some(value => record(value)?.type !== 'text')) return undefined;
  if (result.structuredContent !== undefined) return parsed(result.structuredContent);
  if (!Array.isArray(result.content)) return undefined;
  const text = result.content.map(value => record(value)?.text).filter(value => typeof value === 'string').join('\n');
  return parsed(text);
}

export function webResultPreview(name: string, args: RecordValue, result: unknown): RecordValue | undefined {
  const output = record(result);
  if (!output || hasError(output)) return undefined;
  if (name === 'fetch_web') return pagePreview(output);
  if (name === 'search_web') return searchPreview(parsed(output.results), output);
  if (name !== 'call_mcp' || typeof args.toolName !== 'string') return undefined;
  const tool = args.toolName;
  if (!['tavily-search', 'tavily_search', 'tavily-extract', 'tavily_extract'].includes(tool)) return undefined;
  const payload = mcpPayload(output);
  const object = record(payload);
  if (object && hasError(object)) return undefined;
  if (tool === 'tavily-search' || tool === 'tavily_search') return searchPreview(payload, object ?? {});
  const items = resultItems(payload);
  if (!items?.length) return undefined;
  const pages = items.map(item => record(item)).map(item => item && pagePreview(item));
  if (pages.some(page => !page)) return undefined;
  return { previewOnly: true, results: pages, ...supplied(object ?? {}, ['fetchedAt']) };
}
