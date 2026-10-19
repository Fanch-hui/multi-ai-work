import { afterEach, describe, expect, it, vi } from 'vitest';
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CoreService } from '../src/core/service.js';
import type { Connection } from '../src/domain/types.js';
import { AuthenticationRequiredError, type ProviderAdapter } from '../src/domain/provider.js';
import { caps, resources } from './core-harness.js';

afterEach(() => vi.unstubAllEnvs());

async function setupNative(
  probe: ProviderAdapter['probe'] = async () => ({ models: [], capabilities: caps }),
) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'multi-ai-native-connection-')));
  const core = new CoreService(root, undefined, undefined, [
    { kind: 'antigravity', probe, run: async () => ({ text: '' }) },
  ]);
  resources.push({ core, root });
  await core.start();
  return { core, root };
}

describe('原生连接的运行时配置', () => {
  it.each([
    { error: new AuthenticationRequiredError('agy 未配置可用认证'), status: 'needs_auth' },
    { error: new Error('agy 认证服务连接失败'), status: 'error' },
  ])('将检测异常保存为 $status 并保留运行时选择', async ({ error, status }) => {
    const { core, root } = await setupNative(async () => {
      throw error;
    });
    const executable = join(root, 'chosen.mjs');
    await writeFile(executable, '');
    const connection = await core.entities.saveConnection({
      name: 'agy',
      provider: 'antigravity',
      executable,
    });
    await expect(core.request('connections.probe', { id: connection.id })).rejects.toThrow(
      error.message,
    );
    expect(core.state.storage.get<Connection>('connections', connection.id)).toMatchObject({
      executable,
      status,
      error: error.message,
    });
  });

  it('自动检测在 CLI 更新入口后重新解析文件，保留模式并使旧会话绑定失效', async () => {
    const { core, root } = await setupNative();
    const bin = join(root, 'bin');
    const launcher = join(bin, process.platform === 'win32' ? 'agy.exe' : 'agy');
    await mkdir(bin);
    const first = join(root, 'first-agy');
    const updated = join(root, 'updated-agy');
    await writeFile(first, '');
    await chmod(first, 0o755);
    await symlink(first, launcher);
    vi.stubEnv('PATH', bin);
    const connection = await core.entities.saveConnection({ name: 'agy', provider: 'antigravity' });
    expect(connection).toMatchObject({ executable: first, executableMode: 'auto' });
    const saved = await core.entities.saveConnection(connection);
    expect(saved.executableMode).toBe('auto');
    await writeFile(updated, '');
    await chmod(updated, 0o755);
    await rm(launcher);
    await symlink(updated, launcher);
    await rm(first);
    const probed = await core.request('connections.probe', { id: connection.id });
    expect(probed).toMatchObject({
      executable: updated,
      executableMode: 'auto',
      status: 'ready',
      revision: saved.revision + 1,
    });
    expect(core.state.storage.get<Connection>('connections', connection.id)?.executable).toBe(
      updated,
    );
  });

  it('显式路径失效时登录保留选择并给出路径错误', async () => {
    const { core, root } = await setupNative();
    const executable = join(root, 'chosen.mjs');
    await writeFile(executable, '');
    const connection = await core.entities.saveConnection({
      name: 'agy',
      provider: 'antigravity',
      executable,
    });
    expect(connection.executableMode).toBe('explicit');
    await rm(executable);
    await expect(core.request('connections.login', { id: connection.id })).rejects.toThrow(
      '显式运行时路径不存在',
    );
    expect(core.state.storage.get<Connection>('connections', connection.id)).toMatchObject({
      executable,
      executableMode: 'explicit',
      status: 'error',
      error: '显式运行时路径不存在或不可执行，请修正路径',
    });
  });
});
