import { stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { AuthenticationRequiredError } from '../../domain/provider.js';
import { runtimeEnv } from './runtime.js';

const nativeAuthRoot = () => process.env.QODERCN_CONFIG_DIR || join(homedir(), '.qoder-cn');

export function qoderEnvironment(profile: string): NodeJS.ProcessEnv {
  return {
    ...runtimeEnv(homedir()),
    QODERCN_CONFIG_DIR: join(profile, '.qoder-cn'),
    QODER_SDK_AUTH_CONFIG_DIR: nativeAuthRoot(),
  };
}

export async function qoderAuthDirectory(
  profile: string,
  nativeRoot = nativeAuthRoot(),
): Promise<string> {
  if (!isAbsolute(nativeRoot)) throw new Error('Qoder CN 登录目录必须是绝对路径');
  const hasAuth = (root: string) =>
    stat(join(root, '.auth')).then(
      (value) => value.isDirectory(),
      () => false,
    );
  if (await hasAuth(nativeRoot)) return nativeRoot;
  const legacy = join(profile, '.qoder-cn');
  return (await hasAuth(legacy)) ? legacy : nativeRoot;
}

export function qoderProbeError(
  error: unknown,
  stage: 'initialization' | 'account' | 'models',
): Error {
  if (error instanceof AuthenticationRequiredError) return error;
  const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
  if (code === 'auth_required')
    return new AuthenticationRequiredError('Qoder CN 尚未登录，请在本机 CLI 完成官方登录后再检测');
  if (code === 'auth_expired')
    return new AuthenticationRequiredError('Qoder CN 登录已到期，请在本机 CLI 重新登录后再检测');
  if (code === 'auth_error') return new Error('Qoder CN 无法读取本机登录状态，请检查官方 CLI 登录');
  if (code === 'model_catalog_unavailable' || stage === 'models')
    return new Error('Qoder CN 模型目录读取失败，请检查网络或代理后再检测');
  return new Error(
    stage === 'account'
      ? 'Qoder CN 登录状态检测失败，请检查本机 CLI 登录'
      : 'Qoder CN 原生协议初始化失败，请检查运行时路径与兼容性',
  );
}
