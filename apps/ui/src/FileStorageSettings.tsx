import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { HardDrive, RefreshCw } from 'lucide-react';
import type {
  ArtifactStorageCleanup,
  ArtifactStorageUsage,
} from '../../../src/domain/artifact-storage.js';
import { errorMessage, request } from './api.js';
import { Button, Confirm, ErrorNote, Field, inputClass } from './components.js';

function formatStorageBytes(value: number) {
  if (value < 1024) return `${value} B`;
  const units = ['KiB', 'MiB', 'GiB', 'TiB'];
  let size = value / 1024;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit++;
  }
  return `${size.toLocaleString('zh-CN', { maximumFractionDigits: 1 })} ${units[unit]}`;
}

export function FileStorageSummary({ usage }: { usage: ArtifactStorageUsage }) {
  const savedBytes = Math.max(0, usage.logicalFileBytes - usage.fileBytes);
  const rows = [
    { label: '实际文件占用', bytes: usage.fileBytes, hint: '相同内容共用一份文件' },
    { label: '其中历史版本', bytes: usage.historyBytes, hint: '包含在实际文件占用中' },
    { label: '可重建缓存', bytes: usage.cacheBytes, hint: '图片、文档预览及工具结果的临时副本' },
    { label: '可清理空间', bytes: usage.reclaimableBytes, hint: '缓存及已失效临时副本' },
  ];
  return (
    <div className="grid gap-4">
      <dl className="grid gap-4 sm:grid-cols-2">
        {rows.map((row) => (
          <div key={row.label} className="rounded-lg bg-slate-50 p-4">
            <dt className="text-sm text-slate-600">{row.label}</dt>
            <dd className="mt-2 text-xl font-semibold tabular-nums text-slate-800">
              {formatStorageBytes(row.bytes)}
            </dd>
            <p className="mt-1 text-xs leading-5 text-slate-500">{row.hint}</p>
          </div>
        ))}
      </dl>
      <p className="text-sm text-slate-500">内容去重已节省 {formatStorageBytes(savedBytes)}。</p>
    </div>
  );
}

export function FileStorageSettings() {
  const [usage, setUsage] = useState<ArtifactStorageUsage>();
  const [cacheMiB, setCacheMiB] = useState('');
  const [cacheIdleDays, setCacheIdleDays] = useState('');
  const [busy, setBusy] = useState('load');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const generation = useRef(0);

  const updateUsage = useCallback((value: ArtifactStorageUsage) => {
    setUsage(value);
    setCacheMiB(String(value.policy.cacheMiB));
    setCacheIdleDays(String(value.policy.cacheIdleDays));
  }, []);

  const run = useCallback(
    async <T,>(operation: string, work: () => Promise<T>, apply: (value: T) => void) => {
      const current = ++generation.current;
      setBusy(operation);
      setError('');
      setNotice('');
      try {
        const value = await work();
        if (current === generation.current) apply(value);
      } catch (cause) {
        if (current === generation.current) setError(errorMessage(cause));
      } finally {
        if (current === generation.current) setBusy('');
      }
    },
    [],
  );

  const refresh = useCallback(
    () => run('load', () => request<ArtifactStorageUsage>('artifacts.storage'), updateUsage),
    [run, updateUsage],
  );

  useEffect(() => {
    void refresh();
    return () => {
      generation.current++;
    };
  }, [refresh]);

  async function save(event: FormEvent) {
    event.preventDefault();
    const input = { cacheMiB: Number(cacheMiB), cacheIdleDays: Number(cacheIdleDays) };
    if (
      !Number.isInteger(input.cacheMiB) ||
      input.cacheMiB < 64 ||
      input.cacheMiB > 4096 ||
      !Number.isInteger(input.cacheIdleDays) ||
      input.cacheIdleDays < 1 ||
      input.cacheIdleDays > 30
    ) {
      setError('缓存容量请输入 64～4096 MiB 的整数，闲置天数请输入 1～30 的整数');
      return;
    }
    await run(
      'save',
      () => request<ArtifactStorageUsage>('artifacts.configureStorage', { input }),
      (value) => {
        updateUsage(value);
        setNotice('文件存储设置已保存');
      },
    );
  }

  return (
    <div className="grid gap-8" aria-busy={!!busy}>
      <section className="grid gap-5" aria-label="文件存储占用">
        <div className="flex items-center justify-between gap-3">
          <h2 className="flex items-center gap-2 text-base font-semibold">
            <HardDrive size={18} className="text-slate-500" />
            空间占用
          </h2>
          <Button disabled={!!busy} onClick={() => void refresh()}>
            <RefreshCw size={15} />
            {busy === 'load' ? '统计中…' : '刷新统计'}
          </Button>
        </div>
        <div className="grid gap-5 rounded-xl border border-slate-200 bg-white p-5">
          {usage ? (
            <FileStorageSummary usage={usage} />
          ) : (
            <p role="status" className="text-sm text-slate-500">
              {busy === 'load' ? '正在统计文件占用…' : '文件占用暂未加载，请重试'}
            </p>
          )}
          {usage && (
            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-100 pt-4">
              <p className="text-sm leading-6 text-slate-500">
                上传资料、交付成果和历史版本持续保留。
              </p>
              <Confirm
                title="清理可回收文件？"
                description={`将清理可重建缓存及已失效临时副本，预计释放 ${formatStorageBytes(usage.reclaimableBytes)}。上传资料、交付成果、历史版本及工作区原文件保持保留。`}
                actionLabel="开始清理"
                actionVariant="primary"
                onConfirm={() =>
                  run(
                    'clean',
                    () =>
                      request<ArtifactStorageCleanup>('artifacts.cleanStorage', {
                        clearCache: true,
                      }),
                    (result) => {
                      setUsage(result.usage);
                      setNotice(`清理完成，已释放 ${formatStorageBytes(result.removedBytes)}`);
                    },
                  )
                }
              >
                <Button disabled={!!busy || usage.reclaimableBytes === 0}>
                  {busy === 'clean' ? '清理中…' : '清理空间'}
                </Button>
              </Confirm>
            </div>
          )}
        </div>
      </section>
      {usage && (
        <section className="grid gap-5" aria-label="自动清理设置">
          <h2 className="text-base font-semibold">自动清理设置</h2>
          <form
            className="grid gap-5 rounded-xl border border-slate-200 bg-white p-5"
            onSubmit={(event) => void save(event)}
          >
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="预览缓存容量上限（MiB）" hint="超过上限时优先回收较少使用的缓存。">
                <input
                  type="number"
                  min={64}
                  max={4096}
                  step={1}
                  required
                  disabled={!!busy}
                  className={inputClass}
                  value={cacheMiB}
                  onChange={(event) => setCacheMiB(event.target.value)}
                />
              </Field>
              <Field label="预览缓存闲置天数" hint="达到此天数的缓存会自动回收，需要时重新生成。">
                <input
                  type="number"
                  min={1}
                  max={30}
                  step={1}
                  required
                  disabled={!!busy}
                  className={inputClass}
                  value={cacheIdleDays}
                  onChange={(event) => setCacheIdleDays(event.target.value)}
                />
              </Field>
            </div>
            <div className="flex justify-end">
              <Button variant="primary" disabled={!!busy}>
                {busy === 'save' ? '保存中…' : '保存设置'}
              </Button>
            </div>
          </form>
        </section>
      )}
      <ErrorNote error={error} />
      {notice && (
        <p role="status" className="rounded-lg bg-blue-50 p-3 text-sm text-blue-800">
          {notice}
        </p>
      )}
    </div>
  );
}
