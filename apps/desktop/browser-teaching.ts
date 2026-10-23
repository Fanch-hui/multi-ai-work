import type { WebContents } from 'electron';
import type {
  BrowserTeachingDraft,
  BrowserTeachingStep,
} from '../../src/domain/browser-teaching.js';
import { randomUUID } from 'node:crypto';

const world = 1008;
export class BrowserTeachingRecorder {
  private draft?: BrowserTeachingDraft;
  private tabs = new Map<WebContents, () => void>();
  private timer?: ReturnType<typeof setTimeout>;
  private polling?: ReturnType<typeof setInterval>;
  private reading?: Promise<void>;
  async start(sessionId: string, contents: WebContents[]) {
    if (this.draft?.status === 'recording') throw new Error('示范教学正在进行');
    this.draft = {
      id: randomUUID(),
      sessionId,
      name: '浏览器工作流程',
      startedAt: new Date().toISOString(),
      status: 'recording',
      steps: [],
      truncated: false,
    };
    for (const tab of contents) await this.add(tab);
    this.timer = setTimeout(
      () => {
        void this.stop().catch(() => {});
      },
      10 * 60 * 1000,
    );
    this.polling = setInterval(() => {
      void this.collect().catch(() => {});
    }, 1000);
    return this.draft;
  }
  async add(contents: WebContents) {
    if (!this.draft || this.draft.status !== 'recording' || this.tabs.has(contents)) return;
    const load = () => {
      void this.install(contents).catch(() => {});
    };
    contents.on('did-finish-load', load);
    this.tabs.set(contents, () => contents.removeListener('did-finish-load', load));
    await this.install(contents);
  }
  async status() {
    await this.collect();
    return this.draft ?? null;
  }
  async stop() {
    if (!this.draft) return null;
    clearTimeout(this.timer);
    clearInterval(this.polling);
    await this.collect();
    for (const [contents, remove] of this.tabs) {
      remove();
      if (!contents.isDestroyed())
        await contents
          .executeJavaScriptInIsolatedWorld(world, [
            { code: 'globalThis.__teaching?.stop(); delete globalThis.__teaching;' },
          ])
          .catch(() => {});
    }
    this.tabs.clear();
    this.draft = {
      ...this.draft,
      status: 'draft',
      endedAt: this.draft.endedAt ?? new Date().toISOString(),
    };
    return this.draft;
  }
  close() {
    clearTimeout(this.timer);
    clearInterval(this.polling);
    for (const remove of this.tabs.values()) remove();
    this.tabs.clear();
    if (this.draft)
      this.draft = { ...this.draft, status: 'draft', endedAt: new Date().toISOString() };
  }
  private async install(contents: WebContents) {
    if (contents.isDestroyed() || !/^https?:\/\//.test(contents.getURL())) return;
    await contents.executeJavaScriptInIsolatedWorld(world, [
      { code: `(${recordInteractions.toString()})()` },
    ]);
    const url = safeTeachingUrl(contents.getURL());
    if (url) this.append([{ action: 'navigate', url, instruction: `打开 ${url}` }]);
  }
  private collect() {
    if (!this.draft || this.draft.status !== 'recording') return Promise.resolve();
    if (this.reading) return this.reading;
    this.reading = this.readTabs().finally(() => {
      this.reading = undefined;
    });
    return this.reading;
  }
  private async readTabs() {
    for (const contents of this.tabs.keys()) {
      if (contents.isDestroyed()) continue;
      const steps = await contents
        .executeJavaScriptInIsolatedWorld(world, [{ code: 'globalThis.__teaching?.take() ?? []' }])
        .catch(() => []);
      if (Array.isArray(steps)) this.append(steps);
    }
  }
  private append(steps: BrowserTeachingStep[]) {
    if (!this.draft) return;
    for (const step of steps) {
      if (this.draft.steps.length >= 300) {
        this.draft.truncated = true;
        break;
      }
      const url = safeTeachingUrl(step.url);
      if (!url || !['navigate', 'click', 'fill', 'select', 'press', 'scroll'].includes(step.action))
        continue;
      const target = safeTeachingLabel(step.target ?? '');
      let instruction =
        `${({ click: '点击', select: '选择', press: '按键', scroll: '滚动页面' } as Record<string, string>)[step.action]} ${target}`.trim();
      if (step.action === 'navigate') instruction = `打开 ${url}`;
      if (step.action === 'fill') instruction = `填写 ${target || '文本框'}，内容在执行时提供`;
      const previous = this.draft.steps.at(-1);
      if (previous?.action === step.action && previous.url === url && previous.target === target)
        continue;
      this.draft.steps.push({ action: step.action, url, target, instruction });
    }
  }
}
export function safeTeachingUrl(value: string) {
  try {
    const url = new URL(value);
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      /login|signin|sign-in|oauth|authorize|password|token|secret|session|credential|verify/i.test(
        url.pathname,
      )
    )
      return '';
    return `${url.origin}${url.pathname.replace(/[A-Za-z0-9_-]{24,}/g, '[参数]')}`;
  } catch {
    return '';
  }
}
export function safeTeachingLabel(value: string) {
  if (
    /password|passcode|token|secret|cookie|authorization|sign.?in|log.?in|验证码|密码|密钥|登录|[\w.+-]+@[\w.-]+\.[a-z]{2,}/i.test(
      value,
    )
  )
    return '';
  return value.replace(/[A-Za-z0-9_-]{24,}/g, '[参数]').slice(0, 120);
}

