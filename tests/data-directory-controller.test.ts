import { afterEach, expect, it } from 'vitest';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CoreService } from '../src/core/service.js';
import { DataDirectoryController } from '../apps/desktop/data-directory-controller.js';
import { readDataDirectory } from '../apps/desktop/data-location.js';
import { migrateDataDirectory } from '../src/core/data-directory.js';
import type { Snapshot } from '../src/domain/types.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function setup(copy = migrateDataDirectory) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'maw-data-controller-')));
  const source = join(root, 'source'),
    target = join(root, 'target');
  let core = new CoreService(source),
    running = true,
    restarted = false;
  cleanups.push(async () => {
    if (running) await core.close();
    await rm(root, { recursive: true, force: true });
  });
  await core.start();
  const roomId = core.state.settings().mainConversationId!;
  const original = core.state.storage.appendMessage({
    id: 'saved-message',
    conversationId: roomId,
    authorType: 'user',
    content: '保留这条聊天',
    artifactIds: [],
    status: 'committed',
    createdAt: new Date().toISOString(),
  });
  const controller = new DataDirectoryController({
    defaultDirectory: source,
    currentDirectory: source,
    core: {
      get running() {
        return running;
      },
      request: (method, params) => core.request(method, params),
      close: async () => {
        await core.close();
        running = false;
      },
    },
    startCore: async () => {
      core = new CoreService(source);
      await core.start();
      running = true;
    },
    copy,
    restart: () => {
      restarted = true;
    },
    changed: () => {},
  });
  return { source, target, controller, original, core: () => core, restarted: () => restarted };
}

it('关闭数据服务、完成复制并保存位置后，才允许重启', async () => {
  const fixture = await setup();
  expect(await fixture.controller.change(fixture.target)).toEqual({
    path: fixture.target,
    restarting: true,
  });
  expect(fixture.restarted()).toBe(true);
  expect(await readDataDirectory(fixture.source)).toBe(fixture.target);
  const reopened = new CoreService(fixture.target);
  try {
    await reopened.start();
    const snapshot = (await reopened.request('state.snapshot')) as Snapshot;
    expect(snapshot.dataDirectory).toBe(fixture.target);
    expect(reopened.state.storage.getMessage('saved-message')).toEqual(fixture.original);
  } finally {
    await reopened.close();
  }
});

it('复制失败时继续使用原目录，聊天可读且可继续保存设置', async () => {
  const fixture = await setup(async () => {
    throw new Error('目标磁盘写入失败');
  });
  await expect(fixture.controller.change(fixture.target)).rejects.toThrow('写入失败');
  expect(fixture.controller.busy).toBe(false);
  expect(fixture.restarted()).toBe(false);
  expect(await readDataDirectory(fixture.source)).toBe(fixture.source);
  expect(fixture.core().state.storage.getMessage('saved-message')).toEqual(fixture.original);
  await fixture.core().request('settings.save', { input: { trayEnabled: false } });
  expect(fixture.core().state.settings().trayEnabled).toBe(false);
});
