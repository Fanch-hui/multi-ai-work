import { useLayoutEffect, useRef, type ReactNode } from 'react';
import { cn } from './classNames.js';
import { ProgressiveBlur } from './ProgressiveBlur.js';

export function ChatSurface({
  header,
  footer,
  overlap,
  children,
}: {
  header: ReactNode;
  footer?: ReactNode;
  overlap: boolean;
  children: ReactNode;
}) {
  const surfaceRef = useRef<HTMLElement>(null);
  const headerRef = useRef<HTMLElement>(null);
  const footerRef = useRef<HTMLDivElement>(null);
  const hasFooter = !!footer;
  useLayoutEffect(() => {
    const surface = surfaceRef.current;
    if (!surface) return;
    const measure = () => {
      surface.style.setProperty(
        '--chat-header-height',
        `${headerRef.current?.offsetHeight ?? 0}px`,
      );
      surface.style.setProperty(
        '--chat-footer-height',
        `${footerRef.current?.offsetHeight ?? 0}px`,
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    if (headerRef.current) observer.observe(headerRef.current);
    if (footerRef.current) observer.observe(footerRef.current);
    return () => observer.disconnect();
  }, [overlap, hasFooter]);
  return (
    <section ref={surfaceRef} className={cn('chat-surface', overlap && 'chat-surface-overlap')}>
      <header ref={headerRef} className="chat-header">
        <ProgressiveBlur edge="top" />
        {header}
      </header>
      {children}
      {hasFooter && (
        <div ref={footerRef} className="chat-footer">
          {overlap && <ProgressiveBlur edge="bottom" />}
          {footer}
        </div>
      )}
    </section>
  );
}
