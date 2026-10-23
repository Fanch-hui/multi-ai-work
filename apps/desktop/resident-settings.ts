import { app, powerSaveBlocker } from 'electron';
import { readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import type { ResidentSettings } from '../../src/domain/host-access.js';

const schema = z.object({ openAtLogin: z.boolean(), keepAwake: z.boolean() });
let settings = { openAtLogin: false, keepAwake: false };
let blocker: number | undefined;
let initialized: Promise<void> | undefined;
let writing = false;

export function initializeResidentSettings() {
  initialized ??= load();
  return initialized;
}
async function load() {
  try {
    settings = schema.parse(
      JSON.parse(await readFile(join(app.getPath('userData'), 'resident-settings.json'), 'utf8')),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  applyAwake(settings.keepAwake);
}
function applyAwake(enabled: boolean) {
  if (enabled && blocker === undefined) blocker = powerSaveBlocker.start('prevent-app-suspension');
  if (!enabled && blocker !== undefined) {
    powerSaveBlocker.stop(blocker);
    blocker = undefined;
  }
}
export async function handleResidentRequest(
  method: string,
  params: Record<string, unknown>,
): Promise<ResidentSettings> {
  await initializeResidentSettings();
  const supportsLogin = process.platform === 'darwin' || process.platform === 'win32';
  if (method === 'resident.set') {
    if (writing) throw new Error('常驻设置正在保存');
    const next = schema.parse(params);
    if (next.openAtLogin && !supportsLogin) throw new Error('当前系统需手动配置登录启动');
    writing = true;
    try {
      const previousLogin = supportsLogin ? app.getLoginItemSettings().openAtLogin : false;
      if (supportsLogin) app.setLoginItemSettings({ openAtLogin: next.openAtLogin });
      const path = join(app.getPath('userData'), 'resident-settings.json');
      try {
        await writeFile(`${path}.tmp`, JSON.stringify(next), { mode: 0o600 });
        await rename(`${path}.tmp`, path);
      } catch (error) {
        if (supportsLogin) app.setLoginItemSettings({ openAtLogin: previousLogin });
        throw error;
      }
      settings = next;
      applyAwake(next.keepAwake);
    } finally {
      writing = false;
    }
  } else if (method !== 'resident.get') throw new Error('不支持的常驻操作');
  return {
    available: true,
    ...settings,
    openAtLogin: supportsLogin ? app.getLoginItemSettings().openAtLogin : false,
  };
}
export function closeResidentSettings() {
  applyAwake(false);
}
