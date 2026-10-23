import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CoreToDesktopMessage, DesktopToCoreMessage } from '../src/domain/core-ipc.js';
import { WorkBrowserHost } from '../apps/desktop/work-browser-host.js';
import { CoreHost } from '../apps/desktop/core-host.js';

const electron = vi.hoisted(() => ({ fork: vi.fn() }));
vi.mock('electron', () => ({
  app: { getPath: () => '/data', getAppPath: () => '/app', isPackaged: false },
  utilityProcess: { fork: electron.fork },
  net: {},
  dialog: {},
  shell: {},
  safeStorage: {},
  nativeImage: {},
}));

class ChildProcess extends EventEmitter {
  stdout = { resume: vi.fn() };
  stderr = { resume: vi.fn(), pipe: vi.fn() };
  postMessage = vi.fn<(message: DesktopToCoreMessage) => void>();
  kill = vi.fn();
  receive(message: CoreToDesktopMessage) {
    this.emit('message', message);
  }
}

let child: ChildProcess;
beforeEach(() => {
  child = new ChildProcess();
  electron.fork.mockReset().mockReturnValue(child);
});

async function started() {
  const host = new CoreHost();
  const starting = host.start();
  child.receive({ type: 'ready' });
  await starting;
  return host;
}

describe('desktop Core process boundary', () => {
  it('settles each request by its id, preserving results and actual errors', async () => {
    const host = await started();
    const first = host.request('state.snapshot', {});
    const second = host.request('settings.save', { input: {} });
    const [firstMessage, secondMessage] = child.postMessage.mock.calls.map(([message]) => message);
    if (firstMessage.type !== 'request' || secondMessage.type !== 'request') {
      throw new Error('Expected Core requests');
    }
    expect(firstMessage).toMatchObject({ type: 'request', method: 'state.snapshot', params: {} });
    expect(secondMessage).toMatchObject({
      type: 'request',
      method: 'settings.save',
      params: { input: {} },
    });
    const failed = expect(second).rejects.toThrow('保存失败');
    child.receive({ type: 'result', id: secondMessage.id, error: '保存失败' });
    child.receive({ type: 'result', id: firstMessage.id, result: { saved: true } });
    await expect(first).resolves.toEqual({ saved: true });
    await failed;
    child.emit('exit', 0);
  });

  it('rejects outstanding requests and releases the child on an unexpected exit', async () => {
    const host = await started();
    const changed = vi.fn();
    host.onChange = changed;
    const first = expect(host.request('one', {})).rejects.toThrow('Core 已断开');
    const second = expect(host.request('two', {})).rejects.toThrow('Core 已断开');
    child.emit('exit', 1);
    await Promise.all([first, second]);
    expect(host.running).toBe(false);
    expect(changed).toHaveBeenCalledOnce();
    await expect(host.request('three', {})).rejects.toThrow('Core 尚未启动');
  });

  it('reports startup fatal errors and exits before ready', async () => {
    const host = new CoreHost();
    const fatal = expect(host.start()).rejects.toThrow('初始化失败');
    child.receive({ type: 'fatal', error: '初始化失败' });
    await fatal;
    child.emit('exit', 1);
    electron.fork.mockReturnValue(new ChildProcess());
    const restarting = expect(host.start()).rejects.toThrow('Core 已停止 (2)');
    const next = electron.fork.mock.results.at(-1)!.value as ChildProcess;
    next.emit('exit', 2);
    await restarting;
  });

  it('sends one close request and waits for acknowledgement and process exit', async () => {
    const host = await started();
    const closeBrowser = vi.spyOn(WorkBrowserHost.prototype, 'closeAll');
    let settled = false;
    const closing = host.close().then(() => {
      settled = true;
    });
    const repeated = host.close();
    expect(closeBrowser).not.toHaveBeenCalled();
    expect(child.postMessage.mock.calls).toEqual([[{ type: 'close' }]]);
    child.receive({ type: 'closed' });
    await Promise.resolve();
    expect(settled).toBe(false);
    child.emit('exit', 0);
    await Promise.all([closing, repeated]);
    expect(host.running).toBe(false);
    expect(child.kill).not.toHaveBeenCalled();
    expect(closeBrowser).toHaveBeenCalled();
    closeBrowser.mockRestore();
  });

  it('rejects shutdown when the child exits without confirming resource release', async () => {
    const host = await started();
    const closing = expect(host.close()).rejects.toThrow('数据服务未正常关闭');
    child.emit('exit', 0);
    await closing;
    expect(host.running).toBe(false);
  });
});
