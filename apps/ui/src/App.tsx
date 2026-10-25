import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { PanelLeft, RefreshCw } from 'lucide-react';
import { useTeamStore } from './store.js';
import { subscribeNavigation } from './api.js';
import { Button } from './components.js';
import { Chat } from './Chat.js';
import { MainSidebar, type Page } from './MainSidebar.js';
import { BotEditor } from './BotEditor.js';
import { ConversationEditor } from './ConversationEditor.js';
import { Onboarding } from './Onboarding.js';
import { isChiefProvider } from '../../../src/domain/chief-provider.js';
import { ModalPresence } from './ModalPresence.js';
import { CareerPrompt } from './market/CareerPrompt.js';
import { useAttachmentDraftRetention } from './useAttachmentDraftRetention.js';
const Market = lazy(() => import('./Market.js').then((module) => ({ default: module.Market })));
const Agents = lazy(() => import('./Agents.js').then((module) => ({ default: module.Agents })));
const Tasks = lazy(() => import('./Tasks.js').then((module) => ({ default: module.Tasks })));
const Memory = lazy(() => import('./Memory.js').then((module) => ({ default: module.Memory })));
const Settings = lazy(() =>
  import('./Settings.js').then((module) => ({ default: module.Settings })),
);

export function App() {
  useAttachmentDraftRetention();
  const { data, error, refresh, mutate, selectConversation, nextBefore, loadingHistory, loadMore } =
    useTeamStore();
  const [page, setPage] = useState<Page>('chat');
  const [selected, setSelected] = useState('');
  const [voiceRequest, setVoiceRequest] = useState<{ conversationId: string; token: number }>();
  const [voiceActive, setVoiceActive] = useState(false);
  const voiceSequence = useRef(0);
  const voiceHandled = useCallback((token: number) => {
    setVoiceRequest((request) => (request?.token === token ? undefined : request));
  }, []);
  const [browserRequest, setBrowserRequest] = useState<{
    conversationId: string;
    revision: number;
  }>();
  const [collapsed, setCollapsed] = useState(
    () => localStorage.getItem('sidebar-collapsed') === 'true',
  );
  const [configureChief, setConfigureChief] = useState(false);
  const [create, setCreate] = useState(false);
  const [careerTrigger, setCareerTrigger] = useState(false);
  const [onboardingActive, setOnboardingActive] = useState(false);
  const [navigationError, setNavigationError] = useState('');
  const mainBot = data?.bots.find((bot) => bot.id === data.settings.mainBotId);
  const chiefConnection = data?.connections.find((item) => item.id === mainBot?.connectionId);
  const chiefConfigured =
    !!mainBot?.model && !!chiefConnection && isChiefProvider(chiefConnection.provider);
  const conversation =
    data?.conversations.find((item) => item.id === selected) ||
    data?.conversations.find(
      (item) => item.id === data.settings.mainConversationId && !item.archived,
    ) ||
    data?.conversations.find((item) => !item.archived);
  useEffect(() => {
    if (
      voiceRequest &&
      (page !== 'chat' ||
        conversation?.id !== voiceRequest.conversationId ||
        configureChief ||
        create ||
        onboardingActive ||
        data?.settings.onboardingStatus === 'pending')
    ) {
      setVoiceRequest(undefined);
    }
  }, [
    voiceRequest,
    page,
    conversation?.id,
    configureChief,
    create,
    onboardingActive,
    data?.settings.onboardingStatus,
  ]);
  useEffect(
    () =>
      subscribeNavigation((id) => {
        openConversation(id);
      }),
    [data?.conversations, data?.chief],
  );
  useEffect(() => {
    selectConversation(conversation?.id);
  }, [conversation?.id, selectConversation]);
  function toggleSidebar() {
    const next = !collapsed;
    setCollapsed(next);
    localStorage.setItem('sidebar-collapsed', String(next));
  }
  function startVoiceConversation() {
    const homeId = data?.settings.mainConversationId;
    if (!homeId) return;
    if (!chiefConfigured) {
      setConfigureChief(true);
      return;
    }
    const alreadyActive = page === 'chat' && conversation?.id === homeId && voiceActive;
    openConversation(homeId);
    if (!alreadyActive) setVoiceRequest({ conversationId: homeId, token: ++voiceSequence.current });
  }
  function openConversation(id: string, openBrowser = false) {
    const room = data?.conversations.find((item) => item.id === id);
    if (room?.timelineOnly && room.chiefHomeId) {
      openConversation(room.chiefHomeId, openBrowser);
      return;
    }
    if (room?.chiefContextId && ['work', 'routine'].includes(room.chiefRole ?? '') && data?.chief) {
      const home = data.chief.homeConversationId;
      void mutate('chief.contexts.activate', { id: room.chiefContextId })
        .then(() => {
          setNavigationError('');
          setBrowserRequest(
            openBrowser ? { conversationId: home, revision: Date.now() } : undefined,
          );
          setSelected(home);
          setPage('chat');
        })
        .catch((cause) =>
          setNavigationError(cause instanceof Error ? cause.message : String(cause)),
        );
      return;
    }
    setNavigationError('');
    setBrowserRequest(openBrowser ? { conversationId: id, revision: Date.now() } : undefined);
    setSelected(id);
    setPage('chat');
  }
  const headerLeading = collapsed ? (
    <div className="app-titlebar app-titlebar-collapsed flex h-14 items-center px-4">
      <Button
        variant="ghost"
        className="size-8 min-h-8 p-0"
        aria-label="展开侧边栏"
        title="展开侧边栏"
        onClick={toggleSidebar}
      >
        <PanelLeft size={18} />
      </Button>
    </div>
  ) : undefined;
  if (!data && !error)
    return (
      <main className="flex h-dvh bg-white">
        <Loading />
      </main>
    );
  if (
    data &&
    (onboardingActive ||
      data.settings.onboardingStatus === 'pending' ||
      (configureChief && !chiefConfigured))
  ) {
    return (
      <Onboarding
        data={data}
        mutate={mutate}
        preparing={() => setOnboardingActive(true)}
        finished={(id) => {
          setConfigureChief(false);
          setOnboardingActive(false);
          if (id) openConversation(id);
        }}
      />
    );
  }
  const renderPage = () => {
    if (!data) {
      if (error) {
        return (
          <div className="flex flex-1 items-center justify-center p-8">
            <div className="max-w-md">
              <h1 className="text-lg font-semibold">无法连接工作台</h1>
              <p role="alert" className="my-4 text-sm leading-6 text-slate-500">
                {error}
              </p>
              <Button variant="primary" onClick={() => void refresh()}>
                <RefreshCw size={15} />
                重新连接
              </Button>
            </div>
          </div>
        );
      }
      return <Loading />;
    }
    if (page === 'chat') {
      return (
        <Chat
          key={conversation?.id}
          data={data}
          conversation={conversation}
          mutate={mutate}
          history={{ hasMore: !!nextBefore, loading: loadingHistory, loadMore }}
          configure={() => setPage('settings')}
          configureChief={() => setConfigureChief(true)}
          onSelectConversation={openConversation}
          sidebarCollapsed={collapsed}
          browserRequest={
            browserRequest?.conversationId === conversation?.id
              ? browserRequest?.revision
              : undefined
          }
          onExpandSidebar={toggleSidebar}
          conversationStartToken={
            voiceRequest?.conversationId === conversation?.id ? voiceRequest?.token : undefined
          }
          onConversationStartHandled={voiceHandled}
          onConversationStateChange={setVoiceActive}
        />
      );
    }
    if (page === 'market') {
      return (
        <Market
          data={data}
          mutate={mutate}
          headerLeading={headerLeading}
          configureConnection={() => setPage('settings')}
          careerTrigger={careerTrigger}
          careerHandled={() => setCareerTrigger(false)}
        />
      );
    }
    if (page === 'agents') {
      return (
        <Agents
          data={data}
          mutate={mutate}
          headerLeading={headerLeading}
          openChief={() => openConversation(data.settings.mainConversationId || '')}
          openMarket={() => setPage('market')}
          onSelectConversation={openConversation}
          configureConnection={() => setPage('settings')}
        />
      );
    }
    if (page === 'tasks') {
      return <Tasks data={data} mutate={mutate} headerLeading={headerLeading} />;
    }
    if (page === 'memory') {
      return <Memory data={data} mutate={mutate} headerLeading={headerLeading} />;
    }
    return (
      <Settings
        data={data}
        mutate={mutate}
        headerLeading={headerLeading}
        onSelectConversation={openConversation}
      />
    );
  };
  return (
    <main
      data-mac={navigator.platform.includes('Mac')}
      className="flex h-dvh w-full min-h-0 min-w-0 overflow-hidden bg-white pb-[env(safe-area-inset-bottom)]"
    >
      <MainSidebar
        data={data}
        page={page}
        selectedId={conversation?.id}
        collapsed={collapsed}
        onPage={setPage}
        onSelect={openConversation}
        onVoiceConversation={startVoiceConversation}
        voiceActive={
          page === 'chat' && conversation?.id === data?.settings.mainConversationId && voiceActive
        }
        onCreateGroup={() => setCreate(true)}
        mutate={mutate}
        onCollapse={toggleSidebar}
      />
      <div className="app-content flex min-w-0 flex-1 flex-col">
        {(error || navigationError) && data && (
          <div
            role="alert"
            className="flex shrink-0 items-center justify-between gap-3 border-b border-amber-200 bg-amber-50 px-6 py-3 text-sm text-amber-800"
          >
            <p>{error || navigationError}</p>
            <Button onClick={() => void refresh()}>
              <RefreshCw size={14} />
              重新连接
            </Button>
          </div>
        )}
        {data && page !== 'market' && (
          <CareerPrompt
            open={() => {
              setPage('market');
              setCareerTrigger(true);
            }}
          />
        )}
        <Suspense fallback={<Loading />}>{renderPage()}</Suspense>
      </div>
      <ModalPresence show={configureChief && !!mainBot && !!data}>
        {mainBot && data && (
          <BotEditor
            bot={mainBot}
            data={data}
            mutate={mutate}
            close={() => setConfigureChief(false)}
            configureConnection={() => setPage('settings')}
          />
        )}
      </ModalPresence>
      <ModalPresence show={create && !!data}>
        {data && (
          <ConversationEditor
            data={data}
            mutate={mutate}
            close={() => setCreate(false)}
            created={openConversation}
            configure={() => setPage('settings')}
          />
        )}
      </ModalPresence>
    </main>
  );
}
function Loading() {
  return (
    <div aria-busy="true" aria-label="正在加载工作台" className="flex flex-1 flex-col gap-6 p-8">
      <div className="h-6 w-40 rounded bg-slate-100" />
      <div className="mx-auto mt-10 w-full max-w-3xl space-y-4">
        <div className="h-16 rounded-xl bg-slate-50" />
        <div className="h-4 w-2/3 rounded bg-slate-100" />
      </div>
      <p className="sr-only">正在加载</p>
    </div>
  );
}
