import { useEffect, useState } from 'react';
import { Check } from 'lucide-react';
import {
  professions,
  type CareerPreferences,
  type MarketState,
} from '../../../src/domain/market.js';
import { errorMessage, request } from './api.js';
import type { Mutate } from './store.js';
import { Button, ErrorNote, cn } from './components.js';

export function OnboardingCareer({ mutate, finished }: { mutate: Mutate; finished: () => void }) {
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    void request<MarketState>('market.list')
      .then((state) => {
        if (active) setSelected(state.preferences.professionIds);
      })
      .catch((cause) => {
        if (active) setError(errorMessage(cause));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  async function save(status: CareerPreferences['status']) {
    setBusy(true);
    setError('');
    try {
      await mutate('career.save', { professionIds: selected, status });
      finished();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="grid gap-5">
      <div className="grid gap-2 sm:grid-cols-2" aria-busy={loading}>
        {professions.map((item) => (
          <button
            key={item.id}
            type="button"
            aria-pressed={selected.includes(item.id)}
            disabled={busy || loading}
            onClick={() =>
              setSelected((values) =>
                values.includes(item.id)
                  ? values.filter((id) => id !== item.id)
                  : [...values, item.id],
              )
            }
            className={cn(
              'flex min-h-12 items-center justify-between gap-2 rounded-xl border px-4 py-2 text-left text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 disabled:opacity-40',
              selected.includes(item.id)
                ? 'border-blue-200 bg-blue-50 text-blue-800'
                : 'border-slate-200 text-slate-700 hover:bg-slate-50',
            )}
          >
            {item.name}
            {selected.includes(item.id) && <Check size={16} className="shrink-0" />}
          </button>
        ))}
      </div>
      <ErrorNote error={error} />
      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-black/5 pt-5">
        <Button variant="ghost" disabled={busy} onClick={() => void save('skipped')}>
          暂时跳过
        </Button>
        <Button
          variant="primary"
          disabled={busy || loading || !selected.length}
          onClick={() => void save('completed')}
        >
          {busy ? '保存中…' : '进入工作台'}
        </Button>
      </div>
    </div>
  );
}
