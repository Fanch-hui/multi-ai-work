import { validateDataDirectory } from '../../src/core/data-directory-paths.js';
import { saveDataDirectory } from './data-location.js';

interface Options {
  defaultDirectory: string;
  currentDirectory: string;
  core: {
    readonly running: boolean;
    request(method: string, params: Record<string, unknown>): Promise<unknown>;
    close(): Promise<void>;
  };
  startCore(): Promise<void>;
  copy(source: string, target: string): Promise<string>;
  restart(): void;
  changed(): void;
}

export class DataDirectoryController {
  private operation?: Promise<{ path: string; restarting: true }>;
  private restarting = false;
  constructor(private options: Options) {}
  get busy() { return !!this.operation || this.restarting; }

  change(path: string) {
    if (this.busy) return Promise.reject(new Error('正在更改数据目录，请稍候'));
    this.operation = this.migrate(path).finally(() => {
      this.operation = undefined;
      if (!this.restarting) this.options.changed();
    });
    return this.operation;
  }
  async settle() { await this.operation?.catch(() => {}); }

  private async migrate(input: string): Promise<{ path: string; restarting: true }> {
    const { target } = await validateDataDirectory(this.options.currentDirectory, input);
    let acquired = false;
    try {
      await this.options.core.request('system.prepareDataDirectoryChange', {}); acquired = true;
      await this.options.core.close();
      const path = await this.options.copy(this.options.currentDirectory, target);
      await saveDataDirectory(this.options.defaultDirectory, path);
      this.restarting = true;
      this.options.restart();
      return { path, restarting: true };
    } catch (error) {
      if (acquired) {
        try {
          if (!this.options.core.running) await this.options.startCore();
          await this.options.core.request('system.releaseDataDirectoryChange', {});
        } catch { throw new Error('目录更改未完成，原位置的数据仍保留，请重新启动应用'); }
      }
      throw error;
    }
  }
}
