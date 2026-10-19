import { ExternalLink, Copy, LoaderCircle } from 'lucide-react';
import { Button, ErrorNote } from './components.js';
import type { useConnectionFlow } from './useConnectionFlow.js';
import { errorMessage } from './api.js';

export function ConnectionAuthorization({
  flow,
  canLogin,
}: {
  flow: ReturnType<typeof useConnectionFlow>;
  canLogin: boolean;
}) {
  const waiting = flow.phase === 'waiting';
  return (
    <div className="grid gap-4">
      <div className="rounded-xl border border-blue-100 bg-blue-50/60 p-4">
        <p className="text-sm font-medium text-slate-800">
          {flow.busy
            ? '正在连接…'
            : !canLogin
              ? '连接尚未完成，请检查配置后重试'
              : waiting
                ? '在浏览器完成授权，连接会自动继续'
                : '完成登录后，继续连接'}
        </p>
        {flow.guide?.instructions && (
          <p className="mt-2 text-pretty text-sm leading-6 text-slate-600">
            {flow.guide.instructions}
          </p>
        )}
        {flow.guide?.url && (
          <a
            href={flow.guide.url}
            target="_blank"
            rel="noreferrer"
            className="mt-3 inline-flex items-center gap-1 text-sm font-medium text-blue-700"
          >
            打开登录页面 <ExternalLink size={14} />
          </a>
        )}
        {flow.guide?.command && (
          <div className="mt-3 rounded-lg border border-black/5 bg-white p-3">
            <code className="block break-all text-xs leading-6 text-slate-600">
              {flow.guide.command}
            </code>
            <Button
              type="button"
              variant="ghost"
              className="mt-2"
              onClick={() =>
                void navigator.clipboard
                  .writeText(flow.guide?.command || '')
                  .catch((cause: unknown) => flow.setError(errorMessage(cause)))
              }
            >
              <Copy size={14} /> 复制命令
            </Button>
          </div>
        )}
        {waiting && (
          <p role="status" className="mt-3 flex items-center gap-2 text-xs text-slate-500">
            <LoaderCircle size={14} /> 等待授权结果
          </p>
        )}
      </div>
      <ErrorNote error={flow.error} />
      <div className="flex flex-wrap justify-end gap-2">
        <Button type="button" onClick={flow.edit} disabled={flow.busy}>
          修改配置
        </Button>
        {canLogin && (
          <Button type="button" onClick={() => void flow.authorize()} disabled={flow.busy}>
            {waiting ? '重新登录' : '登录指引'}
          </Button>
        )}
        <Button
          type="button"
          variant="primary"
          disabled={flow.busy}
          onClick={() => void flow.retry()}
        >
          {flow.busy ? '连接中…' : !canLogin ? '重试连接' : '我已登录，继续'}
        </Button>
      </div>
    </div>
  );
}
