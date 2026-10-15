import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { RunContext } from '../../domain/provider.js';
import { antigravityEnvironment } from './antigravity-catalog.js';
import { bounded } from './runtime.js';

export async function verifyAntigravityTeamTools(context: RunContext, signal: AbortSignal): Promise<void> {
  const coreUrl = context.nativeMcp.env.AI_TEAM_CORE_URL, token = context.nativeMcp.env.AI_TEAM_RUN_TOKEN;
  if (coreUrl && token) {
    const url = new URL(coreUrl);
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password || url.search || url.hash)
      throw new Error('App 团队工具地址无效');
    const response = await fetch(new URL('/native/tools', url), { headers: { Authorization: `Bearer ${token}` }, signal, redirect: 'error' });
    if (!response.ok) throw new Error('App 团队工具授权检查失败');
    const catalog = await response.json() as { name: string }[];
    validateCatalog(catalog, context);
    return;
  }
  const env = Object.fromEntries(Object.entries({ ...antigravityEnvironment(), ...context.nativeMcp.env })
    .filter((entry): entry is [string, string] => entry[1] !== undefined));
  const transport = new StdioClientTransport({ command: context.nativeMcp.command,
    args: context.nativeMcp.args, env, stderr: 'ignore' });
  const client = new Client({ name: 'multi-ai-work', version: '1.0.0' });
  try {
    await bounded(client.connect(transport), signal);
    const catalog = await bounded(client.listTools(), signal);
    validateCatalog(catalog.tools, context);
  } finally { await client.close(); }
}

function validateCatalog(catalog: { name: string }[], context: RunContext) {
  const allowed = new Set(context.tools.map(tool => tool.name));
  if (!Array.isArray(catalog) || catalog.length !== allowed.size || catalog.some(tool => !allowed.has(tool.name)))
    throw new Error('App 团队工具目录与当前成员授权不匹配');
}
