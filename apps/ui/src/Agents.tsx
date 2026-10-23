import { ModalPresence } from './ModalPresence.js';
import { PageSurface } from './PageSurface.js';
import { useState, type ReactNode } from 'react';
import { Plus, Pencil, Brain, Copy, MessageSquare, Store } from 'lucide-react';
import type { Bot, Snapshot } from '../../../src/domain/types.js';
import type { Mutate } from './store.js';
import { Badge, Button, Empty, PageHeader, ErrorNote } from './components.js';
import Avatar from './Avatar.js';
import { errorMessage } from './api.js';
import { BotEditor } from './BotEditor.js';
import { BotContext } from './BotContext.js';
import { modelLabel } from './model-label.js';
import { Routines } from './local-work/Routines.js';
import { BrowserProfiles } from './local-work/BrowserProfiles.js';
import { PendingWork } from './local-work/PendingWork.js';
export function Agents({
  data,
  mutate,
  openChief,
  configureConnection,
  headerLeading,
  openMarket,
  onSelectConversation,
}: {
  onSelectConversation: (id: string, openBrowser?: boolean) => void;
  openMarket: () => void;
  headerLeading?: ReactNode;
  data: Snapshot;
  mutate: Mutate;
  openChief: () => void;
  configureConnection: () => void;
}) {
  const [editing, setEditing] = useState<Bot | 'new'>();
  const [showArchived, setShowArchived] = useState(false);
  const [inspecting, setInspecting] = useState<Bot>();
  const [error, setError] = useState('');
  const [workPanel, setWorkPanel] = useState<'routines' | 'browser' | 'pending'>();
  const chief = data.bots.find((bot) => bot.id === data.settings.mainBotId);
  const bots = data.bots.filter((bot) => bot.id !== chief?.id && (showArchived || !bot.archived));
  return (
    <PageSurface
      headerLeading={headerLeading}
      contentClassName="px-7 pb-8"
      header={
        <PageHeader
          title="我的团队"
          action={
            <div className="flex gap-2">
              <Button onClick={openMarket}>
                <Store size={16} />
                从市场添加
              </Button>
              <Button variant="primary" onClick={() => setEditing('new')}>
                <Plus size={16} />
                新建智能体
              </Button>
            </div>
          }
        />
      }
    >
      <div>
        <ErrorNote error={error} />
        <div className="mb-5 flex flex-wrap gap-2" aria-label="团队工作">
          <Button onClick={() => setWorkPanel('routines')}>例行工作</Button>
          <Button onClick={() => setWorkPanel('pending')}>待我处理</Button>
          <Button onClick={() => setWorkPanel('browser')}>工作浏览器</Button>
        </div>
        {chief && (
          <article className="mb-8 flex flex-wrap items-center justify-between gap-6 rounded-2xl bg-slate-50 p-6">
            <div className="flex items-center gap-5">
              <Avatar bot={chief} avatar={chief.avatar || 'owl'} className="size-20 rounded-3xl" />
              <div>
                <h2 className="font-semibold">
                  {chief.name}
                  <span className="ml-3 text-xs font-normal text-blue-600">主智能体</span>
                </h2>
                <p className="mt-2 text-xs text-slate-400">
                  {modelLabel(
                    data.connections.find((item) => item.id === chief.connectionId),
                    chief.model,
                  )}
                </p>
              </div>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button onClick={() => setInspecting(chief)}>
                <Brain size={15} />
                上下文与记忆
              </Button>
              <Button onClick={() => setEditing(chief)}>
                <Pencil size={15} />
                配置
              </Button>
              <Button variant="primary" onClick={openChief}>
                <MessageSquare size={15} />
                找管家
              </Button>
            </div>
          </article>
        )}
        <div className="mb-5 flex items-center justify-between">
          <p className="text-sm text-slate-500">
            <span className="tabular-nums text-slate-900">
              {data.bots.filter((bot) => !bot.archived && bot.id !== chief?.id).length}
            </span>{' '}
            位活跃成员
          </p>
          <label className="flex items-center gap-2 text-sm text-slate-500">
            <input
              type="checkbox"
              checked={showArchived}
              onChange={(event) => setShowArchived(event.target.checked)}
            />
            显示已归档
          </label>
        </div>
        {bots.length ? (
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {bots.map((bot) => {
              const connection = data.connections.find((item) => item.id === bot.connectionId);
              return (
                <article key={bot.id} className="rounded-2xl border border-slate-200 bg-white p-6">
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex min-w-0 items-center gap-4">
                      <Avatar bot={bot} className="size-16 rounded-2xl" />
                      <div>
                        <h2 className="truncate text-balance font-semibold text-slate-900">
                          {bot.name}
                        </h2>
                        <p className="mt-1 line-clamp-2 text-xs leading-5 text-slate-500">
                          {bot.role}
                        </p>
                      </div>
                    </div>
                    <Button
                      variant="ghost"
                      className="size-8 min-h-8 p-0"
                      aria-label={`编辑${bot.name}`}
                      onClick={() => setEditing(bot)}
                    >
                      <Pencil size={16} />
                    </Button>
                  </div>
                  <p className="mt-5 line-clamp-2 min-h-12 text-pretty text-sm leading-6 text-slate-500">
                    {bot.instructions || '尚未设置工作指令'}
                  </p>
                  <div className="mt-4 flex items-center justify-between border-t border-slate-100 pt-4">
                    <div className="min-w-0">
                      <p className="truncate text-xs font-medium text-slate-700">
                        {connection?.name || '连接已删除'}
                      </p>
                      <p className="mt-1 truncate text-xs text-slate-400">
                        {modelLabel(connection, bot.model)}
                      </p>
                    </div>
                    <Badge status={bot.archived ? 'archived' : connection?.status}>
                      {bot.archived ? '已归档' : undefined}
                    </Badge>
                  </div>
                  <div className="mt-4 flex items-center gap-3">
                    <Button
                      variant="ghost"
                      className="px-0 text-xs"
                      onClick={() => setInspecting(bot)}
                    >
                      <Brain size={14} />
                      上下文与记忆
                    </Button>
                    <Button
                      variant="ghost"
                      className="ml-auto size-8 min-h-8 p-0"
                      aria-label={`复制${bot.name}`}
                      onClick={() => {
                        void mutate('bots.clone', { id: bot.id }).catch((cause) =>
                          setError(errorMessage(cause)),
                        );
                      }}
                    >
                      <Copy size={14} />
                    </Button>
                  </div>
                </article>
              );
            })}
          </div>
        ) : (
          <Empty
            title="添加团队成员"
            description="为团队添加一位伙伴，由管家组织协作。"
            action={
              <Button variant="primary" onClick={() => setEditing('new')}>
                <Plus size={16} />
                新建智能体
              </Button>
            }
          />
        )}
      </div>
      {workPanel === 'routines' && (
        <Routines
          data={data}
          mutate={mutate}
          close={() => setWorkPanel(undefined)}
          onSelectConversation={onSelectConversation}
        />
      )}
      {workPanel === 'pending' && (
        <PendingWork
          data={data}
          mutate={mutate}
          close={() => setWorkPanel(undefined)}
          onSelectConversation={onSelectConversation}
        />
      )}
      {workPanel === 'browser' && (
        <BrowserProfiles data={data} mutate={mutate} close={() => setWorkPanel(undefined)} />
      )}
      <ModalPresence show={!!editing}>
        {editing && (
          <BotEditor
            key={typeof editing === 'string' ? 'new' : editing.id}
            bot={editing === 'new' ? undefined : editing}
            data={data}
            mutate={mutate}
            configureConnection={configureConnection}
            close={() => setEditing(undefined)}
          />
        )}
      </ModalPresence>
      <ModalPresence show={!!inspecting}>
        {inspecting && (
          <BotContext bot={inspecting} data={data} close={() => setInspecting(undefined)} />
        )}
      </ModalPresence>
    </PageSurface>
  );
}