function recordInteractions() {
  const root = globalThis as typeof globalThis & {
    __teaching?: { stop(): void; take(): BrowserTeachingStep[] };
  };
  root.__teaching?.stop();
  const queue: BrowserTeachingStep[] = [];
  const controller = new AbortController();
  const sensitive =
    /password|passcode|token|secret|cookie|authorization|sign.?in|log.?in|验证码|密码|密钥|登录|[\w.+-]+@[\w.-]+\.[a-z]{2,}/i;
  function record(event: Event) {
    if (!event.isTrusted || queue.length >= 300) return;
    const target =
      event.target instanceof Element
        ? event.target.closest(
            'a,button,input,textarea,select,[role="button"],[contenteditable="true"]',
          )
        : null;
    if (!target || target.closest('form')?.querySelector('input[type="password"]')) return;
    const input = target instanceof HTMLInputElement ? target : undefined;
    if (input && ['password', 'email', 'tel', 'hidden', 'file'].includes(input.type)) return;
    const editable =
      !!input || target.tagName === 'TEXTAREA' || target.getAttribute('contenteditable') === 'true';
    const label =
      [
        target.getAttribute('aria-label'),
        target.getAttribute('placeholder'),
        target.getAttribute('title'),
        editable ? '' : target.textContent,
      ]
        .find(Boolean)
        ?.trim()
        .slice(0, 120) ?? target.tagName.toLowerCase();
    if (
      sensitive.test(label) ||
      sensitive.test(target.getAttribute('autocomplete') ?? '') ||
      sensitive.test(target.getAttribute('name') ?? '')
    )
      return;
    const url = new URL(location.href);
    if (
      /login|signin|sign-in|oauth|authorize|password|token|secret|session|credential|verify/i.test(
        url.pathname,
      )
    )
      return;
    let action: BrowserTeachingStep['action'] = 'click';
    if (event.type === 'change') action = target instanceof HTMLSelectElement ? 'select' : 'fill';
    queue.push({ action, url: `${url.origin}${url.pathname}`, target: label, instruction: '' });
  }
  document.addEventListener('click', record, { capture: true, signal: controller.signal });
  document.addEventListener('change', record, { capture: true, signal: controller.signal });
  root.__teaching = { stop: () => controller.abort(), take: () => queue.splice(0) };
}
