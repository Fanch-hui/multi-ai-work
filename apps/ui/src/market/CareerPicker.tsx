import { useState } from 'react';
import { Check } from 'lucide-react';
import { professions, type CareerPreferences } from '../../../../src/domain/market.js';
import { errorMessage, request } from '../api.js';
import { Button, ErrorNote, Modal, cn } from '../components.js';

export function CareerPicker({
  preferences,
  close,
  saved,
  saveLabel = '查看推荐',
}: {
  preferences?: CareerPreferences;
  close: () => void;
  saved: (value: CareerPreferences) => void;
  saveLabel?: string;
}) {
  const [selected, setSelected] = useState(preferences?.professionIds || []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function save(status: 'completed' | 'skipped') {
    setBusy(true);
    setError('');
    try {
      saved(await request<CareerPreferences>('career.save', { professionIds: selected, status }));
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      open
      onOpenChange={(open) => !open && close()}
      title="选择你的职业或身份"
      description="可以多选，随时修改。管家会结合你的职业提供帮助，并为你推荐适合的岗位伙伴。"
      wide
    >
      <div className="grid gap-2 sm:grid-cols-2">
        {professions.map((item) => (
          <button
            key={item.id}
            type="button"
            aria-pressed={selected.includes(item.id)}
            disabled={busy}
            onClick={() =>
              setSelected((values) =>
                values.includes(item.id)
                  ? values.filter((id) => id !== item.id)
                  : [...values, item.id],
              )
            }
            className={cn(
              'flex min-h-12 items-center justify-between rounded-xl border px-4 text-left text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500',
              selected.includes(item.id)
                ? 'border-blue-200 bg-blue-50 text-blue-800'
                : 'border-slate-200 text-slate-700 hover:bg-slate-50',
            )}
          >
            {item.name}
            {selected.includes(item.id) && <Check size={16} />}
          </button>
        ))}
      </div>
      <div className="mt-4">
        <ErrorNote error={error} />
      </div>
      <div className="mt-5 flex justify-between gap-3">
        <Button variant="ghost" disabled={busy} onClick={() => void save('skipped')}>
          暂时跳过
        </Button>
        <Button
          variant="primary"
          disabled={busy || !selected.length}
          onClick={() => void save('completed')}
        >
          {busy ? '保存中…' : saveLabel}
        </Button>
      </div>
    </Modal>
  );
}
