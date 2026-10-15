import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { RunContext } from '../../domain/provider.js';
import type { AntigravityUsage } from './antigravity-events.js';
import { accountDigest, requireProfile } from './runtime.js';

export function antigravityWorkspace(context: RunContext): string {
  return join(requireProfile(context.connection), 'agy-workspaces', accountDigest('binding', context.binding.id));
}

export async function prepareAntigravity(context: RunContext): Promise<string> {
  const cwd = antigravityWorkspace(context), agents = join(cwd, '.agents');
  await mkdir(join(agents, 'agents'), { recursive: true, mode: 0o700 });
  await writeFile(join(agents, 'mcp_config.json'), JSON.stringify({ mcpServers: {
    'ai-team': { command: context.nativeMcp.command, args: context.nativeMcp.args },
  } }), { mode: 0o600 });
  await writeFile(join(agents, 'agents', 'multi-ai-work.md'), [
    '---', 'name: multi-ai-work', 'description: multi-AI work team member',
    'mainAgent: true', 'subagent: false', '---', '', context.instructions, '',
    `当前 App 工作区：${context.workspacePath}`,
    '团队成员、会话、任务、记忆与成果由 ai-team MCP 工具管理。不要用原生文件或命令修改 App 数据库。',
  ].join('\n'), { mode: 0o600 });
  return cwd;
}

export async function previousAntigravityUsage(context: RunContext): Promise<AntigravityUsage | undefined> {
  if (!context.binding.nativeSessionId) return undefined;
  try {
    const saved = JSON.parse(await readFile(join(antigravityWorkspace(context), 'usage.json'), 'utf8'));
    return saved.sessionId === context.binding.nativeSessionId ? saved.usage : undefined;
  } catch { return undefined; }
}

export async function saveAntigravityUsage(context: RunContext, sessionId: string, usage?: AntigravityUsage): Promise<void> {
  await writeFile(join(antigravityWorkspace(context), 'usage.json'), JSON.stringify({ sessionId, usage }), { mode: 0o600 });
}

