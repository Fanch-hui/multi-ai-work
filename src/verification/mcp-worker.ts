import { randomUUID } from 'node:crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { verificationTools } from './tool-channel.js';

const workspace = process.env.AI_TEAM_VERIFY_WORKSPACE;
if (!workspace) throw new Error('缺少独立验证工作目录');
const channel = verificationTools(workspace, new AbortController().signal);
const server = new Server({ name: 'ai-team', version: '0.1.0' }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: channel.tools.map(tool => ({ ...tool,
  inputSchema: { ...tool.inputSchema, type: 'object' as const } })) }));
server.setRequestHandler(CallToolRequestSchema, async input => {
  try {
    const result = await channel.execute(input.params.name, input.params.arguments ?? {}, randomUUID());
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  } catch { return { isError: true, content: [{ type: 'text', text: '工具未授权或读取失败' }] }; }
});
await server.connect(new StdioServerTransport());
