import { EventEmitter } from 'node:events';
import { runInNewContext } from 'node:vm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WebContents } from 'electron';
import {
  BrowserTeachingRecorder,
  safeTeachingLabel,
  safeTeachingUrl,
} from '../apps/desktop/browser-teaching.js';
import type { BrowserTeachingStep } from '../src/domain/browser-teaching.js';

class Page extends EventEmitter {
  url = 'https://example.com/reports?q=private#private';
  handlers = new Map<string, (event: unknown) => void>();
  context: Record<string, any>;
  constructor() {
    super();
    const handlers = this.handlers;
    this.context = {
      location: { href: this.url },
      URL,
      AbortController,
      document: {
        addEventListener: (name: string, listener: (event: unknown) => void) => {
          handlers.set(name, listener);
        },
      },
      Element: Node,
      HTMLInputElement: Input,
      HTMLSelectElement: Select,
    };
  }
  getURL() {
    return this.url;
  }
  isDestroyed() {
    return false;
  }
  async executeJavaScriptInIsolatedWorld(_world: number, scripts: { code: string }[]) {
    return runInNewContext(scripts[0].code, this.context);
  }
  get contents() {
    return this as unknown as WebContents;
  }
}
class Node {
  tagName = 'BUTTON';
  textContent = '保存报告';
  attributes: Record<string, string> = {};
  passwordForm = false;
  closest(selector: string) {
    if (selector === 'form') return this.passwordForm ? { querySelector: () => ({}) } : null;
    return this;
  }
  getAttribute(name: string) {
    return this.attributes[name] ?? null;
  }
}
class Input extends Node {
  type = 'text';
  get value(): string {
    throw new Error('录制期间禁止读取输入值');
  }
}
class Select extends Node {}
afterEach(() => {
  vi.useRealTimers();
});
describe('浏览器示范教学', () => {
  it('只在显式开始后采集，记录动作而不读取输入值，过滤登录和密码', async () => {
    const recorder = new BrowserTeachingRecorder();
    const page = new Page();
    expect(await recorder.status()).toBeNull();
    const started = await recorder.start('session', [page.contents]);
    const input = new Input();
    input.attributes['aria-label'] = '报告标题';
    page.handlers.get('change')!({ isTrusted: true, type: 'change', target: input });
    const password = new Input();
    password.type = 'password';
    page.handlers.get('change')!({ isTrusted: true, type: 'change', target: password });
    const email = new Input();
    email.type = 'email';
    page.handlers.get('change')!({ isTrusted: true, type: 'change', target: email });
    const login = new Node();
    login.passwordForm = true;
    page.handlers.get('click')!({ isTrusted: true, type: 'click', target: login });
    page.handlers.get('click')!({ isTrusted: false, type: 'click', target: new Node() });
    const finished = await recorder.stop();
    expect(finished?.id).toBe(started.id);
    expect(finished?.status).toBe('draft');
    expect(finished?.steps).toEqual([
      {
        action: 'navigate',
        url: 'https://example.com/reports',
        target: '',
        instruction: '打开 https://example.com/reports',
      },
      {
        action: 'fill',
        url: 'https://example.com/reports',
        target: '报告标题',
        instruction: '填写 报告标题，内容在执行时提供',
      },
    ]);
    expect(page.listenerCount('did-finish-load')).toBe(0);
  });
  it('到十分钟自动结束并移除后续页面监听', async () => {
    vi.useFakeTimers();
    const recorder = new BrowserTeachingRecorder();
    const page = new Page();
    await recorder.start('session', [page.contents]);
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
    expect(await recorder.status()).toMatchObject({ status: 'draft', endedAt: expect.any(String) });
    expect(page.listenerCount('did-finish-load')).toBe(0);
    recorder.close();
  });
  it('去除网址查询参数、登录路径、令牌及邮箱标签', () => {
    expect(safeTeachingUrl('https://example.com/reports?token=private#credentials')).toBe(
      'https://example.com/reports',
    );
    expect(safeTeachingUrl('https://example.com/oauth/authorize')).toBe('');
    expect(safeTeachingUrl('https://example.com/reports/abcdefghijklmnopqrstuvwxyz')).toContain(
      '[参数]',
    );
    expect(safeTeachingLabel('person@example.com')).toBe('');
    expect(safeTeachingLabel('Password manager')).toBe('');
  });
  it('新标签与页面导航继续教学，停止后保持可审阅草稿', async () => {
    const recorder = new BrowserTeachingRecorder();
    const first = new Page();
    const second = new Page();
    await recorder.start('session', [first.contents]);
    second.url = 'https://example.com/summary';
    second.context.location.href = second.url;
    await recorder.add(second.contents);
    second.handlers.get('click')!({ isTrusted: true, type: 'click', target: new Node() });
    const draft = await recorder.stop();
    expect(draft?.steps.map((step: BrowserTeachingStep) => step.action)).toEqual([
      'navigate',
      'navigate',
      'click',
    ]);
    expect((await recorder.status())?.steps).toEqual(draft?.steps);
  });
});
