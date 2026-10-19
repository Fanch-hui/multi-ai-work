import { useEffect, useState } from 'react';
import type { MemoryEntry, MemoryRevisionRecord, Snapshot } from '../../../src/domain/types.js';
import { errorMessage, request } from './api.js';
import { timeLabel } from './components.js';
import { MemorySource } from './MemorySource.js';

interface MemoryHistoryResponse {
  memory: MemoryEntry;
  revisions: MemoryRevisionRecord[];
  supersededEntries: MemoryEntry[];
  supersededByEntry?: MemoryEntry;
}

export function MemoryHistory({ memory, data }: { memory: MemoryEntry; data: Snapshot }) {
  const [history, setHistory] = useState<MemoryHistoryResponse>();
  const [status, setStatus] = useState('正在读取历史记录…');

  useEffect(() => {
    let active = true;
    setStatus('正在读取历史记录…');
    void request<MemoryHistoryResponse>('memories.history', { id: memory.id })
      .then((result) => {
        if (!active) return;
        setHistory(result);
        setStatus('');
      })
      .catch((error) => {
        if (active) setStatus(`历史记录读取失败：${errorMessage(error)}`);
      });
    return () => {
      active = false;
    };
  }, [memory.id, memory.revision]);

  return (
    <div className="mt-4 space-y-3 border-t border-slate-100 pt-3">
      {memory.consolidationReason && (
        <p className="text-xs text-slate-500">整理说明：{memory.consolidationReason}</p>
      )}
      {status && <p className="text-xs text-slate-400">{status}</p>}
      {history && (
        <>
          {history.supersededEntries.length > 0 && (
            <div className="space-y-2">
              <p className="text-xs font-medium text-slate-600">
                合并替代的原条目（{history.supersededEntries.length} 条）
              </p>
              {history.supersededEntries.map((oldEntry) => (
                <div
                  key={oldEntry.id}
                  className="rounded-lg border border-slate-100 bg-slate-50/70 p-3"
                >
                  <div className="flex flex-wrap items-center gap-2 text-[11px] text-slate-400">
                    <span>原版本 v{oldEntry.revision}</span>
                    {oldEntry.topic && <span>· {oldEntry.topic}</span>}
                    <span>· {timeLabel(oldEntry.updatedAt)}</span>
                  </div>
                  <p className="mt-1 whitespace-pre-wrap break-words text-xs leading-5 text-slate-600">
                    {oldEntry.content}
                  </p>
                  {oldEntry.sourceIds.map((sourceId) => (
                    <MemorySource
                      key={sourceId}
                      id={sourceId}
                      loaded={data.messages.find((msg) => msg.id === sourceId)}
                      version={oldEntry}
                    />
                  ))}
                </div>
              ))}
            </div>
          )}
          {history.revisions.length > 0 && (
            <div className="space-y-2">
              <p className="text-xs font-medium text-slate-600">
                修订历史（{history.revisions.length} 个历史版本）
              </p>
              {history.revisions.map((rev) => (
                <div key={rev.id} className="rounded-lg border border-slate-100 bg-slate-50/50 p-3">
                  <div className="flex flex-wrap items-center gap-2 text-[11px] text-slate-400">
                    <span>v{rev.revision}</span>
                    {rev.topic && <span>· {rev.topic}</span>}
                    <span>· {actorLabel(rev.updatedBy)}</span>
                    <span>· {timeLabel(rev.createdAt)}</span>
                  </div>
                  <p className="mt-1 whitespace-pre-wrap break-words text-xs leading-5 text-slate-600">
                    {rev.content}
                  </p>
                </div>
              ))}
            </div>
          )}
          {!history.supersededEntries.length && !history.revisions.length && (
            <p className="text-xs text-slate-400">
              暂无早期修订或合并记录（当前 v{memory.revision}）。
            </p>
          )}
        </>
      )}
    </div>
  );
}

function actorLabel(actor?: string) {
  if (actor === 'user') return '用户维护';
  if (actor === 'memory-review') return '后台整理';
  if (actor === 'bot') return '智能体记录';
  return '历史记录';
}
