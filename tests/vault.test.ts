import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Vault, type CipherHost } from '../src/security/vault.js';

const cipher: CipherHost = {
  encrypt: async value => Buffer.from(value).toString('base64'),
  decrypt: async value => Buffer.from(value, 'base64').toString('utf8')
};

describe('vault persistence', () => {
  let directory: string;
  beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'team-vault-')); });
  afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

  it('reports a failed write and allows later writes and deletes to persist', async () => {
    const target = join(directory, 'vault.json');
    const vault = new Vault(target, cipher);
    await vault.load();
    await mkdir(`${target}.pending`);
    await expect(vault.set('first', 'synthetic-first')).rejects.toThrow();
    await rm(`${target}.pending`, { recursive: true });

    await vault.set('second', 'synthetic-second');
    const restored = new Vault(target, cipher);
    await restored.load();
    expect(await restored.get('second')).toBe('synthetic-second');
    expect(await readFile(target, 'utf8')).not.toContain('synthetic-second');
    await vault.delete('first');
    await restored.load();
    expect(await restored.get('first')).toBeUndefined();
    expect(await restored.get('second')).toBe('synthetic-second');
  });

  it('keeps concurrent writes serialized and readable after reload', async () => {
    const target = join(directory, 'vault.json');
    const vault = new Vault(target, cipher);
    await Promise.all([vault.set('first', 'synthetic-first'), vault.set('second', 'synthetic-second')]);
    const restored = new Vault(target, cipher);
    await restored.load();
    expect(await restored.get('first')).toBe('synthetic-first');
    expect(await restored.get('second')).toBe('synthetic-second');
  });
});
