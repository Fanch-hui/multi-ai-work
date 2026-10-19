import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AntigravityCatalogCache } from '../src/providers/native/antigravity-cache.js';
import { verifyAntigravityTeamTools } from '../src/providers/native/antigravity-tools.js';
import { startHttp } from '../src/core/http.js';
import type { Run } from '../src/domain/types.js';
import type { RunContext } from '../src/domain/provider.js';
import { setup } from './core-harness.js';

describe('原生运行准备', () => {
  it('缓存真实模型目录，重复运行不重复启动 CLI，重新检测仍刷新', async () => {
    const root = await mkdtemp(join(tmpdir(), 'multi-ai-startup-'));
    try {
      const executable = join(root, 'catalog.mjs');
      await writeFile(
        executable,
        `import fs from 'node:fs'; fs.appendFileSync('calls.txt','call\\n'); console.log('actual-model-high\\tActual (High)');`,
      );
      const cache = new AntigravityCatalogCache(),
        signal = AbortSignal.timeout(10000);
      const first = await cache.read(executable, 1, root, signal);
      expect(await cache.read(executable, 1, root, signal)).toEqual(first);
      expect((await readFile(join(root, 'calls.txt'), 'utf8')).trim().split('\n')).toHaveLength(1);
      await cache.read(executable, 1, root, signal, true);
      await cache.read(executable, 2, root, signal);
      expect((await readFile(join(root, 'calls.txt'), 'utf8')).trim().split('\n')).toHaveLength(3);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('直接核对 Core 授权目录，拒绝超出当前成员权限与失效运行授权', async () => {
    const { core, bot } = await setup(async () => ({ text: '完成' }));
    core.scheduler.pause();
    const member = bot('测试成员', ['read_file']);
    const workspace = core.state.snapshot().workspaces[0];
    const room = core.entities.createConversation({
      name: '测试',
      kind: 'private',
      memberIds: [member.id],
      workspaceId: workspace.id,
    });
    const task = core.tasks.create({ conversationId: room.id, botId: member.id, goal: '读取资料' });
    const run = { id: 'run' } as Run;
    const toolContext = core.tools.context(
      run,
      task,
      member,
      room,
      workspace,
      AbortSignal.timeout(10000),
    );
    const channel = await startHttp(core, false);
    const token = 'ephemeral-test-authorization';
    core.executor.nativeContexts.set(token, { context: toolContext, bot: member, runId: run.id });
    const context = {
      tools: core.tools.definitions(toolContext, member),
      nativeMcp: {
        command: 'unused-command',
        args: [],
        env: { AI_TEAM_CORE_URL: channel.url, AI_TEAM_RUN_TOKEN: token },
      },
    } as unknown as RunContext;
    try {
      await verifyAntigravityTeamTools(context, toolContext.signal);
      context.tools.push({ name: 'delete_file', description: '', inputSchema: {} });
      await expect(verifyAntigravityTeamTools(context, toolContext.signal)).rejects.toThrow(
        '成员授权不匹配',
      );
      core.executor.nativeContexts.delete(token);
      await expect(verifyAntigravityTeamTools(context, toolContext.signal)).rejects.toThrow(
        '授权检查失败',
      );
    } finally {
      await channel.close();
    }
  });
});
