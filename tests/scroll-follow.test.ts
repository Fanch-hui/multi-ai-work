import { describe, expect, it } from 'vitest';
import { ScrollFollow, type ScrollPosition } from '../apps/ui/src/scroll-follow.js';

function setup() {
  const position: ScrollPosition = { scrollTop: 0, scrollHeight: 1000, clientHeight: 400 };
  const follow = new ScrollFollow();
  follow.reset(position);
  return { follow, position };
}

describe('chat scroll following', () => {
  it('starts at the bottom and follows message, input area and viewport size changes', () => {
    const { follow, position } = setup();
    expect(position.scrollTop).toBe(600);
    position.scrollHeight += 100;
    follow.layoutChanged(position);
    expect(position.scrollTop).toBe(700);
    position.clientHeight -= 80;
    follow.layoutChanged(position);
    expect(position.scrollTop).toBe(780);
    position.clientHeight += 200;
    follow.layoutChanged(position);
    expect(position.scrollTop).toBe(580);
  });

  it('pauses immediately on an upward gesture even within the old bottom threshold', () => {
    const { follow, position } = setup();
    follow.userIntent(-1, position);
    position.scrollTop = 590;
    follow.scrolled(position);
    position.scrollHeight += 100;
    follow.layoutChanged(position);
    follow.scrolled(position);
    expect(position.scrollTop).toBe(590);
    position.clientHeight -= 40;
    follow.layoutChanged(position);
    expect(position.scrollTop).toBe(590);
  });

  it('resumes only when the user scrolls down to the bottom', () => {
    const { follow, position } = setup();
    follow.userIntent(-1, position);
    position.scrollTop = 300;
    follow.scrolled(position);
    follow.endGesture();
    follow.userIntent(1, position);
    position.scrollTop = 560;
    follow.scrolled(position);
    position.scrollHeight += 100;
    follow.layoutChanged(position);
    expect(position.scrollTop).toBe(560);
    follow.userIntent(1, position);
    position.scrollTop = 700;
    follow.scrolled(position);
    follow.endGesture();
    position.scrollHeight += 100;
    follow.layoutChanged(position);
    expect(position.scrollTop).toBe(800);
  });

  it('does not resume for programmatic scrolling or browser layout clamping', () => {
    const { follow, position } = setup();
    follow.userIntent(-1, position);
    position.scrollTop = 400;
    follow.scrolled(position);
    follow.endGesture();
    position.scrollTop = 600;
    follow.scrolled(position);
    position.scrollHeight += 100;
    follow.layoutChanged(position);
    expect(position.scrollTop).toBe(600);
    position.clientHeight = 500;
    follow.layoutChanged(position);
    position.scrollHeight += 100;
    follow.layoutChanged(position);
    expect(position.scrollTop).toBe(600);
    follow.userIntent(1, position);
    position.clientHeight = 600;
    follow.layoutChanged(position);
    position.scrollTop = 600;
    follow.scrolled(position);
    position.scrollHeight += 100;
    follow.layoutChanged(position);
    expect(position.scrollTop).toBe(600);
  });

  it('supports returning by scrollbar and resets follow when changing conversations', () => {
    const { follow, position } = setup();
    follow.beginDrag();
    position.scrollTop = 100;
    follow.scrolled(position);
    follow.endDrag();
    position.scrollHeight += 100;
    follow.layoutChanged(position);
    expect(position.scrollTop).toBe(100);
    follow.beginDrag();
    position.scrollTop = 700;
    follow.scrolled(position);
    follow.endDrag();
    position.scrollHeight += 100;
    follow.layoutChanged(position);
    expect(position.scrollTop).toBe(800);
    follow.userIntent(-1, position);
    position.scrollHeight = 2000;
    follow.reset(position);
    expect(position.scrollTop).toBe(1600);
  });

  it('accepts an explicit downward gesture at the bottom after a paused gesture', () => {
    const { follow, position } = setup();
    follow.userIntent(-1, position);
    follow.endGesture();
    follow.userIntent(1, position);
    position.scrollHeight += 100;
    follow.layoutChanged(position);
    expect(position.scrollTop).toBe(700);
  });
});
