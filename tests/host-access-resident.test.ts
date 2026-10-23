import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const electron = vi.hoisted(() => ({
  userData: '',
  openAtLogin: false,
  start: vi.fn(() => 7),
  stop: vi.fn(),
  setLogin: vi.fn((value: { openAtLogin: boolean }) => {
    electron.openAtLogin = value.openAtLogin;
  }),
}));
vi.mock('electron', () => ({
  app: {
    getPath: () => electron.userData,
    getLoginItemSettings: () => ({ openAtLogin: electron.openAtLogin }),
    setLoginItemSettings: electron.setLogin,
  },
  powerSaveBlocker: { start: electron.start, stop: electron.stop },
}));
afterEach(async () => {
  const { closeResidentSettings } = await import('../apps/desktop/resident-settings.js');
  closeResidentSettings();
  if (electron.userData) await rm(electron.userData, { recursive: true, force: true });
  electron.userData = '';
  electron.openAtLogin = false;
  vi.clearAllMocks();
  vi.resetModules();
});
describe('桌面常驻设置', () => {
  it('使用真实宿主入口持久保存，保持唤醒只注册一次，退出释放系统资源', async () => {
    electron.userData = await mkdtemp(join(tmpdir(), 'resident-settings-'));
    const { handleResidentRequest, closeResidentSettings } = await import(
      '../apps/desktop/resident-settings.js'
    );
    expect(await handleResidentRequest('resident.get', {})).toMatchObject({
      available: true,
      keepAwake: false,
    });
    await handleResidentRequest('resident.set', { openAtLogin: false, keepAwake: true });
    await handleResidentRequest('resident.set', { openAtLogin: false, keepAwake: true });
    expect(electron.start).toHaveBeenCalledExactlyOnceWith('prevent-app-suspension');
    expect(
      JSON.parse(await readFile(join(electron.userData, 'resident-settings.json'), 'utf8')),
    ).toEqual({ openAtLogin: false, keepAwake: true });
    closeResidentSettings();
    closeResidentSettings();
    expect(electron.stop).toHaveBeenCalledExactlyOnceWith(7);
  });
  it('重启恢复保持唤醒选择，关闭选择停止保持唤醒', async () => {
    electron.userData = await mkdtemp(join(tmpdir(), 'resident-settings-'));
    await writeFile(
      join(electron.userData, 'resident-settings.json'),
      JSON.stringify({ openAtLogin: false, keepAwake: true }),
    );
    const { initializeResidentSettings, handleResidentRequest } = await import(
      '../apps/desktop/resident-settings.js'
    );
    await initializeResidentSettings();
    await handleResidentRequest('resident.set', { openAtLogin: false, keepAwake: false });
    expect(electron.start).toHaveBeenCalledTimes(1);
    expect(electron.stop).toHaveBeenCalledWith(7);
  });
});
