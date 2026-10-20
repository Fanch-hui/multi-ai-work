import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { ArtifactStorageUsage } from '../src/domain/artifact-storage.js';
import { FileStorageSummary } from '../apps/ui/src/FileStorageSettings.js';

const MiB = 1024 * 1024;
const usage: ArtifactStorageUsage = {
  fileBytes: 20 * MiB,
  logicalFileBytes: 60 * MiB,
  historyBytes: 5 * MiB,
  cacheBytes: 2 * MiB,
  reclaimableBytes: 3 * MiB,
  fileCount: 3,
  policy: { cacheMiB: 512, cacheIdleDays: 7 },
};

describe('file storage summary', () => {
  it('shows physical storage, history share and reclaimable space separately', () => {
    const html = renderToStaticMarkup(createElement(FileStorageSummary, { usage }));
    for (const value of ['20 MiB', '5 MiB', '2 MiB', '3 MiB', '40 MiB']) {
      expect(html).toContain(value);
    }
    expect(html).toContain('其中历史版本');
    expect(html).toContain('包含在实际文件占用中');
  });

  it('shows zero savings when retained physical files exceed current logical references', () => {
    const html = renderToStaticMarkup(
      createElement(FileStorageSummary, { usage: { ...usage, logicalFileBytes: 0 } }),
    );
    expect(html).toContain('内容去重已节省 0 B');
    expect(html).not.toContain('-20 MiB');
  });
});
