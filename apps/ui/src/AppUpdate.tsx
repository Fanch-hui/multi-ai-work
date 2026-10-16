import { Download, LoaderCircle, RefreshCw, RotateCw } from 'lucide-react';
import { useState } from 'react';
import { Button } from './components.js';
import { useAppUpdate, type AppUpdate } from './useAppUpdate.js';

function UpdateControls({ update }: { update: AppUpdate }) {
  const { state, pending, run } = update;
  if (!state) return null;
  if (state.phase === 'available') return <Button disabled={!!pending} onClick={() => void run('download')}>
    <Download size={14} aria-hidden="true" />下载更新 {state.version ?? ''}
  </Button>;
  if (state.phase === 'downloading') {
    const percent = state.total ? Math.min(100, Math.round((state.received ?? 0) / state.total * 100)) : undefined;
    return <div className="flex min-w-0 items-center gap-2 text-xs text-slate-600">
      <span role="progressbar" aria-label="更新下载进度" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}>
        下载中{percent === undefined ? '…' : ` ${percent}%`}
      </span>
      <Button disabled={pending === 'cancel'} onClick={() => void run('cancel')}>取消</Button>
    </div>;
  }
  if (state.phase === 'ready') return <Button disabled={!!pending} onClick={() => void run('install')}>
    <RotateCw size={14} aria-hidden="true" />重启更新
  </Button>;
  if (state.phase === 'installing') return <span role="status" className="text-xs text-slate-600">正在安装更新…</span>;
  if (state.phase === 'error') return <Button disabled={!!pending} onClick={() => void run('check')}>
    <RefreshCw size={14} aria-hidden="true" />重试更新
  </Button>;
  return null;
}

function UpdateError({ update }: { update: AppUpdate }) {
  const message = update.error || update.state?.error;
  if (!message) return null;
  return <p role="alert" title={message} className="max-w-full truncate text-xs text-red-700">{message}</p>;
}

export function SidebarAppUpdate() {
  const update = useAppUpdate();
  const { state, pending, run } = update;
  if (!state || ['disabled', 'idle', 'checking'].includes(state.phase)) return null;
  const downloading = state.phase === 'downloading';
  const installing = state.phase === 'installing';
  const percent = state.total ? Math.min(100, Math.round((state.received ?? 0) / state.total * 100)) : undefined;
  const label = downloading ? `正在下载更新${percent === undefined ? '' : ` ${percent}%`}，点击取消`
    : installing ? '正在安装更新' : state.phase === 'ready' ? '重启更新'
    : state.phase === 'error' ? '重新检查更新' : '下载更新';
  const Icon = downloading || installing ? LoaderCircle : state.phase === 'ready' ? RotateCw : state.phase === 'error' ? RefreshCw : Download;
  const command = downloading ? 'cancel' : state.phase === 'ready' ? 'install' : state.phase === 'error' ? 'check' : 'download';
  return <Button variant="ghost" className="size-7 min-h-7 shrink-0 p-0 text-blue-600 hover:bg-blue-100/70 hover:text-blue-700"
    aria-label={label} title={update.error || state.error || label}
    disabled={installing || (downloading ? pending === 'cancel' : !!pending)} onClick={() => void run(command)}>
    <Icon size={15} aria-hidden="true" className={downloading || installing ? 'motion-safe:animate-spin' : undefined} />
    {downloading && <span className="sr-only" role="progressbar" aria-label="更新下载进度" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent} />}
  </Button>;
}

export function AppUpdateSettings() {
  const update = useAppUpdate();
  const [checked, setChecked] = useState(false);
  const { state, pending, run } = update;
  if (!state) return null;
  return <section>
    <h2 className="mb-5 text-balance text-base font-semibold">应用更新</h2>
    <div className="grid gap-3 rounded-xl border border-slate-200 bg-white p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-slate-600">当前版本 {state.currentVersion}</p>
        <Button disabled={state.phase === 'disabled' || state.phase === 'checking' || state.phase === 'downloading' || state.phase === 'installing' || !!pending}
          onClick={async () => { setChecked(false); const result = await run('check'); setChecked(result?.phase === 'idle'); }}>
          <RefreshCw size={15} aria-hidden="true" />{state.phase === 'checking' ? '检查中…' : '检查更新'}
        </Button>
      </div>
      {state.phase === 'disabled' && <p className="text-xs text-slate-500">当前运行方式不支持应用更新</p>}
      {state.phase === 'checking' && <p role="status" className="text-xs text-slate-500">正在检查更新…</p>}
      {state.phase === 'idle' && checked && <p role="status" className="text-xs text-slate-500">已是最新版本</p>}
      {['available', 'downloading', 'ready', 'installing', 'error'].includes(state.phase) &&
        <div className="flex flex-wrap items-center gap-3"><UpdateControls update={update} /></div>}
      <UpdateError update={update} />
    </div>
  </section>;
}
