import { isChiefProvider } from '../../../src/domain/chief-provider.js';
import { ModalPresence } from './ModalPresence.js';
import { useEffect, useState } from 'react';
import { setNotificationConversation } from './api.js';
import type { Conversation, Snapshot } from '../../../src/domain/types.js';
import type { ConversationHistory, Mutate } from './store.js';
import { Button, Empty, ErrorNote } from './components.js';
import { ConversationRecords } from './ConversationRecords.js';
import { conversationRecordTasks, recordTaskActive } from './conversation-records.js';
import { Composer } from './Composer.js';
import { GroupMembers } from './GroupMembers.js';
import { ConversationActions } from './ConversationActions.js';
import { MessageFeed } from './MessageFeed.js';
import { ChatSurface } from './ChatSurface.js';
import { ChatHeader, type ChatView } from './ChatHeader.js';
import { useConversationRead } from './useConversationRead.js';
import { currentTaskPlan } from './task-plans.js';
import { TaskPlanCard } from './TaskPlanCard.js';
import type { TaskWait } from '../../../src/domain/task-wait.js';
import { useResource } from './local-work/useResource.js';
import { WorkBrowser } from './local-work/WorkBrowser.js';
import { PendingWork } from './local-work/PendingWork.js';
import { TaskWaitCard } from './local-work/TaskWaitCard.js';
import { ComputerPanel } from './computer/ComputerPanel.js';
import { WorkCards } from './work-chat/WorkCards.js';
import { ChiefWorkSelector } from './ChiefWorkSelector.js';
import { ChiefHistoryContinue } from './ChiefHistoryContinue.js';
import {
  chiefConversationIds,
  focusedConversation,
  isChiefHome,
  isChiefHistory,
} from './chief-work.js';
export function Chat({
  data,
  conversation,
  mutate,
  history,
  configure,
  configureChief,
  onSelectConversation,
  sidebarCollapsed,
  onExpandSidebar,
  browserRequest,
}: {
  browserRequest?: number;
  data: Snapshot;
  conversation?: Conversation;
  mutate: Mutate;
  history?: ConversationHistory;
  configure: () => void;
  configureChief: () => void;
  onSelectConversation: (id: string, openBrowser?: boolean) => void;
  sidebarCollapsed: boolean;
  onExpandSidebar: () => void;
}) {
  const [view, setView] = useState<ChatView>('chat');
  const [membersOpen, setMembersOpen] = useState(false);
  const [manageOpen, setManageOpen] = useState(false);
  const [browserOpen, setBrowserOpen] = useState(false);
  const [pendingOpen, setPendingOpen] = useState(false);
  const [computerOpen, setComputerOpen] = useState(false);
  const home = !!conversation && isChiefHome(data, conversation);
  const historyOnly = !!conversation && isChiefHistory(data, conversation);
  const execution = conversation ? focusedConversation(data, conversation) : undefined;
  const workConversations = conversation
    ? chiefConversationIds(data, conversation)
    : new Set<string>();
  useEffect(() => {
    if (browserRequest) setBrowserOpen(true);
  }, [browserRequest]);
  const waitResource = useResource<TaskWait[]>('waits.list');
  const waits =
    waitResource.value?.filter(
      (wait) =>
        wait.status === 'pending' &&
        wait.kind !== 'browser-resource' &&
        wait.kind !== 'computer-resource' &&
        workConversations.has(wait.conversationId),
    ) ?? [];
  const pendingWork =
    data.questions.filter((question) => question.status === 'pending').length +
    data.approvals.filter((approval) => approval.status === 'pending').length +
    (waitResource.value?.filter(
      (wait) =>
        wait.status === 'pending' &&
        wait.kind !== 'browser-resource' &&
        wait.kind !== 'computer-resource',
    ).length ?? 0);
  const chief = data.bots.find((bot) => bot.id === conversation?.chiefId);
  const main = conversation?.purpose === 'chief';
  const connection = data.connections.find((item) => item.id === chief?.connectionId);
  const configured =
    !!connection &&
    (!main || isChiefProvider(connection.provider)) &&
    !!((!home && conversation?.model) || chief?.model);
  useEffect(() => {
    setNotificationConversation(
      view === 'chat' && (!main || configured || historyOnly) ? conversation?.id : undefined,
    );
    return () => setNotificationConversation();
  }, [conversation?.id, view, main, configured, historyOnly]);
  const reading = useConversationRead(
    conversation,
    data.messages,
    view === 'chat' && (!main || configured || historyOnly),
    mutate,
  );
  const tasks = conversation ? conversationRecordTasks(data, conversation) : [];
  const working = tasks.filter(recordTaskActive).length;
  const pending = data.approvals.filter(
    (item) => item.status === 'pending' && tasks.some((task) => task.id === item.taskId),
  ).length;
  if (!conversation)
    return (
      <div className="flex flex-1 items-center justify-center">
        <Empty title="准备你的团队" action={<Button onClick={configure}>连接与设置</Button>} />
      </div>
    );
  const overlap = view === 'chat' && (!main || configured || historyOnly);
  const plan = overlap ? currentTaskPlan(data, conversation) : undefined;
  const renderComposer = () => {
    if (historyOnly)
      return (
        <div className="px-6 max-sm:px-3">
          <ChiefHistoryContinue
            data={data}
            conversation={conversation}
            mutate={mutate}
            onSelectConversation={onSelectConversation}
          />
        </div>
      );
    if (conversation.archived)
      return (
        <div className="px-6 py-4 text-center text-xs text-slate-400">
          此会话已归档。恢复后可以继续对话。
        </div>
      );
    return (
      <Composer
        key={conversation.id}
        data={data}
        conversation={conversation}
        mutate={mutate}
        configureChief={main ? configureChief : undefined}
      />
    );
  };
  const renderConversation = () => {
    if (view === 'records') {
      return (
        <div className="chat-content overflow-auto px-7 py-7">
          <ConversationRecords
            key={conversation.id}
            data={data}
            conversation={conversation}
            mutate={mutate}
          />
        </div>
      );
    }
    if (main && !configured && !historyOnly) {
      return (
        <div className="chat-content flex items-center justify-center px-6">
          <Empty
            title="让管家帮你组织工作"
            description="通过 ChatGPT 或自定义 API 配置管家，即可开始对话、分工和汇总。"
            action={
              <Button variant="primary" onClick={configureChief}>
                配置管家
              </Button>
            }
          />
        </div>
      );
    }
    return (
      <MessageFeed
        key={conversation.id}
        history={history}
        data={data}
        conversation={conversation}
        mutate={mutate}
        onSelectConversation={onSelectConversation}
      />
    );
  };
  return (
    <>
      {view === 'chat' && reading.error && (
        <div
          role="alert"
          className="flex shrink-0 items-center justify-between gap-3 border-b border-amber-200 bg-amber-50 px-6 py-2 text-xs text-amber-800"
        >
          <p>未读状态保存失败：{reading.error}</p>
          <Button onClick={reading.retry}>重试</Button>
        </div>
      )}
      <div className="relative flex min-h-0 flex-1">
        <ChatSurface
          overlap={overlap}
          header={
            <ChatHeader
              conversation={home && chief ? { ...conversation, name: chief.name } : conversation}
              bots={data.bots}
              view={view}
              pending={pending}
              working={working}
              onViewChange={setView}
              sidebarCollapsed={sidebarCollapsed}
              onExpandSidebar={onExpandSidebar}
              onSelectConversation={onSelectConversation}
              onManage={() => setManageOpen(true)}
              onMembers={() => setMembersOpen(true)}
              onBrowser={() => setBrowserOpen((value) => !value)}
              onComputer={() => setComputerOpen(true)}
              onPending={() => setPendingOpen(true)}
              pendingWork={pendingWork}
            />
          }
          footer={
            overlap ? (
              <>
                {waits.length > 0 && (
                  <div className="chat-plan-dock px-6 pt-2 max-sm:px-3">
                    <div className="mx-auto grid max-h-56 w-full max-w-4xl gap-2 overflow-auto">
                      <ErrorNote error={waitResource.error} />
                      {waits.map((wait) => (
                        <TaskWaitCard
                          key={wait.id}
                          wait={wait}
                          mutate={mutate}
                          resolved={waitResource.reload}
                          onBrowser={() => setBrowserOpen(true)}
                          onComputer={() => setComputerOpen(true)}
                        />
                      ))}
                    </div>
                  </div>
                )}
                <div className="chat-plan-dock px-6 pt-2 max-sm:px-3">
                  <div className="mx-auto max-h-56 w-full max-w-4xl overflow-auto">
                    <WorkCards
                      key={conversation.id}
                      data={data}
                      conversationId={execution?.id ?? conversation.id}
                      mutate={mutate}
                      onSelectConversation={onSelectConversation}
                    />
                  </div>
                </div>
                {home && (
                  <div className="chat-plan-dock px-6 pt-2 max-sm:px-3">
                    <ChiefWorkSelector
                      data={data}
                      mutate={mutate}
                      onSelectConversation={onSelectConversation}
                    />
                  </div>
                )}
                {plan && (
                  <div className="chat-plan-dock px-6 pt-2 max-sm:px-3">
                    <div className="mx-auto w-full max-w-4xl">
                      <TaskPlanCard
                        key={plan.id}
                        plan={plan}
                        data={data}
                        onSelectConversation={onSelectConversation}
                      />
                    </div>
                  </div>
                )}
                {renderComposer()}
              </>
            ) : undefined
          }
        >
          {renderConversation()}
        </ChatSurface>
        {browserOpen && (
          <WorkBrowser
            conversationId={execution?.id ?? conversation.id}
            mutate={mutate}
            close={() => setBrowserOpen(false)}
          />
        )}
      </div>
      {pendingOpen && (
        <PendingWork
          data={data}
          mutate={mutate}
          close={() => setPendingOpen(false)}
          onSelectConversation={onSelectConversation}
        />
      )}
      {computerOpen && (
        <ComputerPanel data={data} mutate={mutate} close={() => setComputerOpen(false)} />
      )}
      <ModalPresence show={membersOpen}>
        {membersOpen && (
          <GroupMembers
            data={data}
            conversation={conversation}
            mutate={mutate}
            close={() => setMembersOpen(false)}
          />
        )}
      </ModalPresence>
      <ModalPresence show={manageOpen}>
        {manageOpen && (
          <ConversationActions
            conversation={conversation}
            mutate={mutate}
            close={() => setManageOpen(false)}
          />
        )}
      </ModalPresence>
    </>
  );
}
