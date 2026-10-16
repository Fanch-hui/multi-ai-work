import { migrateDataDirectory } from '../../src/core/data-directory.js';

const port = (process as NodeJS.Process & { parentPort?: { postMessage(value: unknown): void } }).parentPort;
try {
  const path = await migrateDataDirectory(process.argv[2], process.argv[3]);
  port?.postMessage({ type: 'complete', path });
  setImmediate(() => process.exit(0));
} catch (error) {
  const code = (error as NodeJS.ErrnoException).code;
  const message = code === 'ENOSPC' ? '新位置的磁盘空间不足，请更换目录后重试'
    : code === 'EACCES' || code === 'EPERM' ? '无法写入新位置，请检查文件夹访问权限'
      : '数据复制未完成，请检查新目录的权限和可用空间后重试';
  port?.postMessage({ type: 'error', error: message });
  setImmediate(() => process.exit(1));
}
