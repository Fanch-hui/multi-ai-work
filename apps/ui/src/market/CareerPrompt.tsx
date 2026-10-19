import { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import type { MarketState } from '../../../../src/domain/market.js';
import { errorMessage, request } from '../api.js';
import { Button, ErrorNote } from '../components.js';

export function CareerPrompt({ open }: { open: () => void }) {
  const [pending, setPending] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    let alive = true;
    void request<MarketState>('market.list')
      .then((state) => {
        if (alive) setPending(state.preferences.status === 'pending');
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);
  if (!pending || dismissed) return null;
  return (
    <div className="flex shrink-0 items-center gap-3 border-b border-slate-100 bg-slate-50 px-6 py-2 text-sm text-slate-500">
      <div className="mr-auto">
        <p>选择职业，发现适合你的智能体伙伴。</p>
        <ErrorNote error={error} />
      </div>
      <Button
        variant="ghost"
        onClick={() => {
          setDismissed(true);
          open();
        }}
      >
        查看推荐
      </Button>
      <Button
        variant="ghost"
        className="size-8 min-h-8 p-0"
        aria-label="关闭职业推荐提示"
        onClick={() => {
          void request('career.save', { professionIds: [], status: 'skipped' })
            .then(() => setDismissed(true))
            .catch((cause) => setError(errorMessage(cause)));
        }}
      >
        <X size={14} />
      </Button>
    </div>
  );
}
