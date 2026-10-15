import { app, BrowserWindow, ipcMain, shell, Menu, Tray, nativeImage, dialog } from 'electron';
import { dirname, join, isAbsolute } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { CoreHost } from './core-host.js';
import type { Snapshot } from '../../src/domain/types.js';

const directory = dirname(fileURLToPath(import.meta.url));
const pagePath = join(directory, '../../ui/index.html');
const core = new CoreHost();
let window: BrowserWindow;
let tray: Tray | undefined;
let exiting = false;
let trayEnabled = true;
const smoke = process.argv.includes('--smoke-core');
app.setName('multi-AI work');
if (smoke) {
  const path = process.env.AI_TEAM_SMOKE_DATA_DIR;
  if (!path || !isAbsolute(path)) throw new Error('Core 检查需要专用临时数据目录');
  app.setPath('userData', path);
}
const hasLock = smoke || app.requestSingleInstanceLock();
if (!hasLock) app.quit();
else {
  app.on('second-instance', () => { window?.show(); window?.focus(); });
  app.whenReady().then(smoke ? smokeCore : start).catch(error => {
    if (smoke) { process.stderr.write('Core 启动检查失败\n'); app.exit(1); }
    else { dialog.showErrorBox('multi-AI work 无法启动', error.message); exiting = true; app.quit(); }
  });
}
async function smokeCore() {
  await core.start();
  const snapshot = await core.request('state.snapshot', {}) as Snapshot;
  const mainBot = snapshot.bots.find(bot => bot.id === snapshot.settings.mainBotId);
  const mainRoom = snapshot.conversations.find(room => room.id === snapshot.settings.mainConversationId);
  if (!mainBot || mainRoom?.chiefId !== mainBot.id) throw new Error('主智能体初始化失败');
  process.stdout.write(JSON.stringify({ coreReady: !!snapshot.settings, workspaceCount: snapshot.workspaces.length,
    mainBotReady: true, credentialBackend: 'not_checked', uiInteraction: false }) + '\n');
  await core.close(); app.exit(0);
}
async function start() {
  window = new BrowserWindow({ width: 1400, height: 900, minWidth: 900, minHeight: 640,
    title: 'multi-AI work', backgroundColor: '#ffffff', show: false,
    ...(process.platform === 'darwin' ? { titleBarStyle: 'hiddenInset' as const, trafficLightPosition: { x: 18, y: 18 } } : {}),
    webPreferences: { preload: join(directory, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true } });
  window.webContents.setWindowOpenHandler(({ url }) => { if (allowedExternal(url)) void shell.openExternal(url); return { action: 'deny' }; });
  window.webContents.on('will-navigate', (event, url) => { if (url !== pathToFileURL(pagePath).href) { event.preventDefault(); if (allowedExternal(url)) void shell.openExternal(url); } });
  ipcMain.handle('team:request', async (event, method: unknown, params: unknown) => {
    if (event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame || event.senderFrame.url !== pathToFileURL(pagePath).href) throw new Error('调用来源未授权');
    if (typeof method !== 'string' || !params || typeof params !== 'object' || Array.isArray(params)) throw new Error('请求参数无效');
    const result = await core.request(method, params as Record<string, unknown>);
    if (method === 'connections.login' && result && typeof result === 'object' && 'url' in result && typeof result.url === 'string' && allowedExternal(result.url)) await shell.openExternal(result.url);
    if (method === 'settings.save') { const snapshot = await core.request('state.snapshot', {}) as Snapshot; trayEnabled = snapshot.settings.trayEnabled; }
    return result;
  });
  core.onChange = () => { if (!window.isDestroyed()) window.webContents.send('team:changed'); };
  await core.start(window);
  const snapshot = await core.request('state.snapshot', {}) as Snapshot; trayEnabled = snapshot.settings.trayEnabled;
  await window.loadFile(pagePath); window.show();
  const pixels = Buffer.alloc(16 * 16 * 4);
  for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
    if ((x >= 2 && x <= 6 && y >= 3 && y <= 7) || (x >= 9 && x <= 13 && y >= 3 && y <= 7) || (x >= 4 && x <= 11 && y >= 10 && y <= 13)) pixels[(y * 16 + x) * 4 + 3] = 255;
  }
  const icon = nativeImage.createFromBitmap(pixels, { width: 16, height: 16 }); icon.setTemplateImage(true);
  tray = new Tray(icon); tray.setToolTip('multi-AI work');
  tray.setContextMenu(Menu.buildFromTemplate([{ label: '打开 multi-AI work', click: () => window.show() }, { type: 'separator' }, { label: '退出', click: () => { exiting = true; app.quit(); } }]));
  tray.on('click', () => window.show());
  window.on('close', event => { if (!exiting && trayEnabled) { event.preventDefault(); window.hide(); } });
}
function allowedExternal(url: string) { try { const parsed = new URL(url); return parsed.protocol === 'https:' && !parsed.username && !parsed.password; } catch { return false; } }
app.on('activate', () => window?.show());
app.on('window-all-closed', () => { if (!trayEnabled) app.quit(); });
app.on('before-quit', event => {
  if (exiting && !core) return;
  event.preventDefault(); exiting = true;
  void core.close().finally(() => { tray?.destroy(); app.exit(0); });
});
