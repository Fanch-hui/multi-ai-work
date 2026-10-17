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

  it('coalesces concurrent decrypts, caches repeated reads, retries failures, and invalidates on rotation/delete/load/clear', async () => {
    const target = join(directory, 'vault.json');
    let decryptCalls = 0;
    let shouldFail = false;
    let delayMs = 15;
    const trackedCipher: CipherHost = {
      encrypt: async value => `${Buffer.from(value).toString('base64')}:${decryptCalls}`,
      decrypt: async value => {
        decryptCalls++;
        await new Promise(resolve => setTimeout(resolve, delayMs));
        if (shouldFail) throw new Error('decrypt failed');
        return Buffer.from(value.split(':')[0]!, 'base64').toString('utf8');
      },
    };
    const vault = new Vault(target, trackedCipher);
    await vault.set('token', 'synthetic-v1');
    const [a, b, c] = await Promise.all([vault.get('token'), vault.get('token'), vault.get('token')]);
    expect([a, b, c]).toEqual(['synthetic-v1', 'synthetic-v1', 'synthetic-v1']);
    expect(decryptCalls).toBe(1);
    expect(await vault.get('token')).toBe('synthetic-v1');
    expect(decryptCalls).toBe(1);

    await vault.set('token', 'synthetic-v2');
    shouldFail = true;
    await expect(vault.get('token')).rejects.toThrow('decrypt failed');
    expect(decryptCalls).toBe(2);
    shouldFail = false;
    expect(await vault.get('token')).toBe('synthetic-v2');
    expect(decryptCalls).toBe(3);

    delayMs = 40;
    vault.clear();
    const staleRead = vault.get('token');
    await new Promise(resolve => setTimeout(resolve, 5));
    delayMs = 1;
    await vault.set('token', 'synthetic-v3');
    expect(await staleRead).toBe('synthetic-v2');
    expect(await vault.get('token')).toBe('synthetic-v3');

    vault.clear();
    expect(await vault.get('token')).toBe('synthetic-v3');
    expect(decryptCalls).toBe(6);

    await vault.delete('token');
    expect(await vault.get('token')).toBeUndefined();

    await vault.set('ephemeral', 'synthetic-temp');
    expect(await vault.get('ephemeral')).toBe('synthetic-temp');
    await rm(target, { force: true });
    await vault.load();
    expect(await vault.get('ephemeral')).toBeUndefined();
  });
});
