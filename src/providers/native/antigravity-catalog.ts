import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { promisify } from 'node:util';
import type { ModelInfo } from '../../domain/types.js';
import { AuthenticationRequiredError } from '../../domain/provider.js';
import { commandFor, runtimeEnv } from './runtime.js';

const execute = promisify(execFile);
const effortSuffix = /-(low|medium|high|xhigh|max)$/;
export interface AntigravityModel {
  id: string;
  name: string;
}

export function antigravityEnvironment(): NodeJS.ProcessEnv {
  const env = runtimeEnv(homedir());
  for (const name of [
    'USER',
    'LOGNAME',
    'LOCALAPPDATA',
    'APPDATA',
    'XDG_RUNTIME_DIR',
    'DBUS_SESSION_BUS_ADDRESS',
  ])
    if (process.env[name]) env[name] = process.env[name];
  return env;
}

export function parseAntigravityCatalog(output: string): AntigravityModel[] {
  const models = new Map<string, AntigravityModel>();
  for (const line of output.replace(/\u001b\[[0-9;]*m/g, '').split(/\r?\n/)) {
    const match = line.trim().match(/^([\w][\w./:-]*)\t([^\t]+)$/);
    if (match) models.set(match[1], { id: match[1], name: match[2].trim() });
  }
  if (!models.size) throw new Error('agy 未返回可用模型目录，请检查 CLI 版本与账号模型权限');
  return [...models.values()];
}

export function antigravityCatalog(models: AntigravityModel[]): ModelInfo[] {
  const families = new Map<string, AntigravityModel[]>();
  for (const model of models) {
    const family = model.id.replace(effortSuffix, '');
    families.set(family, [...(families.get(family) ?? []), model]);
  }
  return [...families.values()].map((family) => {
    const selected = family.find((model) => model.id.endsWith('-high')) ?? family[0];
    const reasoning = ['low', 'medium', 'high', 'xhigh', 'max'].filter((effort) =>
      family.some((model) => model.id.endsWith(`-${effort}`)),
    );
    return {
      id: selected.id,
      name: selected.name.replace(/\s*\((Low|Medium|High|Xhigh|Max)\)$/i, ''),
      ...(reasoning.length ? { reasoning, reasoningSource: 'provider' as const } : {}),
    };
  });
}

export function resolveAntigravityModel(
  models: AntigravityModel[],
  id: string,
  reasoning?: string,
): string {
  const selected = models.find((model) => model.id === id);
  if (!selected) throw new Error('所选 agy 模型不在本机可用目录中，请重新选择模型');
  if (!reasoning) return selected.id;
  const variant = `${selected.id.replace(effortSuffix, '')}-${reasoning}`;
  if (!models.some((model) => model.id === variant))
    throw new Error('所选 agy 模型不支持此推理强度');
  return variant;
}

export async function readAntigravityCatalog(executable: string, cwd: string, signal: AbortSignal) {
  const invocation = commandFor(executable, ['models']);
  let output: string;
  try {
    output = (
      await execute(invocation.command, invocation.args, {
        cwd,
        signal,
        timeout: 30000,
        maxBuffer: 256000,
        windowsHide: true,
        env: antigravityEnvironment(),
      })
    ).stdout;
  } catch (error) {
    signal.throwIfAborted();
    const diagnostic = error as { stderr?: string; stdout?: string; code?: string | number };
    const text = `${diagnostic.stderr ?? ''}\n${diagnostic.stdout ?? ''}`;
    if (
      /not (?:logged|signed) in|sign[ -]?in required|auth(?:entication)? required|please (?:log|sign) in|login required/i.test(
        text,
      )
    )
      throw new AuthenticationRequiredError('agy 尚未登录，请在本机 agy 完成官方登录后再检测连接');
    if (diagnostic.code === 'ENOENT') throw new Error('无法启动 agy，请检查运行时路径');
    throw new Error('agy 模型目录读取失败，请检查原生 CLI 登录、网络或代理设置');
  }
  return parseAntigravityCatalog(output);
}
