import type { BrowserAction, BrowserSnapshot } from '../../src/domain/work-browser.js';
import type { WebContents } from 'electron';
import { randomUUID } from 'node:crypto';

interface FrameTree {
  frame: { id: string; url: string };
  childFrames?: FrameTree[];
}

interface FrameSnapshot {
  context: number;
  refs: Set<string>;
}

export class WorkBrowserPage {
  revision?: string;
  private frames: FrameSnapshot[] = [];

  constructor(private contents: WebContents) {
    contents.on('did-start-navigation', () => this.invalidate());
    contents.on('render-process-gone', () => this.invalidate());
  }

  invalidate() {
    this.revision = undefined;
    this.frames = [];
  }

  handoff() {
    this.invalidate();
    if (this.contents.debugger.isAttached()) this.contents.debugger.detach();
  }

  private async command(method: string, params: Record<string, unknown> = {}) {
    if (!this.contents.debugger.isAttached()) {
      this.contents.debugger.attach('1.3');
      await this.contents.debugger.sendCommand('Page.setInterceptFileChooserDialog', {
        enabled: true,
      });
      await this.contents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', {
        enabled: true,
      });
    }
    return this.contents.debugger.sendCommand(method, params);
  }

  async snapshot(tabId: string, screenshot = false): Promise<BrowserSnapshot> {
    this.invalidate();
    const revision = randomUUID();
    const tree = (await this.command('Page.getFrameTree')) as { frameTree: FrameTree };
    const frames: FrameTree[] = [];
    const visit = (frame: FrameTree) => {
      frames.push(frame);
      frame.childFrames?.forEach(visit);
    };
    visit(tree.frameTree);
    const elements: BrowserSnapshot['elements'] = [];
    const texts: string[] = [];
    for (const frame of frames) {
      if (elements.length >= 200) break;
      if (!/^https?:\/\//i.test(frame.frame.url)) continue;
      let context: number;
      try {
        ({ executionContextId: context } = await this.command('Page.createIsolatedWorld', {
          frameId: frame.frame.id,
          worldName: 'multi-ai-work-browser',
        }));
      } catch (error) {
        if (frame === tree.frameTree) throw error;
        texts.push('[此嵌入页面需要用户接管后操作]');
        continue;
      }
      const result = await this.call(context, collectPage.toString(), [
        revision,
        `f${frames.indexOf(frame)}:`,
        200 - elements.length,
      ]);
      const value = result as { text: string; elements: BrowserSnapshot['elements'] };
      texts.push(value.text);
      elements.push(...value.elements);
      this.frames.push({ context, refs: new Set(value.elements.map((item) => item.ref)) });
    }
    const image = screenshot
      ? await this.command('Page.captureScreenshot', { format: 'png' })
      : null;
    this.revision = revision;
    return {
      tabId,
      revision,
      url: this.contents.getURL(),
      title: this.contents.getTitle(),
      text: texts.join('\n').slice(0, 40000),
      elements,
      ...(image ? { screenshot: image.data as string } : {}),
    };
  }

  async action(input: BrowserAction) {
    if (!this.revision || input.revision !== this.revision)
      throw new Error('页面快照已更新，请重新读取页面');
    const frame = input.ref
      ? this.frames.find((item) => item.refs.has(input.ref!))
      : this.frames[0];
    if (!frame) throw new Error('页面元素已失效，请重新读取页面');
    if (input.action === 'back') {
      await this.call(frame.context, actOnPage.toString(), [input, 'validate']);
      this.invalidate();
      if (this.contents.navigationHistory.canGoBack()) this.contents.navigationHistory.goBack();
      return { ok: true };
    }
    if (input.action === 'upload') {
      await this.call(frame.context, actOnPage.toString(), [input, 'validateUpload']);
      const remote = await this.command('Runtime.callFunctionOn', {
        executionContextId: frame.context,
        functionDeclaration: 'function(ref) { return globalThis.__workBrowser.nodes.get(ref); }',
        arguments: [{ value: input.ref }],
      });
      if (!remote.result?.objectId) throw new Error('文件输入框已失效');
      try {
        await this.command('DOM.setFileInputFiles', {
          objectId: remote.result.objectId,
          files: [input.path],
        });
      } catch {
        this.invalidate();
        throw new Error('BROWSER_ACTION_UNKNOWN: 文件上传结果未知，请读取页面核对');
      } finally {
        await this.command('Runtime.releaseObject', { objectId: remote.result.objectId });
      }
    } else if (input.action === 'click' || input.action === 'press') {
      const position = await this.call(frame.context, actOnPage.toString(), [input, 'prepare']);
      const keys: Record<string, number> = { Enter: 13, Tab: 9, Escape: 27 };
      const key = input.key ?? '';
      if (input.action === 'press' && !keys[key]) throw new Error('仅支持 Enter、Tab 和 Escape');
      // The isolated-world function validates and focuses the referenced node before trusted CDP input.
      try {
        if (input.action === 'click') {
          await this.command('Input.dispatchMouseEvent', {
            type: 'mousePressed',
            button: 'left',
            clickCount: 1,
            ...position,
          });
          await this.command('Input.dispatchMouseEvent', {
            type: 'mouseReleased',
            button: 'left',
            clickCount: 1,
            ...position,
          });
        } else {
          await this.command('Input.dispatchKeyEvent', {
            type: 'keyDown',
            key,
            windowsVirtualKeyCode: keys[key],
            ...(key === 'Enter' ? { text: '\r' } : {}),
          });
          await this.command('Input.dispatchKeyEvent', {
            type: 'keyUp',
            key,
            windowsVirtualKeyCode: keys[key],
          });
        }
      } catch {
        this.invalidate();
        throw new Error('BROWSER_ACTION_UNKNOWN: 页面输入结果未知，请读取页面核对后继续');
      }
    } else {
      try {
        await this.call(frame.context, actOnPage.toString(), [input, 'perform']);
      } catch (error) {
        if (this.contents.isDestroyed() || !this.revision) {
          this.invalidate();
          throw new Error('BROWSER_ACTION_UNKNOWN: 页面操作结果未知，请重新读取页面核对');
        }
        throw error;
      }
    }
    this.invalidate();
    return { ok: true };
  }

  private async call(context: number, declaration: string, values: unknown[]) {
    const result = await this.command('Runtime.callFunctionOn', {
      executionContextId: context,
      functionDeclaration: declaration,
      arguments: values.map((value) => ({ value })),
      returnByValue: true,
      awaitPromise: true,
    });
    if (result.exceptionDetails)
      throw new Error(result.exceptionDetails.exception?.description ?? '页面操作失败');
    return result.result.value;
  }
}

