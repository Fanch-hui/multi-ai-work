import { handleResidentRequest } from './resident-settings.js';
import {
  dialog,
  shell,
  safeStorage,
  nativeImage,
  type BrowserWindow,
  type OpenDialogOptions,
} from 'electron';
import { stat } from 'node:fs/promises';
import { notifyWork } from './work-notifications.js';

function fileSelectionProperties(
  method: string,
  multiple: unknown,
): OpenDialogOptions['properties'] {
  if (method === 'chooseDirectory') return ['openDirectory', 'createDirectory'];
  if (multiple) return ['openFile', 'multiSelections'];
  return ['openFile'];
}

export async function handleCorePlatformRequest(
  method: string,
  params: Record<string, unknown>,
  window?: BrowserWindow,
) {
  if (method === 'resident.get' || method === 'resident.set')
    return handleResidentRequest(method, params);
  if (method === 'system.openExternal') {
    const url = new URL(String(params.url));
    if (url.protocol !== 'https:' || url.username || url.password)
      throw new Error('登录页面必须是 HTTPS 地址');
    await shell.openExternal(url.href);
    return { opened: true };
  }
  if (method === 'system.notify') return notifyWork(window, params);
  if (method === 'encrypt' || method === 'decrypt') {
    if (
      !safeStorage.isEncryptionAvailable() ||
      (process.platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text')
    )
      throw new Error('系统凭据保护不可用，请配置安全后端');
    return method === 'encrypt'
      ? safeStorage.encryptString(String(params.value)).toString('base64')
      : safeStorage.decryptString(Buffer.from(String(params.value), 'base64'));
  }
  if (method === 'chooseDirectory' || method === 'chooseFile') {
    if (!window) throw new Error('目录选择需要桌面窗口');
    const result = await dialog.showOpenDialog(window, {
      properties: fileSelectionProperties(method, params.multiple),
    });
    return {
      path: result.canceled ? undefined : result.filePaths[0],
      paths: result.canceled ? [] : result.filePaths,
    };
  }
  if (method === 'chooseAvatar') {
    if (!window) throw new Error('选择头像需要桌面窗口');
    const result = await dialog.showOpenDialog(window, {
      properties: ['openFile'],
      filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp'] }],
    });
    if (result.canceled) return { cancelled: true };
    const path = result.filePaths[0];
    if ((await stat(path)).size > 12 * 1024 * 1024) throw new Error('请选择小于 12 MB 的图片');
    const image = nativeImage.createFromPath(path);
    if (image.isEmpty()) throw new Error('图片无法读取，请选择 PNG、JPEG 或 WebP');
    const size = image.getSize();
    const avatar = image
      .resize(size.width > size.height ? { width: 192 } : { height: 192 })
      .toDataURL();
    if (avatar.length > 260000) throw new Error('头像图片过大，请换一张图片');
    return { avatar };
  }
  if (method === 'openPath') {
    const error = await shell.openPath(String(params.path));
    if (error) throw new Error(error);
    return { ok: true };
  }
  throw new Error('不支持的平台操作');
}
