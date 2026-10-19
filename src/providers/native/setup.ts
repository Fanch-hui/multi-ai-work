import { createRequire } from 'node:module';
import { basename, dirname, delimiter, isAbsolute, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { commonBinDirectories, executableFile } from './discovery.js';

export interface NativeSetup {
  executable?: string;
  source?: 'explicit' | 'path' | 'app';
  compatibility: 'unverified';
  installCommand: string;
  loginCommand?: string;
}
export interface SetupOptions {
  provider: 'antigravity' | 'qoder';
  profilePath: string;
  appRuntimeDirectory: string;
  executable?: string;
  path?: string;
  platform?: NodeJS.Platform;
  bundledQoderPath?: string;
  homeDirectory?: string;
  commonBinDirectories?: string[];
}
const quote = (value: string, windows: boolean) =>
  windows ? `'${value.replaceAll("'", "''")}'` : `'${value.replaceAll("'", "'\\''")}'`;

function bundledQoder(): string | undefined {
  try {
    const entry = createRequire(import.meta.url).resolve('@qodercn-ai/qodercn-agent-sdk');
    return join(
      dirname(entry),
      '_bundled',
      process.platform === 'win32' ? 'qoderclicn.exe' : 'qoderclicn',
    );
  } catch {
    return undefined;
  }
}

/** File discovery establishes installation only; the adapter validates protocol and authorization. */
export async function detectNativeSetup(options: SetupOptions): Promise<NativeSetup> {
  if (!isAbsolute(options.profilePath) || !isAbsolute(options.appRuntimeDirectory))
    throw new Error('App 目录必须是绝对路径');
  if ([homedir(), join(homedir(), '.qoder')].includes(resolve(options.profilePath)))
    throw new Error('请使用 App 专用配置目录');
  if (options.executable && !isAbsolute(options.executable))
    throw new Error('显式运行时路径必须是绝对路径');
  const platform = options.platform ?? process.platform;
  const windows = platform === 'win32';
  let selected: Pick<NativeSetup, 'executable' | 'source'> | undefined;
  for (const candidate of runtimeCandidates(options, platform)) {
    const executable = await executableFile(candidate.path, windows);
    if (!executable) continue;
    if (
      options.provider === 'antigravity' &&
      /^agy_acp_server(?:\.|$)/i.test(basename(executable))
    ) {
      if (options.executable) throw new Error('请选择 agy CLI 可执行文件');
      continue;
    }
    selected = { executable, source: candidate.source };
    break;
  }
  if (options.executable && !selected)
    throw new Error('显式运行时路径不存在或不可执行，请修正路径');
  return {
    ...selected,
    compatibility: 'unverified',
    installCommand: installationCommand(options, windows),
    loginCommand: selected?.executable
      ? loginCommand(options, selected.executable, windows)
      : undefined,
  };
}

function installationCommand(options: SetupOptions, windows: boolean): string {
  if (options.provider === 'antigravity')
    return windows
      ? 'irm https://antigravity.google/cli/install.ps1 | iex'
      : 'curl -fsSL https://antigravity.google/cli/install.sh | bash';
  const prefix = quote(join(options.appRuntimeDirectory, 'qoder'), windows);
  return `${windows ? "$env:QODER_INSTALL_BUNDLED_CLI='1'; " : 'QODER_INSTALL_BUNDLED_CLI=1 '}npm install --prefix ${prefix} @qodercn-ai/qodercn-agent-sdk`;
}

function loginCommand(options: SetupOptions, executable: string, windows: boolean): string {
  const invocation = /\.(js|mjs|cjs)$/i.test(executable)
    ? `${quote(process.execPath, windows)} ${quote(executable, windows)}`
    : quote(executable, windows);
  if (options.provider === 'antigravity') return `${windows ? '& ' : ''}${invocation}`;
  return `${windows ? "$env:ELECTRON_RUN_AS_NODE='1'; & " : 'ELECTRON_RUN_AS_NODE=1 '}${invocation} login`;
}

function runtimeCandidates(options: SetupOptions, platform: NodeJS.Platform) {
  if (options.executable) return [{ path: options.executable, source: 'explicit' as const }];
  const windows = platform === 'win32';
  const name = `${options.provider === 'antigravity' ? 'agy' : 'qoderclicn'}${windows ? '.exe' : ''}`;
  const names = options.provider === 'qoder' ? [name, `qodercn${windows ? '.exe' : ''}`] : [name];
  const home = options.homeDirectory ?? homedir();
  const pathFolders = (options.path ?? process.env.PATH ?? '')
    .split(windows ? ';' : delimiter)
    .filter(isAbsolute);
  const commonFolders = options.commonBinDirectories ?? [
    ...commonBinDirectories(home, platform),
    ...(options.provider === 'qoder'
      ? [join(home, '.qoder-cn', 'local'), join(home, '.qoder-cn', 'local', 'bin')]
      : []),
  ];
  const paths = [...new Set([...pathFolders, ...commonFolders])].flatMap((folder) =>
    names.map((name) => join(folder, name)),
  );
  const appPaths =
    options.provider === 'antigravity'
      ? [
          join(options.appRuntimeDirectory, 'antigravity', 'bin', name),
          join(options.appRuntimeDirectory, 'antigravity', name),
        ]
      : [
          options.bundledQoderPath ?? bundledQoder(),
          join(
            options.appRuntimeDirectory,
            'qoder',
            'node_modules',
            '@qodercn-ai',
            'qodercn-agent-sdk',
            'dist',
            '_bundled',
            name,
          ),
        ];
  return [
    ...paths.map((path) => ({ path, source: 'path' as const })),
    ...appPaths
      .filter((path): path is string => !!path)
      .map((path) => ({ path, source: 'app' as const })),
  ];
}
