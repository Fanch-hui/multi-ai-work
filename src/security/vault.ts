import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

export interface CipherHost {
  encrypt(value: string): Promise<string>;
  decrypt(value: string): Promise<string>;
}
export class Vault {
  private values = new Map<string, string>();
  private pending: Promise<void> = Promise.resolve();
  constructor(readonly path: string, private cipher?: CipherHost) {}
  async load() {
    if (!this.cipher) return;
    try {
      const record = JSON.parse(await readFile(this.path, 'utf8')) as Record<string, string>;
      this.values = new Map(Object.entries(record));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('凭据存储无法读取，请检查本机保护后端。');
    }
  }
  async get(ref?: string): Promise<string | undefined> {
    if (!ref) return undefined;
    const value = this.values.get(ref);
    if (value === undefined) return undefined;
    return this.cipher ? this.cipher.decrypt(value) : value;
  }
  async set(ref: string, value: string) {
    this.values.set(ref, this.cipher ? await this.cipher.encrypt(value) : value);
    await this.persist();
  }
  async delete(ref: string) { this.values.delete(ref); await this.persist(); }
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
