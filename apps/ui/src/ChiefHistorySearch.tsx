import { useState } from 'react';
import { Search } from 'lucide-react';
import type {
  ChiefHistoryHit,
  ChiefHistoryReadResult,
  ChiefHistorySearchResult,
} from '../../../src/domain/chief-history.js';
import type { Snapshot } from '../../../src/domain/types.js';
import type { Mutate } from './store.js';
import { errorMessage, request } from './api.js';
import { Button, ErrorNote, timeLabel } from './components.js';
import { composerDrafts } from './composer-drafts.js';
import { MessageArtifacts } from './MessageArtifacts.js';

export function ChiefHistorySearch({
  query,
  workspaceId,
  data,
  mutate,
  onContinue,
}: {
  query: string;
  workspaceId: string;
  data: Snapshot;
  mutate: Mutate;
  onContinue: () => void;
}) {
  const [results, setResults] = useState<ChiefHistorySearchResult>();
  const [read, setRead] = useState<ChiefHistoryReadResult>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError('');
    try {
      await action();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }
  async function search() {
    const result = await request<ChiefHistorySearchResult>('chief.history.search', {
      query: query.trim(),
      workspaceId: workspaceId || undefined,
      limit: 20,
    });
    setResults(result);
    setRead(undefined);
  }
  async function continueWork(hit: ChiefHistoryHit) {
    composerDrafts.edit(data.chief!.homeConversationId, {
      targetContextId: hit.contextId,
      replyToMessageId: hit.messageId,
    });
    onContinue();
  }
  return (
    <section className="grid gap-3 border-t border-slate-100 pt-3" aria-label="历史正文检索">
      <Button disabled={busy || !query.trim()} onClick={() => void run(search)}>
        <Search size={14} />
        搜索历史正文
      </Button>
      <ErrorNote error={error} />
      {results && (
        <div className="grid max-h-80 gap-3 overflow-auto">
          {!results.items.length && <p className="text-xs text-slate-500">没有匹配的历史消息</p>}
          {results.partial && (
            <p className="text-xs text-slate-400">历史索引正在整理，可稍后再次搜索。</p>
          )}
          {results.items.map((hit) => (
            <article key={hit.messageId} className="min-w-0 rounded-lg bg-slate-50 p-3">
              <p className="truncate text-sm font-medium">{hit.title}</p>
              <p className="mt-1 text-xs text-slate-400">{timeLabel(hit.createdAt)}</p>
              <p className="mt-2 line-clamp-3 whitespace-pre-wrap text-xs leading-5 text-slate-600">
                {hit.content}
              </p>
              <div className="mt-2 flex gap-2">
                <Button
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      setRead(
                        await request<ChiefHistoryReadResult>('chief.history.read', {
                          messageId: hit.messageId,
                          limit: 7,
                        }),
                      );
                    })
                  }
                >
                  展开原文
                </Button>
                <Button disabled={busy} onClick={() => void run(() => continueWork(hit))}>
                  在管家继续
                </Button>
              </div>
              {read?.anchorMessageId === hit.messageId && (
                <div className="mt-3 grid gap-3 border-t border-slate-200 pt-3">
                  {read.messages.map((message) => {
                    const room = data.conversations.find(
                      (item) => item.id === message.conversationId,
                    );
                    return (
                      <div key={message.messageId} data-history-message-id={message.messageId}>
                        <p className="text-xs text-slate-400">
                          {message.authorType === 'user' ? '你' : '管家'} ·{' '}
                          {timeLabel(message.createdAt)}
                        </p>
                        <p className="mt-1 whitespace-pre-wrap break-words text-sm leading-6 text-slate-700">
                          {message.content}
                        </p>
                        {room && (
                          <MessageArtifacts
                            ids={message.artifactIds}
                            user={message.authorType === 'user'}
                            conversation={room}
                            data={data}
                            mutate={mutate}
                          />
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </article>
          ))}
        </div>
      )}
    </section>
  );
}
