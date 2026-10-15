import { useLayoutEffect, useRef, type ReactNode } from 'react';
import { ProgressiveBlur } from './ProgressiveBlur.js';
import { cn } from './classNames.js';

export function PageSurface({ header, headerLeading, children, contentClassName }: {
  header: ReactNode; headerLeading?: ReactNode; children: ReactNode; contentClassName?: string;
}) {
  const surface = useRef<HTMLElement>(null);
  const top = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    const measure = () => surface.current?.style.setProperty('--page-header-height', `${top.current?.offsetHeight ?? 0}px`);
    measure();
    const observer = new ResizeObserver(measure);
    if (top.current) observer.observe(top.current);
    return () => observer.disconnect();
  }, []);
  return <section ref={surface} className="page-surface">
    <header ref={top} className="page-surface-header"><ProgressiveBlur edge="top" />{headerLeading}{header}</header>
    <div className={cn('page-surface-content', contentClassName)}>{children}</div>
  </section>;
}
