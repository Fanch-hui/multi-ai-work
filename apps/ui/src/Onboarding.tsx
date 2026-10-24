import { useState } from 'react';
import { ArrowLeft, ArrowRight, Check, ExternalLink, SlidersHorizontal } from 'lucide-react';
import type { Connection, Conversation, Snapshot } from '../../../src/domain/types.js';
import { isChiefProvider } from '../../../src/domain/chief-provider.js';
import type { Mutate } from './store.js';
import { errorMessage } from './api.js';
import { Button, ErrorNote } from './components.js';
import { ConnectionEditor } from './ConnectionEditor.js';
import { OnboardingProfile } from './OnboardingProfile.js';
import { OnboardingCareer } from './OnboardingCareer.js';
import { useOnboardingLogin } from './useOnboardingLogin.js';
import { OnboardingLayout } from './OnboardingLayout.js';

export function Onboarding({
  data,
  mutate,
  preparing,
  finished,
}: {
  data: Snapshot;
  mutate: Mutate;
  preparing: () => void;
  finished: (conversationId?: string) => void;
}) {
  const [custom, setCustom] = useState(false);
  const [connection, setConnection] = useState<Connection>();
  const [conversationId, setConversationId] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const login = useOnboardingLogin(data.connections, mutate, setConnection);
  const existing = data.connections.filter(
    (item) => isChiefProvider(item.provider) && item.status === 'ready',
  );
  async function skip() {
    setBusy(true);
    setError('');
    try {
      await mutate('onboarding.skip');
      finished();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }
  async function complete(input: Record<string, unknown>) {
    preparing();
    setBusy(true);
    setError('');
    try {
      const room = await mutate<Conversation>('onboarding.complete', { input });
      setConversationId(room.id);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }
  const getCurrentStep = () => {
    if (conversationId) {
      return 2;
    }
    if (connection) {
      return 1;
    }
    return 0;
  };
  const step = getCurrentStep();
  const titles = [
    custom ? '连接自定义 API' : '欢迎使用 multi-AI work',
    '配置你的管家',
    '选择你的职业或身份',
  ];
  const descriptions = [
    '登录后，从一段对话开始，让管家帮你安排工作、组织协作并交付成果。',
    '设置名字、头像和模型，之后随时可以在我的团队中调整。',
    '可以多选。管家会结合你的职业提供帮助，并为你推荐适合的团队成员。',
  ];
  const renderSetup = () => {
    if (conversationId) {
      return <OnboardingCareer mutate={mutate} finished={() => finished(conversationId)} />;
    }
    if (connection) {
      return (
        <>
          <div className="mb-5 flex min-w-0 items-center gap-2 rounded-lg bg-slate-50 px-3 py-2 text-sm text-slate-600">
            <Check size={15} className="shrink-0 text-blue-600" />
            <span className="min-w-0 truncate">{connection.name} 已连接</span>
            <Button
              type="button"
              variant="ghost"
              className="ml-auto min-h-8 text-xs"
              disabled={busy}
              onClick={() => {
                setConnection(undefined);
                setCustom(false);
                setError('');
              }}
            >
              更换
            </Button>
          </div>
          <OnboardingProfile
            data={data}
            connection={connection}
            mutate={mutate}
            busy={busy}
            onSubmit={complete}
          />
        </>
      );
    }
    if (custom) {
      return (
        <>
          <Button
            variant="ghost"
            className="mb-5 -ml-3 self-start"
            onClick={() => setCustom(false)}
          >
            <ArrowLeft size={15} />
            选择连接方式
          </Button>
          <ConnectionEditor
            connections={data.connections}
            mutate={mutate}
            close={() => setCustom(false)}
            initialProvider="custom"
            inline
            connected={setConnection}
          />
        </>
      );
    }
    return (
      <OnboardingSignIn
        login={login}
        existing={existing}
        useConnection={setConnection}
        useCustom={() => setCustom(true)}
      />
    );
  };
  return (
    <OnboardingLayout
      title={titles[step]}
      description={
        custom && !connection ? '填写服务地址与认证信息，连接后继续配置管家。' : descriptions[step]
      }
      welcome={step === 0 && !custom}
      wide={step === 2}
      footer={
        !conversationId && (
          <>
            <Button variant="ghost" disabled={busy || login.busy} onClick={() => void skip()}>
              稍后设置
            </Button>
            <p className="mt-1 text-xs text-slate-400">之后可以在我的团队中配置管家。</p>
          </>
        )
      }
    >
      {renderSetup()}
      <div className="mt-5">
        <ErrorNote error={error} />
      </div>
    </OnboardingLayout>
  );
}

function OnboardingSignIn({
  login,
  existing,
  useConnection,
  useCustom,
}: {
  login: ReturnType<typeof useOnboardingLogin>;
  existing: Connection[];
  useConnection: (connection: Connection) => void;
  useCustom: () => void;
}) {
  const getLoginLabel = () => {
    if (login.phase === 'starting') {
      return '正在打开登录…';
    }
    if (login.phase === 'checking') {
      return '正在连接…';
    }
    return 'Sign in ChatGPT';
  };
  const getLoginStatusLabel = () => {
    if (login.phase === 'error') {
      return '连接未完成，请重试。';
    }
    if (login.phase === 'checking') {
      return '正在读取可用模型，完成后继续配置管家。';
    }
    return '在浏览器完成登录，回来后会自动继续。';
  };
  return (
    <div className="grid gap-3">
      <Button
        variant="primary"
        disabled={login.busy}
        className="h-11 justify-center px-3"
        onClick={() => void login.start()}
      >
        {getLoginLabel()}
      </Button>
      {login.phase !== 'idle' && (
        <div className="rounded-lg border border-black/5 bg-slate-50 p-4">
          <p role="status" className="text-pretty text-sm leading-6 text-slate-600">
            {getLoginStatusLabel()}
          </p>
          <div className="mt-3">
            <ErrorNote error={login.error} />
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            {login.url && (
              <a
                href={login.url}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 text-sm text-blue-700"
              >
                打开登录页面
                <ExternalLink size={14} />
              </a>
            )}
            <Button variant="ghost" disabled={login.busy} onClick={() => void login.retry()}>
              检测连接
            </Button>
            <Button variant="ghost" disabled={login.busy} onClick={login.reset}>
              取消
            </Button>
          </div>
        </div>
      )}
      <Button
        disabled={login.busy}
        className="h-11 justify-center px-3"
        onClick={() => {
          login.reset();
          useCustom();
        }}
      >
        <SlidersHorizontal size={16} />
        使用自定义 API
      </Button>
      {!!existing.length && (
        <div className="mt-3 border-t border-black/5 pt-4">
          <p className="mb-2 text-xs text-slate-500">使用已有连接</p>
          {existing.map((item) => (
            <Button
              key={item.id}
              disabled={login.busy}
              variant="ghost"
              className="w-full justify-between"
              onClick={() => {
                login.reset();
                useConnection(item);
              }}
            >
              {item.name}
              <ArrowRight size={15} />
            </Button>
          ))}
        </div>
      )}
    </div>
  );
}
