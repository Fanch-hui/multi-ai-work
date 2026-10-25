import { useState } from 'react';
import type { Snapshot } from '../../../src/domain/types.js';
import type { Mutate } from './store.js';
import { Button, ErrorNote } from './components.js';
import { ModalPresence } from './ModalPresence.js';
import { UserProfile } from './UserProfile.js';
import { CareerPicker } from './market/CareerPicker.js';
import { useMarket } from './market/useMarket.js';

export function PersonalSettings({ data, mutate }: { data: Snapshot; mutate: Mutate }) {
  const { state, error, refresh } = useMarket();
  const [editingCareer, setEditingCareer] = useState(false);
  const selected =
    state?.professions.filter((item) => state.preferences.professionIds.includes(item.id)) ?? [];

  const renderCareers = () => {
    if (!state && !error) {
      return (
        <div
          role="status"
          aria-label="正在读取职业信息"
          className="h-8 w-48 rounded-lg bg-slate-100"
        />
      );
    }
    if (selected.length) {
      return (
        <div className="flex flex-wrap gap-2">
          {selected.map((item) => (
            <span
              key={item.id}
              className="rounded-lg bg-slate-100 px-3 py-2 text-sm text-slate-700"
            >
              {item.name}
            </span>
          ))}
        </div>
      );
    }
    return state && <p className="text-sm text-slate-600">尚未选择职业或身份</p>;
  };
  return (
    <div className="grid gap-8">
      <UserProfile data={data} mutate={mutate} />
      <section>
        <h2 className="mb-5 text-balance text-base font-semibold">职业信息</h2>
        <div className="grid gap-4 rounded-xl border border-slate-200 bg-white p-5">
          <p className="text-pretty text-sm text-slate-500">
            用于管家回复和智能体推荐，修改后从下一轮对话生效。
          </p>
          {renderCareers()}
          <ErrorNote error={error} />
          <div className="flex justify-end">
            {state ? (
              <Button onClick={() => setEditingCareer(true)}>
                {selected.length ? '修改职业信息' : '选择职业或身份'}
              </Button>
            ) : (
              error && <Button onClick={() => void refresh()}>重新读取</Button>
            )}
          </div>
        </div>
      </section>
      <ModalPresence show={editingCareer && !!state}>
        {editingCareer && state && (
          <CareerPicker
            preferences={state.preferences}
            saveLabel="保存职业信息"
            close={() => setEditingCareer(false)}
            saved={() => {
              setEditingCareer(false);
              void refresh();
            }}
          />
        )}
      </ModalPresence>
    </div>
  );
}
