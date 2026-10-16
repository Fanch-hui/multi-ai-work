import { describe, expect, it } from 'vitest';
import { compareUpdateVersions, selectUpdate } from '../src/updates/manifest.js';

const asset = { platform: 'macos', architecture: 'arm64', kind: 'app-zip', size: 42, sha256: 'a'.repeat(64),
  url: 'https://github.com/Fanch-hui/multi-ai-work/releases/download/v0.10.0/multi-AI-work-0.10.0-arm64.zip' };
const select = (assets: unknown[], version = '0.10.0') => selectUpdate({ version, assets }, '0.9.9', 'macos', 'arm64');

describe('update manifest admission', () => {
  it('compares stable numeric versions and ignores old releases', () => {
    expect(compareUpdateVersions('0.10.0', '0.9.9')).toBe(1);
    expect(select([asset])?.asset).toEqual(asset);
    expect(select([], '0.9.9')).toBeUndefined();
    expect(() => select([], '0.10.0-preview')).toThrow();
  });
  it('requires exactly one asset for the actual platform and architecture', () => {
    expect(() => select([{ ...asset, architecture: 'x64' }])).toThrow('唯一');
    expect(() => select([asset, asset])).toThrow('唯一');
  });
  it.each([
    { url: asset.url.replace('Fanch-hui/multi-ai-work', 'someone/other') },
    { url: asset.url.replace('https:', 'http:') },
    { url: asset.url + '?override=1' },
    { url: asset.url.replace('v0.10.0/', 'v0.9.9/') },
    { size: 0 }, { sha256: 'unknown' },
  ])('rejects invalid package identity or integrity metadata: %j', change => {
    expect(() => select([{ ...asset, ...change }])).toThrow();
  });
});
