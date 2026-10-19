import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

export interface CipherHost {
  encrypt(value: string): Promise<string>;
  decrypt(value: string): Promise<string>;
}

interface CacheEntry {
  ciphertext: string;
  value?: string;
  pending?: Promise<string>;
}

export class Vault {
  private values = new Map<string, string>();
  private cache = new Map<string, CacheEntry>();
  private pending: Promise<void> = Promise.resolve();
  readonly path: string;
  private cipher?: CipherHost;
  constructor(path: string, cipher?: CipherHost) {
    this.path = path;
    this.cipher = cipher;
  }
  async load() {
    this.cache.clear();
    if (!this.cipher) return;
    try {
      const record = JSON.parse(await readFile(this.path, 'utf8')) as Record<string, string>;
      this.values = new Map(Object.entries(record));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
        throw new Error('凭据存储无法读取，请检查本机保护后端。');
      this.values = new Map();
    } finally {
      this.cache.clear();
    }
  }
  async get(ref?: string): Promise<string | undefined> {
    if (!ref) return undefined;
    const value = this.values.get(ref);
    if (value === undefined) {
      this.cache.delete(ref);
      return undefined;
    }
    if (!this.cipher) return value;
    const cached = this.cache.get(ref);
    if (cached?.ciphertext === value) {
      if (cached.value !== undefined) return cached.value;
      if (cached.pending) return cached.pending;
    }
    const entry: CacheEntry = { ciphertext: value };
    const pending = this.cipher.decrypt(value).then(
      (decrypted) => {
        if (this.cache.get(ref) === entry && this.values.get(ref) === value) {
          entry.value = decrypted;
          entry.pending = undefined;
        }
        return decrypted;
      },
      (error) => {
        if (this.cache.get(ref) === entry) this.cache.delete(ref);
        throw error;
      },
    );
    entry.pending = pending;
    this.cache.set(ref, entry);
    return pending;
  }
  async set(ref: string, value: string) {
    this.cache.delete(ref);
    const stored = this.cipher ? await this.cipher.encrypt(value) : value;
    this.cache.delete(ref);
    this.values.set(ref, stored);
    await this.persist();
  }
  async delete(ref: string) {
    this.cache.delete(ref);
    this.values.delete(ref);
    await this.persist();
  }
  clear() {
    this.cache.clear();
  }
  async flush() {
    await this.pending;
  }
  private persist() {
    if (!this.cipher) return Promise.resolve();
    const operation = this.pending.then(async () => {
      await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
      const temporary = `${this.path}.pending`;
      await writeFile(temporary, JSON.stringify(Object.fromEntries(this.values)), { mode: 0o600 });
      await rename(temporary, this.path);
    });
    this.pending = operation.catch(() => {});
    return operation;
  }
}
