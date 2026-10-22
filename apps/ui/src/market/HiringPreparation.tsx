import { Button } from '../components.js';
import { preparationSummary, type PresetPreparation } from './presetPreparation.js';

export function HiringPreparation({
  results,
  busy,
  retry,
  configure,
  dismiss,
}: {
  results: PresetPreparation[];
  busy: boolean;
  retry: () => void;
  configure: () => void;
  dismiss: () => void;
}) {
  const { ready, failed, cancelled, preparing, configured } = preparationSummary(results);
  if (!results.length || (!failed.length && !cancelled.length)) return null;
  const retryLabel = () => {
    if (!cancelled.length) return '仅重试失败项';
    if (!failed.length) return '重试取消项';
    return '重试失败或取消项';
  };
  return (
    <div className="mb-6 grid gap-3 rounded-xl border border-slate-200 bg-white px-4 py-3">
      <p role="status" className="text-sm text-slate-700">
        资源准备：就绪 {ready.length} 位，失败 {failed.length} 位，取消 {cancelled.length} 位
        {!!preparing.length && `，准备中 ${preparing.length} 位`}
        {!!configured.length && `，已进入配置 ${configured.length} 位`}
      </p>
      <ul className="grid gap-1 text-xs text-slate-500">
        {[...failed, ...cancelled].map((item) => (
          <li key={item.row.key}>
            {item.row.preset.name} · {item.status === 'cancelled' ? '已取消' : item.error}
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap justify-end gap-2">
        <Button disabled={busy} onClick={dismiss}>
          关闭
        </Button>
        <Button disabled={busy} onClick={retry}>
          {retryLabel()}
        </Button>
        {!!ready.length && (
          <Button variant="primary" disabled={busy} onClick={configure}>
            配置就绪的 {ready.length} 位成员
          </Button>
        )}
      </div>
    </div>
  );
}
