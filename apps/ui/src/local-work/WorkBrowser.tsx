import { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import type { BrowserSession, BrowserTab } from '../../../../src/domain/work-browser.js';
import { errorMessage, request } from '../api.js';
import type { Mutate } from '../store.js';
import { Button, ErrorNote, inputClass } from '../components.js';
import { useResource } from './useResource.js';
import { BrowserTeaching } from '../computer/BrowserTeaching.js';

export function WorkBrowser({
  conversationId,
  mutate,
  close,
  initialSessionId,
}: {
  initialSessionId?: string;
  conversationId?: string;
  mutate: Mutate;
  close: () => void;
}) {
  const capability = useResource<{ available: boolean }>('browser.available');
  const sessions = useResource<BrowserSession[]>('browser.sessions', { conversationId });
  const [selected, setSelected] = useState(initialSessionId ?? '');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [url, setUrl] = useState('');
  const submitting = useRef(false);
  const viewport = useRef<HTMLDivElement>(null);
  const live =
    sessions.value?.filter(
      (item) => item.status !== 'closed' && (!initialSessionId || item.id === initialSessionId),
    ) ?? [];
  const session = selected ? live.find((item) => item.id === selected) : live[0];
  const sessionId = session?.id;
  const tabs = useResource<BrowserTab[]>(
    'browser.userTabs',
    { id: sessionId, operation: 'list' },
    session?.status === 'handoff',
  );
  useEffect(() => {
    if (!sessionId) return;
    const element = viewport.current;
    if (!element) return;
    let disposed = false;
    let queued = false;
    let running = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function present() {
      if (disposed) return;
      if (running) {
        queued = true;
        return;
      }
      const bounds = element!.getBoundingClientRect();
      const hidden =
        document.visibilityState === 'hidden' ||
        !!document.querySelector('[role="dialog"], [role="alertdialog"]');
      const hasBounds = bounds.width >= 1 && bounds.height >= 1;
      running = true;
      try {
        await request('browser.present', {
          id: sessionId,
          ...(hasBounds && {
            bounds: {
              x: Math.round(bounds.x),
              y: Math.round(bounds.y),
              width: Math.floor(bounds.width),
              height: Math.floor(bounds.height),
            },
          }),
          visible: !hidden && hasBounds,
        });
      } catch (cause) {
        if (!disposed) setError(errorMessage(cause));
      } finally {
        running = false;
        if (disposed)
          void request('browser.present', { id: sessionId, visible: false }).catch(() => {});
        else if (queued) {
          queued = false;
          schedule();
        }
      }
    }
    function schedule() {
      if (timer) return;
      timer = setTimeout(() => {
        timer = undefined;
        void present();
      }, 30);
    }
    const resize = new ResizeObserver(schedule);
    resize.observe(element);
    const modals = new MutationObserver(schedule);
    modals.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['data-state'],
    });
    window.addEventListener('resize', schedule);
    window.addEventListener('scroll', schedule, true);
    document.addEventListener('visibilitychange', schedule);
    schedule();
    return () => {
      disposed = true;
      if (timer) clearTimeout(timer);
      resize.disconnect();
      modals.disconnect();
      window.removeEventListener('resize', schedule);
      window.removeEventListener('scroll', schedule, true);
      document.removeEventListener('visibilitychange', schedule);
      void request('browser.present', { id: sessionId, visible: false }).catch(() => {});
    };
  }, [sessionId]);
  async function changeControl() {
    if (!session || submitting.current) return;
    submitting.current = true;
    setBusy(true);
    setError('');
    try {
      await mutate(session.status === 'handoff' ? 'browser.resume' : 'browser.takeover', {
        id: session.id,
      });
      if (session.purpose === 'setup' && session.status === 'handoff') close();
      else sessions.reload();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }
  async function changeTab(tabId: string) {
    if (!session || submitting.current || session.status !== 'handoff') return;
    submitting.current = true;
    setBusy(true);
    setError('');
    try {
      await mutate('browser.userTabs', { id: session.id, operation: 'select', tabId });
      tabs.reload();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }
  async function navigate() {
    if (!session || submitting.current || session.status !== 'handoff') return;
    submitting.current = true;
    setBusy(true);
    setError('');
    try {
      await mutate('browser.navigate', { id: session.id, url });
      sessions.reload();
      tabs.reload();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }
  async function dismiss() {
    if (submitting.current) return;
    const setupId = session?.purpose === 'setup' ? session.id : initialSessionId;
    if (!setupId) {
      close();
      return;
    }
    submitting.current = true;
    setBusy(true);
    setError('');
    try {
      await mutate('browser.closeSession', { id: setupId });
      close();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }
  let controlLabel = session?.status === 'handoff' ? '交回团队' : '接管';
  if (session?.purpose === 'setup') controlLabel = '完成登录';
  return (
    <aside
      className="flex min-h-0 w-[42%] min-w-72 max-w-2xl flex-col border-l border-slate-200 bg-white max-md:absolute max-md:inset-0 max-md:z-20 max-md:w-full max-md:max-w-none"
      aria-label="工作浏览器"
    >
      <div className="flex h-12 shrink-0 items-center justify-between gap-2 border-b border-slate-100 px-3">
        <h2 className="text-sm font-medium">工作浏览器</h2>
        <Button
          variant="ghost"
          className="size-8 min-h-8 p-0"
          aria-label="关闭工作浏览器"
          disabled={busy}
          onClick={() => void dismiss()}
        >
          <X size={16} />
        </Button>
      </div>
      <div className="space-y-2 p-3">
        <ErrorNote error={sessions.error || capability.error || tabs.error || error} />
        {capability.value?.available === false && (
          <p className="text-sm text-amber-700">工作浏览器在桌面 App 中可用。</p>
        )}
        {session?.status === 'handoff' && !!tabs.value?.length && (
          <select
            aria-label="网页标签"
            className={inputClass}
            disabled={busy}
            value={tabs.value.find((tab) => tab.active)?.id ?? tabs.value[0].id}
            onChange={(event) => void changeTab(event.target.value)}
          >
            {tabs.value.map((tab) => (
              <option key={tab.id} value={tab.id}>
                {tab.title || tab.url || '新标签'}
              </option>
            ))}
          </select>
        )}
        {session?.status === 'handoff' && (
          <form
            className="flex gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              void navigate();
            }}
          >
            <input
              aria-label="网站地址"
              type="url"
              required
              placeholder="https://example.com"
              value={url}
              onChange={(event) => setUrl(event.target.value)}
              className={inputClass}
              disabled={busy}
            />
            <Button type="submit" disabled={busy}>
              前往
            </Button>
          </form>
        )}
        {live.length > 1 && (
          <select
            aria-label="浏览器会话"
            className="w-full rounded border border-slate-200 p-2 text-sm"
            value={sessionId}
            onChange={(event) => setSelected(event.target.value)}
          >
            {live.map((item) => (
              <option key={item.id} value={item.id}>
                {item.reason || item.id}
              </option>
            ))}
          </select>
        )}
        {session ? (
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-xs text-slate-500">
              {session.status === 'handoff'
                ? '你正在接管，可直接操作网页。'
                : '团队工作中，预览为只读。'}
            </p>
            <Button disabled={busy} onClick={() => void changeControl()}>
              {controlLabel}
            </Button>
            {session.reason && <p className="w-full text-xs text-slate-500">{session.reason}</p>}
          </div>
        ) : (
          <p className="py-3 text-sm text-slate-500">
            {sessions.loading ? '读取工作浏览器…' : '当前没有正在使用的浏览器会话。'}
          </p>
        )}
        {session?.status === 'handoff' && (
          <BrowserTeaching key={session.id} sessionId={session.id} mutate={mutate} />
        )}
      </div>
      <div ref={viewport} className="min-h-0 flex-1 bg-slate-50" />
    </aside>
  );
}
