import { z } from 'zod';
import { APP_UPDATE_REPOSITORY, type AppUpdateAsset } from '../domain/app-update.js';

export function updateVersion(value: string): number[] {
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value))
    throw new Error('更新版本格式无效');
  const parts = value.split('.').map(Number);
  if (!parts.every(Number.isSafeInteger)) throw new Error('更新版本格式无效');
  return parts;
}

export function compareUpdateVersions(left: string, right: string): number {
  const a = updateVersion(left),
    b = updateVersion(right);
  for (let index = 0; index < 3; index++)
    if (a[index] !== b[index]) return Math.sign(a[index] - b[index]);
  return 0;
}

export function updateFileName(
  version: string,
  architecture: AppUpdateAsset['architecture'],
  kind: AppUpdateAsset['kind'],
): string {
  updateVersion(version);
  return `multi-AI-work-${version}-${architecture}.${kind === 'app-zip' ? 'zip' : 'exe'}`;
}

const assetSchema = z.object({
  platform: z.enum(['macos', 'windows']),
  architecture: z.enum(['arm64', 'x64']),
  kind: z.enum(['app-zip', 'nsis']),
  url: z.string(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  size: z
    .number()
    .int()
    .positive()
    .max(4 * 1024 ** 3),
});

export function selectUpdate(
  input: unknown,
  currentVersion: string,
  platform: AppUpdateAsset['platform'],
  architecture: AppUpdateAsset['architecture'],
) {
  const manifest = z
    .object({ version: z.string(), assets: z.array(z.unknown()).max(20) })
    .parse(input);
  if (compareUpdateVersions(manifest.version, currentVersion) <= 0) return undefined;
  const kind = platform === 'macos' ? 'app-zip' : 'nsis';
  const matches = manifest.assets.filter((value) => {
    const asset = value as Partial<AppUpdateAsset> | null;
    return (
      asset &&
      asset.platform === platform &&
      asset.architecture === architecture &&
      asset.kind === kind
    );
  });
  if (matches.length !== 1) throw new Error('更新清单缺少当前平台的唯一安装包');
  const asset = assetSchema.parse(matches[0]);
  const url = new URL(asset.url);
  const expected = `/${APP_UPDATE_REPOSITORY}/releases/download/v${manifest.version}/${updateFileName(manifest.version, architecture, kind)}`;
  if (
    url.protocol !== 'https:' ||
    url.hostname !== 'github.com' ||
    url.port ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== expected
  )
    throw new Error('更新安装包地址不属于本项目发布资源');
  return { version: manifest.version, asset };
}
