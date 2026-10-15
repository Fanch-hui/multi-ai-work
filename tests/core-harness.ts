import { afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ProviderAdapter, RunContext } from '../src/domain/provider.js';
import { CoreService, type HostRequest } from '../src/core/service.js';

export const resources: { core: CoreService; root: string }[] = [];
afterEach(async () => {
  for (const resource of resources.splice(0)) {
    await resource.core.close(); await rm(resource.root, { recursive: true, force: true });
  }
});
export const caps = { runtimeKind: 'managed-model' as const, contextOwner: 'app' as const, tools: 'supported' as const,
  resume: 'supported' as const, imageInput: 'unsupported' as const, compaction: 'supported' as const,
  contextUsage: 'unverified' as const, permissionEnforcement: 'gateway' as const };
export async function setup(run: (context: RunContext) => Promise<{ text: string }>, host?: HostRequest) {
  const root = await mkdtemp(join(tmpdir(), 'ai-team-core-'));
  const adapter: ProviderAdapter = { kind: 'custom', probe: async () => ({ models: [], capabilities: caps }), run };
  const core = new CoreService(root, undefined, host, [adapter]);
  resources.push({ core, root }); await core.start();
  const connection = await core.entities.saveConnection({ name: '本地测试', provider: 'custom', baseUrl: 'http://127.0.0.1:7777', model: 'test', concurrency: 1 });
  core.state.storage.put('connections', { ...connection, status: 'ready', capabilities: caps });
  const bot = (name: string, tools: string[] = []) => core.entities.saveBot({
    ...(name === 'Chief' ? { id: core.state.settings().mainBotId } : {}),
    name, role: name, instructions: '', connectionId: connection.id, model: 'test', toolNames: tools, approvalMode: 'ask' });
  return { core, root, bot, connection };
}
export async function eventually(condition: () => boolean, timeout = 3000) {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeout) throw new Error('状态未按预期推进');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}
