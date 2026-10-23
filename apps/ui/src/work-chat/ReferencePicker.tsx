import { useEffect, useRef, useState } from 'react';
import { AtSign, X } from 'lucide-react';
import type { Bot } from '../../../../src/domain/types.js';
import type { ConversationReferenceOption } from '../../../../src/domain/conversation-reference.js';
import { Button, ErrorNote } from '../components.js';
import { useResource } from '../local-work/useResource.js';

const labels = { skill: '技能', connector: '连接器', routine: '例行工作', conversation: '任务群' };
export function ReferencePicker({
  conversationId,
  members,
  targets,
  content,
  selected,
  disabled,
  setContent,
  setTargets,
  setSelected,
}: {
  conversationId: string;
  members: Bot[];
  targets: string[];
  content: string;
  selected: ConversationReferenceOption[];
  disabled: boolean;
  setContent(value: string): void;
  setTargets(value: string[]): void;
  setSelected(value: ConversationReferenceOption[]): void;
}) {
  const container = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [dismissed, setDismissed] = useState('');
  const [query, setQuery] = useState('');
  const resource = useResource<ConversationReferenceOption[]>('conversations.references', {
    conversationId,
    targetBotIds: targets,
  });
  const match = /(?:^|\s)([@/])([^\s@/]{0,80})$/.exec(content);
  const typed = match && content !== dismissed;
  const open = expanded || !!typed;
  const filter = (typed ? match[2] : query).toLocaleLowerCase();
  const skillOnly = typed && match[1] === '/';
  const options = (resource.value ?? []).filter(
    (item) =>
      (!skillOnly || item.kind === 'skill') && item.label.toLocaleLowerCase().includes(filter),
  );
  const bots = skillOnly
    ? []
    : members.filter((bot) => bot.name.toLocaleLowerCase().includes(filter));
  useEffect(() => {
    if (!open) return;
    function dismiss(event: PointerEvent | KeyboardEvent) {
      if (
        event instanceof KeyboardEvent
          ? event.key !== 'Escape'
          : container.current?.contains(event.target as Node)
      )
        return;
      setExpanded(false);
      setDismissed(content);
      setQuery('');
    }
    document.addEventListener('pointerdown', dismiss);
    document.addEventListener('keydown', dismiss);
    return () => {
      document.removeEventListener('pointerdown', dismiss);
      document.removeEventListener('keydown', dismiss);
    };
  }, [open, content]);
  function close() {
    setExpanded(false);
    setDismissed(content);
    setQuery('');
  }
  function selectedItem() {
    if (typed) setContent(content.slice(0, content.length - match[0].length) + ' ');
    close();
  }
  return (
    <div ref={container} className="relative">
      <Button
        type="button"
        variant="ghost"
        disabled={disabled}
        aria-label="引用成员、技能和连接器"
        onClick={() => {
          setExpanded(!expanded);
          setDismissed(content);
        }}
        className="size-8 min-h-8 rounded-full p-0"
      >
        <AtSign size={17} />
      </Button>
      {open && (
        <div
          role="dialog"
          aria-label="选择工作引用"
          className="absolute bottom-full left-0 z-20 mb-2 w-72 rounded-xl border border-slate-200 bg-white p-3 shadow-lg"
        >
          <div className="mb-2 flex items-center gap-2">
            <input
              aria-label="搜索工作引用"
              value={typed ? match[2] : query}
              onChange={(e) => {
                setDismissed(content);
                setExpanded(true);
                setQuery(e.target.value);
              }}
              placeholder="搜索成员、技能、连接器…"
              className="min-w-0 flex-1 rounded-lg border p-2 text-xs"
            />
            <Button type="button" variant="ghost" aria-label="关闭引用选择" onClick={close}>
              <X size={14} />
            </Button>
          </div>
          <ErrorNote error={resource.error} />
          <div className="max-h-64 overflow-auto">
            {!skillOnly && members.length > 1 && !filter && (
              <button
                type="button"
                className="block w-full rounded-lg p-2 text-left text-sm hover:bg-slate-50"
                onClick={() => {
                  setTargets(members.map((member) => member.id));
                  selectedItem();
                }}
              >
                @所有人
              </button>
            )}
            {bots.map((bot) => (
              <button
                type="button"
                key={bot.id}
                className="block w-full rounded-lg p-2 text-left text-sm hover:bg-slate-50"
                onClick={() => {
                  setTargets(
                    targets.includes(bot.id)
                      ? targets.filter((id) => id !== bot.id)
                      : [...targets, bot.id],
                  );
                  selectedItem();
                }}
              >
                <span className="mr-2 text-xs text-slate-400">成员</span>
                {bot.name}
                {targets.includes(bot.id) ? ' ✓' : ''}
              </button>
            ))}
            {options.map((option) => (
              <button
                type="button"
                key={`${option.kind}:${option.id}`}
                className="block w-full rounded-lg p-2 text-left text-sm hover:bg-slate-50"
                onClick={() => {
                  if (
                    !selected.some((item) => item.kind === option.kind && item.id === option.id) &&
                    selected.length < 12
                  )
                    setSelected([...selected, option]);
                  selectedItem();
                }}
              >
                <span className="mr-2 text-xs text-slate-400">{labels[option.kind]}</span>
                {option.label}
              </button>
            ))}
            {!options.length && !bots.length && (
              <p className="p-2 text-xs text-slate-500">
                没有匹配的已授权项目。可在成员配置中添加技能与连接器。
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
