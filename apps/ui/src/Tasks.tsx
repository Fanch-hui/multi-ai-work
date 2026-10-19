import { PageSurface } from './PageSurface.js';
import { useState, type ReactNode } from 'react';
import { Search } from 'lucide-react';
import type { Snapshot } from '../../../src/domain/types.js';
import type { Mutate } from './store.js';
import { Empty, inputClass } from './components.js';
import { cn } from './classNames.js';
import { ArtifactGroups } from './Artifacts.js';
import { artifactGroups } from './artifact-groups.js';

export function Tasks({
  data,
  mutate,
  headerLeading,
}: {
  data: Snapshot;
  mutate: Mutate;
  headerLeading?: ReactNode;
}) {
  const [query, setQuery] = useState('');
  const groups = artifactGroups(data, query);
  return (
    <PageSurface
      headerLeading={headerLeading}
      contentClassName="px-7 pb-5"
      header={
        <div className="flex shrink-0 items-center justify-between gap-4 px-7 py-3">
          <h1 className="text-balance text-lg font-semibold text-slate-800">库</h1>
          <div className="relative w-full max-w-xs">
            <Search
              size={15}
              className="pointer-events-none absolute left-3 top-2.5 text-slate-400"
            />
            <input
              className={cn(inputClass, 'min-h-9 py-1.5 pl-9')}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              aria-label="搜索成果"
              placeholder="搜索成果"
            />
          </div>
        </div>
      }
    >
      <div>
        {groups.length ? (
          <ArtifactGroups groups={groups} data={data} mutate={mutate} />
        ) : (
          <Empty
            title={query ? '没有匹配的成果' : '成果会保存在这里'}
            description={query ? undefined : '团队生成的文档、表格和文件，随时预览或打开。'}
          />
        )}
      </div>
    </PageSurface>
  );
}
