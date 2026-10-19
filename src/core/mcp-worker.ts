import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { randomUUID } from 'node:crypto';
import type { ToolDefinition } from '../domain/provider.js';

const url = new URL(process.env.AI_TEAM_CORE_URL ?? '');
if (url.hostname !== '127.0.0.1' || url.protocol !== 'http:' || !process.env.AI_TEAM_RUN_TOKEN)
  throw new Error('工具运行授权缺失');
const headers = {
  Authorization: `Bearer ${process.env.AI_TEAM_RUN_TOKEN}`,
  'Content-Type': 'application/json',
};
async function request(path: string, body?: unknown) {
  const response = await fetch(new URL(path, url), {
    method: body ? 'POST' : 'GET',
    headers,
    body: body ? JSON.stringify(body) : undefined,
    redirect: 'error',
  });
  const value = await response.json();
  if (!response.ok || value.error)
    throw new Error(typeof value.error === 'string' ? value.error : '工具调用失败');
  return value;
}
async function loadTools() {
  const definitions = (await request('/native/tools')) as ToolDefinition[];
  return definitions.map((tool) => ({
    ...tool,
    inputSchema: { ...tool.inputSchema, type: 'object' as const },
  }));
}
await loadTools();
const server = new Server({ name: 'ai-team', version: '0.1.0' }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: await loadTools() }));
const yielding = new Set<string | number>();
server.setRequestHandler(CallToolRequestSchema, async (input, extra) => {
  try {
    const meta = input.params._meta as Record<string, unknown> | undefined;
    let metaId: string | undefined;
    if (typeof meta?.callId === 'string' && meta.callId.trim()) {
      metaId = meta.callId.trim();
    } else if (typeof meta?.client_request_id === 'string' && meta.client_request_id.trim()) {
      metaId = meta.client_request_id.trim();
    }
    const value = await request('/native/call', {
      name: input.params.name,
      args: input.params.arguments ?? {},
      callId: metaId ?? randomUUID(),
    });
    if (value.result?.waitingForInput === true) yielding.add(extra.requestId);
    const result = value.result;
    if (Array.isArray(result?.content)) {
      const content = await Promise.all(
        result.content.map(async (item: Record<string, unknown>) => {
          if (item.type === 'image' && item.image && typeof item.image === 'object') {
            const image = await request('/native/image', {
              artifactId: (item.image as { artifactId: string }).artifactId,
            });
            return {
              type: 'image' as const,
              mimeType: image.mimeType as string,
              data: image.data as string,
            };
          }
          return {
            type: 'text' as const,
            text: typeof item.text === 'string' ? item.text : JSON.stringify(item),
          };
        }),
      );
      return { content, ...(result.isError ? { isError: true } : {}) };
    }
    return {
      content: [{ type: 'text', text: JSON.stringify(result) }],
      ...(result?.error ? { isError: true } : {}),
    };
  } catch (error) {
    return {
      isError: true,
      content: [{ type: 'text', text: error instanceof Error ? error.message : '工具调用失败' }],
    };
  }
});
const transport = new StdioServerTransport();
const send = transport.send.bind(transport);
transport.send = async (message) => {
  await send(message);
  const id = 'id' in message ? message.id : undefined;
  if ((typeof id === 'string' || typeof id === 'number') && yielding.delete(id))
    await request('/native/yield', {});
};
await server.connect(transport);