// Runs only in a separate Chromium world; page scripts cannot access these references.
function collectPage(revision: string, prefix: string, limit: number) {
  const root = globalThis as typeof globalThis & { __workBrowser?: any };
  root.__workBrowser?.observer.disconnect();
  const state = {
    revision,
    dirty: false,
    nodes: new Map<string, Element>(),
    observer: null as any,
  };
  state.observer = new MutationObserver(() => {
    state.dirty = true;
  });
  state.observer.observe(document, {
    subtree: true,
    childList: true,
    attributes: true,
    characterData: true,
  });
  root.__workBrowser = state;
  const elements: BrowserSnapshot['elements'] = [];
  const candidates = document.querySelectorAll(
    'a[href],button,input,textarea,select,[role="button"],[role="link"],[contenteditable="true"]',
  );
  for (const node of candidates) {
    if (elements.length >= limit) break;
    const box = node.getBoundingClientRect();
    const style = getComputedStyle(node);
    if (
      box.width <= 0 ||
      box.height <= 0 ||
      style.visibility === 'hidden' ||
      style.display === 'none'
    )
      continue;
    const ref = `${prefix}${elements.length + 1}`;
    const password = node instanceof HTMLInputElement && node.type === 'password';
    const name = password
      ? '[密码输入框]'
      : node.getAttribute('aria-label') ||
        node.getAttribute('placeholder') ||
        node.textContent ||
        node.getAttribute('title') ||
        node.tagName.toLowerCase();
    elements.push({
      ref,
      role: password ? 'password' : node.getAttribute('role') || node.tagName.toLowerCase(),
      name: name.trim().slice(0, 200),
    });
    state.nodes.set(ref, node);
  }
  return { text: (document.body?.innerText ?? '').slice(0, 40000), elements };
}

function actOnPage(input: BrowserAction, operation: string) {
  const root = globalThis as typeof globalThis & { __workBrowser?: any };
  const state = root.__workBrowser;
  if (!state || state.dirty || state.revision !== input.revision)
    throw new Error('页面发生变化，请重新读取页面');
  const node = input.ref ? (state.nodes.get(input.ref) as HTMLElement | undefined) : undefined;
  if (input.ref && !node?.isConnected) throw new Error('页面元素已失效，请重新读取页面');
  if (operation === 'validateUpload') {
    if (!(node instanceof HTMLInputElement) || node.type !== 'file')
      throw new Error('请选择文件输入框');
    return;
  }
  if (operation === 'validate') return;
  if (input.action === 'scroll') {
    window.scrollBy({ top: input.deltaY ?? 500, behavior: 'instant' });
    return;
  }
  if (!node) throw new Error('此操作需要页面元素引用');
  node.scrollIntoView({ block: 'center' });
  if (operation === 'prepare') {
    node.focus();
    const box = node.getBoundingClientRect();
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    const hit = document.elementFromPoint(x, y);
    if (!hit || !node.contains(hit)) throw new Error('元素被遮挡，请重新读取页面或接管操作');
    if (window !== window.top) throw new Error('嵌入页面的点击和按键需要用户接管');
    return { x, y };
  }
  if (input.action === 'fill') {
    if (node instanceof HTMLInputElement && (node.type === 'password' || node.type === 'file'))
      throw new Error('密码由用户接管后输入，文件请使用上传操作');
    if (!(node instanceof HTMLInputElement) && !(node instanceof HTMLTextAreaElement))
      throw new Error('请选择文本输入框');
    const prototype =
      node instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(node, input.text ?? '');
    node.dispatchEvent(new Event('input', { bubbles: true }));
    node.dispatchEvent(new Event('change', { bubbles: true }));
    return;
  }
  if (input.action === 'select') {
    if (!(node instanceof HTMLSelectElement)) throw new Error('请选择下拉选择框');
    node.value = input.text ?? '';
    node.dispatchEvent(new Event('change', { bubbles: true }));
    return;
  }
  throw new Error('不支持的页面操作');
}
