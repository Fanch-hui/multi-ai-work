import { useLayoutEffect, useRef } from 'react';
import { ScrollFollow } from './scroll-follow.js';

export function useScrollFollow(conversationId: string) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const feed = scrollRef.current;
    const content = contentRef.current;
    if (!feed || !content) return;
    const follow = new ScrollFollow();
    follow.reset(feed);
    const observer = new ResizeObserver(() => follow.layoutChanged(feed));
    observer.observe(feed);
    observer.observe(content);
    let touchY: number | undefined;
    const wheel = (event: WheelEvent) => follow.userIntent(event.deltaY, feed);
    const touchStart = (event: TouchEvent) => { touchY = event.touches[0]?.clientY; };
    const touchMove = (event: TouchEvent) => {
      const nextY = event.touches[0]?.clientY;
      if (nextY !== undefined && touchY !== undefined) follow.userIntent(touchY - nextY, feed);
      touchY = nextY;
    };
    const keyDown = (event: KeyboardEvent) => {
      const target = event.target;
      if (target instanceof HTMLElement && (target.isContentEditable || target.closest('input, textarea, select'))) return;
      if (['ArrowUp', 'PageUp', 'Home'].includes(event.key) || (event.key === ' ' && event.shiftKey)) follow.userIntent(-1, feed);
      if (['ArrowDown', 'PageDown', 'End'].includes(event.key) || (event.key === ' ' && !event.shiftKey)) follow.userIntent(1, feed);
    };
    const pointerDown = (event: PointerEvent) => {
      const bounds = feed.getBoundingClientRect();
      if (event.clientX >= bounds.right - Math.max(18, feed.offsetWidth - feed.clientWidth)) follow.beginDrag();
    };
    const scroll = () => follow.scrolled(feed);
    const endGesture = () => follow.endGesture();
    const endDrag = () => follow.endDrag();
    feed.addEventListener('wheel', wheel, { passive: true });
    feed.addEventListener('touchstart', touchStart, { passive: true });
    feed.addEventListener('touchmove', touchMove, { passive: true });
    feed.addEventListener('keydown', keyDown);
    feed.addEventListener('pointerdown', pointerDown);
    feed.addEventListener('scroll', scroll, { passive: true });
    feed.addEventListener('scrollend', endGesture);
    window.addEventListener('pointerup', endDrag);
    window.addEventListener('pointercancel', endDrag);
    return () => {
      observer.disconnect();
      feed.removeEventListener('wheel', wheel);
      feed.removeEventListener('touchstart', touchStart);
      feed.removeEventListener('touchmove', touchMove);
      feed.removeEventListener('keydown', keyDown);
      feed.removeEventListener('pointerdown', pointerDown);
      feed.removeEventListener('scroll', scroll);
      feed.removeEventListener('scrollend', endGesture);
      window.removeEventListener('pointerup', endDrag);
      window.removeEventListener('pointercancel', endDrag);
    };
  }, [conversationId]);
  return { scrollRef, contentRef };
}
