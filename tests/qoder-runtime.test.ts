import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { qoderAuthDirectory, qoderEnvironment, qoderProbeError } from '../src/providers/native/qoder-runtime.js';
import { AuthenticationRequiredError } from '../src/domain/provider.js';

const folders: string[] = [];
afterEach(async () => { await Promise.all(folders.splice(0).map(folder => rm(folder, { recursive: true, force: true }))); });
const directory = async () => { const folder = await mkdtemp(join(tmpdir(), 'multi-ai-qoder-')); folders.push(folder); return folder; };

describe('Qoder native login and isolated sessions', () => {
  it('preserves the real home while separating App configuration from native authentication', async () => {
    const profile = await directory(), env = qoderEnvironment(profile);
    expect(env.HOME).toBe(homedir()); expect(env.USERPROFILE).toBe(homedir());
    expect(env.QODERCN_CONFIG_DIR).toBe(join(profile, '.qoder-cn'));
    expect(env.QODER_SDK_AUTH_CONFIG_DIR).toBe(process.env.QODERCN_CONFIG_DIR || join(homedir(), '.qoder-cn'));
  });

  it('keeps previous App logins available when no system CN login exists', async () => {
    const folder = await directory(), profile = join(folder, 'profile'), native = join(folder, 'native');
    expect(await qoderAuthDirectory(profile, native)).toBe(native);
    await mkdir(join(profile, '.qoder-cn', '.auth'), { recursive: true });
    expect(await qoderAuthDirectory(profile, native)).toBe(join(profile, '.qoder-cn'));
    await mkdir(join(native, '.auth'), { recursive: true });
    expect(await qoderAuthDirectory(profile, native)).toBe(native);
  });

  it('separates login failures from model catalog and native initialization failures without exposing diagnostics', () => {
    expect(qoderProbeError({ code: 'auth_required' }, 'initialization')).toBeInstanceOf(AuthenticationRequiredError);
    expect(qoderProbeError({ code: 'auth_expired' }, 'initialization')).toBeInstanceOf(AuthenticationRequiredError);
    expect(qoderProbeError({ code: 'model_catalog_unavailable', message: 'private diagnostic' }, 'initialization').message)
      .toBe('Qoder CN 模型目录读取失败，请检查网络或代理后再检测');
    expect(qoderProbeError(new Error('private diagnostic'), 'initialization').message).toContain('原生协议初始化');
    expect(qoderProbeError(new Error('private diagnostic'), 'models').message).not.toContain('private diagnostic');
  });
});
