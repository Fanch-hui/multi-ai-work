import { Button, Empty, ErrorNote } from '../components.js';

export function CatalogLoadState({
  loading,
  error,
  retry,
  importPreset,
}: {
  loading: boolean;
  error: string;
  retry: () => void;
  importPreset: () => void;
}) {
  if (loading)
    return (
      <div aria-busy="true" className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {[1, 2, 3].map((id) => (
          <div key={id} className="h-56 rounded-2xl bg-slate-50" />
        ))}
      </div>
    );
  return (
    <>
      <ErrorNote error={error} />
      <Empty
        title="暂时无法读取市场目录"
        description="可以重试，或导入本地预设包。"
        action={
          <div className="flex gap-2">
            <Button onClick={importPreset}>导入预设</Button>
            <Button variant="primary" onClick={retry}>
              重试
            </Button>
          </div>
        }
      />
    </>
  );
}
