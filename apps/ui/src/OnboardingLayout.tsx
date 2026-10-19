import type { ReactNode } from 'react';
import { cn } from './components.js';
import './onboarding.css';

export function OnboardingLayout({
  title,
  description,
  welcome = false,
  wide = false,
  children,
  footer,
}: {
  title: string;
  description: string;
  welcome?: boolean;
  wide?: boolean;
  children: ReactNode;
  footer?: ReactNode;
}) {
  const getContentWidth = () => {
    if (welcome) {
      return 'max-w-sm';
    }
    if (wide) {
      return 'max-w-xl';
    }
    return 'max-w-lg';
  };
  return (
    <main
      className="onboarding flex h-dvh flex-col overflow-auto pb-[env(safe-area-inset-bottom)]"
      data-mac={navigator.platform.includes('Mac')}
    >
      <div className="app-titlebar h-14 shrink-0" />
      <div className="flex flex-1 items-center justify-center px-6 py-10 sm:px-8">
        <section className={cn('w-full min-w-0', getContentWidth())} aria-label={title}>
          <header className={cn('mb-8', welcome && 'text-center')}>
            {welcome ? (
              <img
                src={`${import.meta.env.BASE_URL}app-icon.png`}
                alt=""
                className="mx-auto mb-6 size-12 rounded-xl"
              />
            ) : (
              <div className="mb-7 flex items-center justify-center gap-2 text-sm font-medium text-slate-500">
                <img
                  src={`${import.meta.env.BASE_URL}app-icon.png`}
                  alt=""
                  className="size-6 rounded-md"
                />
                multi-AI work
              </div>
            )}
            <h1
              className={cn(
                'text-balance font-semibold text-slate-900',
                welcome ? 'text-2xl' : 'text-xl',
              )}
            >
              {title}
            </h1>
            <p className="mt-3 text-pretty text-sm leading-6 text-slate-500">{description}</p>
          </header>
          {children}
        </section>
      </div>
      {footer && <footer className="shrink-0 px-6 pb-8 pt-4 text-center">{footer}</footer>}
    </main>
  );
}
