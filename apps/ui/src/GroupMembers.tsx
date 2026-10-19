import { useState } from 'react';
import type { Conversation, Snapshot } from '../../../src/domain/types.js';
import type { Mutate } from './store.js';
import { errorMessage } from './api.js';
import { Button, ErrorNote, Modal } from './components.js';
import Avatar, { UserAvatar } from './Avatar.js';

export function GroupMembers({
  data,
  conversation,
  mutate,
  close,
}: {
  data: Snapshot;
  conversation: Conversation;
  mutate: Mutate;
  close: () => void;
}) {
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const bots = data.bots.filter((bot) =>
    adding
      ? !bot.archived && !conversation.memberIds.includes(bot.id)
      : conversation.memberIds.includes(bot.id),
  );
  const selected = bots
    .filter((bot) => selectedIds.includes(bot.id) && bot.id !== conversation.chiefId)
    .map((bot) => bot.id);
  function changeMode(add: boolean) {
    setAdding(add);
    setSelectedIds([]);
    setError('');
  }
  async function save() {
    if (!selected.length || busy) return;
    const memberIds = adding
      ? [...conversation.memberIds, ...selected]
      : conversation.memberIds.filter((id) => !selected.includes(id));
    setBusy(true);
    setError('');
    try {
      await mutate('conversations.members.update', { id: conversation.id, memberIds });
      close();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal open title={adding ? '添加成员' : '群聊成员'} onOpenChange={(open) => !open && close()}>
      <div className="grid gap-4">
        <div className="flex items-center gap-3 rounded-xl bg-slate-50 px-3 py-3 text-sm text-slate-600">
          <UserAvatar avatar={data.settings.userAvatar} className="size-9" />
          <span>你</span>
          <span className="ml-auto text-xs text-slate-400">可随时参与</span>
        </div>
        <fieldset
          disabled={busy || conversation.archived}
          className="grid max-h-80 gap-2 overflow-auto"
        >
          <legend className="sr-only">{adding ? '选择要添加的成员' : '选择要移除的成员'}</legend>
          {bots.map((bot) => (
            <label
              key={bot.id}
              className="flex cursor-pointer items-center gap-3 rounded-xl px-3 py-2 hover:bg-slate-50"
            >
              <input
                type="checkbox"
                checked={selectedIds.includes(bot.id)}
                disabled={bot.id === conversation.chiefId}
                onChange={() =>
                  setSelectedIds(
                    selectedIds.includes(bot.id)
                      ? selectedIds.filter((id) => id !== bot.id)
                      : [...selectedIds, bot.id],
                  )
                }
              />
              <Avatar bot={bot} className="size-9" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium text-slate-700">
                  {bot.name}
                </span>
                {bot.id !== data.settings.mainBotId && (
                  <span className="block truncate text-xs text-slate-400">{bot.role}</span>
                )}
              </span>
              {bot.id === conversation.chiefId && (
                <span className="text-xs text-slate-400">协调者</span>
              )}
            </label>
          ))}
        </fieldset>
        {adding && !bots.length && (
          <p className="text-sm text-slate-400">所有可用智能体已在群内。</p>
        )}
        <ErrorNote error={error} />
        <div className="flex items-center justify-between gap-2">
          <Button
            variant="ghost"
            disabled={busy || conversation.archived}
            onClick={() => changeMode(!adding)}
          >
            {adding ? '返回群成员' : '添加成员'}
          </Button>
          <div className="flex gap-2">
            <Button onClick={close}>取消</Button>
            <Button
              variant="primary"
              disabled={busy || conversation.archived || !selected.length}
              onClick={() => void save()}
            >
              {busy ? '处理中…' : adding ? '添加成员' : '移除成员'}
            </Button>
          </div>
        </div>
      </div>
    </Modal>
  );
}
