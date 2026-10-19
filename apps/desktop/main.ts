import { app, BrowserWindow, ipcMain, shell, Menu, Tray, nativeImage, dialog, net } from 'electron';
import { dirname, join, isAbsolute } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { CoreHost } from './core-host.js';
import type { Snapshot } from '../../src/domain/types.js';
import { AppUpdater } from './app-updater.js';
import { prepareUpdateInstaller } from './update-installer.js';
import { readDataDirectory } from './data-location.js';
import { DataDirectoryController } from './data-directory-controller.js';
import { copyDataDirectory } from './data-directory-process.js';

const directory = dirname(fileURLToPath(import.meta.url));
const pagePath = join(directory, '../../ui/index.html');
const core = new CoreHost();
let window: BrowserWindow;
let tray: Tray | undefined;
let exiting = false;
let trayEnabled = true;
let updater: AppUpdater | undefined;
let dataDirectory: DataDirectoryController | undefined;
let shutdown: Promise<void> | undefined;
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
  app.on('second-instance', () => {
    window?.show();
    window?.focus();
  });
  app
    .whenReady()
    .then(smoke ? smokeCore : start)
    .catch((error) => {
      if (smoke) {
        process.stderr.write(
          `Core 启动检查失败: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
        );
        app.exit(1);
      } else {
        dialog.showErrorBox('multi-AI work 无法启动', error.message);
        exiting = true;
        app.quit();
      }
    });
}
async function smokeCore() {
  await core.start();
  const snapshot = (await core.request('state.snapshot', {})) as Snapshot;
  const mainBot = snapshot.bots.find((bot) => bot.id === snapshot.settings.mainBotId);
  const mainRoom = snapshot.conversations.find(
    (room) => room.id === snapshot.settings.mainConversationId,
  );
  if (!mainBot || mainRoom?.chiefId !== mainBot.id) throw new Error('主智能体初始化失败');
  process.stdout.write(
    JSON.stringify({
      coreReady: !!snapshot.settings,
      workspaceCount: snapshot.workspaces.length,
      mainBotReady: true,
      credentialBackend: 'not_checked',
      uiInteraction: false,
    }) + '\n',
  );
  await core.close();
  app.exit(0);
}
async function start() {
  const currentDirectory = await readDataDirectory(app.getPath('userData'));
  createWindow();
  configureUpdater();
  configureDataDirectory(currentDirectory);
  configureWindowNavigation();
  registerRendererRequests();
  await startCoreAndShowWindow(currentDirectory);
  configureTrayAndWindowClose();
}
function createWindow() {
  window = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 640,
    title: 'multi-AI work',
    backgroundColor: '#ffffff',
    show: false,
    ...(process.platform === 'darwin'
      ? { titleBarStyle: 'hiddenInset' as const, trafficLightPosition: { x: 18, y: 18 } }
      : {}),
    webPreferences: {
      preload: join(directory, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
}
function configureUpdater() {
  updater = new AppUpdater({
    version: app.getVersion(),
    enabled:
      app.isPackaged &&
      ((process.platform === 'darwin' && process.arch === 'arm64') ||
        (process.platform === 'win32' && process.arch === 'x64')),
    platform: process.platform === 'win32' ? 'windows' : 'macos',
    architecture: process.arch === 'x64' ? 'x64' : 'arm64',
    cacheDirectory: join(app.getPath('userData'), 'app-updates'),
    fetcher: (input, init) => net.fetch(new Request(input, init)),
    acquire: () => core.request('system.prepareUpdate', {}),
    release: () => core.request('system.releaseUpdate', {}),
    prepareInstallation: (packagePath, version) =>
      prepareUpdateInstaller({
        packagePath,
        version,
        cacheDirectory: join(app.getPath('userData'), 'app-updates'),
        parentPid: process.pid,
        executablePath: app.getPath('exe'),
        platform: process.platform as 'darwin' | 'win32',
        architecture: process.arch as 'arm64' | 'x64',
        bundleId: 'local.multi-ai-work.desktop',
      }),
    quit: () => {
      exiting = true;
      app.quit();
    },
    changed: (state) => {
      if (!window.isDestroyed()) window.webContents.send('team:update', state);
    },
  });
}
function configureDataDirectory(currentDirectory: string) {
  dataDirectory = new DataDirectoryController({
    defaultDirectory: app.getPath('userData'),
    currentDirectory,
    core,
    startCore: () => core.start(window, currentDirectory),
    copy: copyDataDirectory,
    restart: () => {
      setImmediate(() => {
        app.relaunch();
        exiting = true;
        app.quit();
      });
    },
    changed: () => {
      if (!window.isDestroyed()) window.webContents.send('team:changed');
    },
  });
}
function configureWindowNavigation() {
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (allowedExternal(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  window.webContents.on('will-navigate', (event, url) => {
    if (url !== pathToFileURL(pagePath).href) {
      event.preventDefault();
      if (allowedExternal(url)) void shell.openExternal(url);
    }
  });
}
function registerRendererRequests() {
  ipcMain.handle('team:request', async (event, method: unknown, params: unknown) => {
    if (
      event.sender !== window.webContents ||
      event.senderFrame !== window.webContents.mainFrame ||
      event.senderFrame.url !== pathToFileURL(pagePath).href
    )
      throw new Error('调用来源未授权');
    if (
      typeof method !== 'string' ||
      !params ||
      typeof params !== 'object' ||
      Array.isArray(params)
    )
      throw new Error('请求参数无效');
    if (exiting) throw new Error('应用正在退出，请稍后操作');
    if (dataDirectory!.busy) throw new Error('正在更改数据目录，请稍候');
    if (method === 'app.dataDirectory.change') {
      if (updater!.snapshot().phase === 'installing')
        throw new Error('正在安装更新，请稍后更改数据目录');
      return dataDirectory!.change((params as { path: string }).path);
    }
    if (method.startsWith('app.update.')) return updater!.request(method);
    const result = await core.request(method, params as Record<string, unknown>);
    if (
      method === 'connections.login' &&
      result &&
      typeof result === 'object' &&
      'url' in result &&
      typeof result.url === 'string' &&
      allowedExternal(result.url)
    )
      await shell.openExternal(result.url);
    if (method === 'settings.save') {
      const snapshot = (await core.request('state.snapshot', {})) as Snapshot;
      trayEnabled = snapshot.settings.trayEnabled;
    }
    return result;
  });
}
async function startCoreAndShowWindow(currentDirectory: string) {
  core.onChange = () => {
    if (!window.isDestroyed() && !dataDirectory?.busy) window.webContents.send('team:changed');
  };
  await core.start(window, currentDirectory);
  const snapshot = (await core.request('state.snapshot', {})) as Snapshot;
  trayEnabled = snapshot.settings.trayEnabled;
  await window.loadFile(pagePath);
  window.show();
  void updater!.start();
}
function configureTrayAndWindowClose() {
  const icon = nativeImage.createFromPath(
    join(
      app.getAppPath(),
      'resources',
      process.platform === 'darwin' ? 'trayTemplate.png' : 'tray.png',
    ),
  );
  if (process.platform === 'darwin') icon.setTemplateImage(true);
  tray = new Tray(icon);
  tray.setToolTip('multi-AI work');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: '打开 multi-AI work', click: () => window.show() },
      { type: 'separator' },
      {
        label: '退出',
        click: () => {
          exiting = true;
          app.quit();
        },
      },
    ]),
  );
  tray.on('click', () => window.show());
  window.on('close', (event) => {
    if (!exiting && trayEnabled) {
      event.preventDefault();
      window.hide();
    }
  });
}

function allowedExternal(url: string) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' && !parsed.username && !parsed.password;
  } catch {
    return false;
  }
}
app.on('activate', () => window?.show());
app.on('window-all-closed', () => {
  if (!trayEnabled) app.quit();
});
app.on('before-quit', (event) => {
  event.preventDefault();
  exiting = true;
  shutdown ??= shutdownDesktop();
});

async function shutdownDesktop() {
  try {
    await dataDirectory?.settle();
    await updater?.close();
    await core.close();
  } finally {
    tray?.destroy();
    app.exit(0);
  }
}
