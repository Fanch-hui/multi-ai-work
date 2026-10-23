import { buildComputerHelper } from './computer-helper.mjs';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildMacIcon } from './mac-icon.mjs';
import { assertInstalledDependencies } from './package-dependencies.mjs';

const require = createRequire(import.meta.url);
const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
await assertInstalledDependencies(project);
const sdk = dirname(dirname(require.resolve('@qodercn-ai/qodercn-agent-sdk')));
const cli = join(
  sdk,
  'dist',
  '_bundled',
  process.platform === 'win32' ? 'qoderclicn.exe' : 'qoderclicn',
);
const desktop = process.argv.includes('--desktop');
const resolvePlatform = () => {
  if (process.argv.includes('--win')) {
    return '--win';
  }
  if (process.argv.includes('--mac')) {
    return '--mac';
  }
  if (process.platform === 'darwin') {
    return '--mac';
  }
  if (process.platform === 'win32') {
    return '--win';
  }
  return '--linux';
};
const platform = resolvePlatform();
if (!existsSync(cli))
  await run(process.execPath, [join(sdk, 'scripts', 'postinstall.cjs')], {
    QODER_INSTALL_BUNDLED_CLI: '1',
  });
if (platform === '--mac' && process.platform === 'darwin') await buildMacIcon(project);
const resolveRuntimeTarget = () => {
  if (platform === '--mac' && process.arch === 'arm64') {
    return 'mac-arm64';
  }
  if (platform === '--win' && process.arch === 'x64') {
    return 'win-x64';
  }
  return undefined;
};
const runtimeTarget = resolveRuntimeTarget();
if (!runtimeTarget) throw new Error('随包 Office 运行环境目前支持 macOS arm64 和 Windows x64');
await run(process.execPath, [
  join(project, 'scripts/workspace-runtime/prepare.mjs'),
  '--target',
  runtimeTarget,
  ...(runtimeTarget === 'win-x64' && process.env.MULTI_AI_OFFICE_CRT
    ? ['--crt-dir', process.env.MULTI_AI_OFFICE_CRT]
    : []),
]);
const computerHelper = platform === '--mac' ? await buildComputerHelper(project) : undefined;
const builder = require.resolve('electron-builder/cli.js');
const metadata = JSON.parse(await readFile(join(project, 'package.json'), 'utf8'));
const configDirectory = join(project, '.data');
await mkdir(configDirectory, { recursive: true });
const configPath = join(configDirectory, `package-${runtimeTarget}.json`);
const marketConfigPath = join(configDirectory, `market-${runtimeTarget}.json`);
const defaultMarketConfig = require('../resources/market-config.json');
const catalogUrl = process.env.MULTI_AI_MARKET_CATALOG_URL || defaultMarketConfig.catalogUrl;
if (catalogUrl) {
  const url = new URL(catalogUrl);
  if (url.protocol !== 'https:' || url.username || url.password || url.hash)
    throw new Error('官方市场目录必须使用不含凭据的 HTTPS 地址');
}
await writeFile(marketConfigPath, JSON.stringify({ catalogUrl }));
await writeFile(
  configPath,
  JSON.stringify({
    ...metadata.build,
    mac: {
      ...metadata.build.mac,
      entitlements: join(project, 'resources/entitlements.mac.plist'),
      entitlementsInherit: join(project, 'resources/entitlements.mac.plist'),
      extendInfo: {
        ...metadata.build.mac?.extendInfo,
        NSMicrophoneUsageDescription: '用于语音输入和与团队成员进行语音对话。',
        NSScreenCaptureUsageDescription: '用于观察你授权给智能体操作的应用窗口。',
      },
    },
    afterPack: join(project, 'scripts/package-dependencies.mjs'),
    extraResources: [
      ...(metadata.build.extraResources ?? []),
      ...(computerHelper ? [{ from: computerHelper, to: 'computer-helper' }] : []),
      { from: marketConfigPath, to: 'market-config.json' },
      { from: join(project, 'workspace-runtime', runtimeTarget), to: 'workspace-runtime' },
      {
        from: join(project, 'workspace-runtime', runtimeTarget, 'node_modules'),
        to: 'workspace-runtime/node_modules',
      },
    ],
  }),
);
try {
  await run(process.execPath, [
    builder,
    platform,
    ...(desktop || process.argv.includes('--dir') ? ['dir'] : []),
    '--publish',
    'never',
    '--config',
    configPath,
  ]);
} finally {
  await Promise.all([configPath, marketConfigPath].map((path) => rm(path, { force: true })));
}
if (desktop) {
  const root = join(project, 'release');
  const resolvePath = () => {
    if (process.platform === 'darwin') {
      return join(root, process.arch === 'arm64' ? 'mac-arm64' : 'mac', 'multi-AI work.app');
    }
    if (process.platform === 'win32') {
      return join(root, 'win-unpacked', 'multi-AI work.exe');
    }
    return join(root, 'linux-unpacked', 'multi-AI work');
  };
  const path = resolvePath();
  await run(
    process.platform === 'darwin' ? 'open' : path,
    process.platform === 'darwin' ? [path] : [],
  );
}
function run(command, args, extraEnv = {}) {
  return new Promise((accept, reject) => {
    const child = spawn(command, args, {
      cwd: project,
      env: { ...process.env, ...extraEnv },
      stdio: 'inherit',
      windowsHide: true,
    });
    child.once('error', reject);
    child.once('exit', (code) =>
      code === 0 ? accept() : reject(new Error(`构建步骤失败：${code}`)),
    );
  });
}
