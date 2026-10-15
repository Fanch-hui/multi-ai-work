import { useEffect, useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { errorMessage, request } from './api.js';
import { Button, ErrorNote } from './components.js';

interface Preview {
  pages: { index: number; label: string; width: number; height: number }[];
  missingFonts: string[];
}

export function isDocumentPreview(name: string) {
  return /\.(docx?|xlsx?|pptx?|pdf|odt|ods|odp)$/i.test(name);
}

export function DocumentPreview({ artifactId }: { artifactId: string }) {
  const [preview, setPreview] = useState<Preview>();
  const [page, setPage] = useState(1);
  const [url, setUrl] = useState('');
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    setPreview(undefined); setPage(1); setError('');
    void request<Preview>('artifacts.previewDocument', { id: artifactId })
      .then(result => { if (active) setPreview(result); })
      .catch(cause => { if (active) setError(errorMessage(cause)); });
    return () => { active = false; };
  }, [artifactId]);
  useEffect(() => {
    if (!preview) return;
    let active = true, objectUrl = '';
    setUrl(''); setError('');
    void request<{ mimeType: string; data: string }>('artifacts.previewPage', { id: artifactId, page })
      .then(result => {
        if (!active) return;
        const bytes = Uint8Array.from(atob(result.data), character => character.charCodeAt(0));
        objectUrl = URL.createObjectURL(new Blob([bytes], { type: result.mimeType }));
        setUrl(objectUrl);
      }).catch(cause => { if (active) setError(errorMessage(cause)); });
    return () => { active = false; if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [artifactId, page, preview]);
  const current = preview?.pages[page - 1];
  return <div className="min-w-0 space-y-3">
    <ErrorNote error={error} />
    {preview && <div className="flex items-center justify-between gap-3">
      <Button variant="ghost" aria-label="上一页" disabled={page <= 1} onClick={() => setPage(page - 1)}><ChevronLeft size={18} /></Button>
      <label className="flex min-w-0 items-center gap-2 text-xs text-slate-600">
        <span className="shrink-0">页面</span>
        <select aria-label="选择预览页面" className="min-w-0 max-w-full rounded-lg border border-slate-200 bg-white p-2 text-sm tabular-nums"
          value={page} onChange={event => setPage(Number(event.target.value))}>
          {preview.pages.map(item => <option key={item.index} value={item.index}>{item.label}</option>)}
        </select>
        <span className="shrink-0 tabular-nums">/ {preview.pages.length}</span>
      </label>
      <Button variant="ghost" aria-label="下一页" disabled={page >= preview.pages.length} onClick={() => setPage(page + 1)}><ChevronRight size={18} /></Button>
    </div>}
    {url ? <div className="max-h-[60vh] overflow-auto rounded-xl border border-slate-200 bg-slate-50 p-2">
      <img src={url} alt={current?.label ?? '文档页面'} className="mx-auto h-auto max-w-full bg-white" />
    </div> : !error && <div role="status" className="min-h-64 space-y-3 rounded-xl bg-slate-50 p-6">
      <p className="text-sm text-slate-500">{preview ? '正在读取页面…' : '正在生成文档预览…'}</p>
      <div className="h-3 w-2/3 rounded bg-slate-200" /><div className="h-3 w-full rounded bg-slate-200" />
      <div className="h-3 w-5/6 rounded bg-slate-200" />
    </div>}
    {!!preview?.missingFonts.length && <p className="text-pretty text-xs text-slate-500">预览使用替代字体：{preview.missingFonts.join('、')}</p>}
  </div>;
}
