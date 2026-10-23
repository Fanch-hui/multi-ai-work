import { describe, expect, it } from 'vitest';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { HostRequest } from '../src/core/service.js';
import type { BrowserProfile, BrowserSession } from '../src/domain/work-browser.js';
import type { Bot, Task } from '../src/domain/types.js';
import type { TaskWait } from '../src/domain/task-wait.js';
import { setup, eventually } from './core-harness.js';

const browserTools = [
  'browser_open',
  'browser_snapshot',
  'browser_action',
  'browser_handoff',
  'browser_tabs',
];
function hostHarness() {
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  const sessions = new Map<string, { directory: string; interactive: boolean }>();
  let rejectNavigation: ((error: Error) => void) | undefined;
  let stall = false;
  let file: string | undefined;
  const host: HostRequest = async (method, params = {}) => {
    calls.push({ method, params });
    const sessionId = String(params.sessionId);
    if (method === 'system.notify') return { shown: true };
    if (method === 'browser.open') {
      if (!sessions.has(sessionId))
        sessions.set(sessionId, {
          directory: String(params.downloadDirectory),
          interactive: false,
        });
      if (stall && params.url)
        return new Promise((_resolve, reject) => {
          rejectNavigation = reject;
        });
      return { sessionId, tabs: [] };
    }
    if (method === 'browser.interactive') {
      sessions.get(sessionId)!.interactive = !!params.interactive;
      return { ok: true };
    }
    if (method === 'browser.close') {
      rejectNavigation?.(new Error('Target closed'));
      rejectNavigation = undefined;
      sessions.delete(sessionId);
      return { ok: true };
    }
    if (method === 'browser.snapshot')
      return {
        tabId: 'tab',
        revision: 'current',
        title: 'Report',
        url: 'https://example.com',
        text: 'report',
        elements: [],
      };
    if (method === 'browser.downloads') {
      if (!file) return [];
      const path = join(sessions.get(sessionId)!.directory, 'report.txt');
      if (!calls.some((item) => item.method === 'test.downloadCreated')) {
        await writeFile(path, file);
        calls.push({ method: 'test.downloadCreated', params: {} });
      }
      return [{ path, name: 'report.txt', mimeType: 'text/plain', size: file.length }];
    }
    if (method === 'browser.tabs')
      return [{ id: 'tab', title: 'Report', url: 'https://example.com', active: true }];
    return { ok: true };
  };
  return {
    host,
    calls,
    sessions,
    stall: () => {
      stall = true;
    },
    download: () => {
      file = 'report contents';
    },
  };
}

async function configured(run: Parameters<typeof setup>[0], host: HostRequest) {
  const result = await setup(run, host);
  const bot = result.bot('Browser worker', browserTools);
  result.core.state.storage.put('bots', { ...bot, approvalMode: 'auto' } as Bot);
  const room = result.core.entities.createConversation({
    name: 'Web work',
    kind: 'private',
    memberIds: [bot.id],
    workspaceId: result.core.state.snapshot().workspaces[0].id,
  });
  const profile = (await result.core.request('browser.saveProfile', {
    input: { name: 'Work', allowedBotIds: [bot.id] },
  })) as BrowserProfile;
  return { ...result, member: bot, room, profile };
}

describe('工作浏览器 Core 集成', () => {
  it('使用显式配置权限，下载登记一次且保持中间资料归属', async () => {
    const host = hostHarness();
    host.download();
    let profileId = '';
    const result = await configured(async (context) => {
      const profiles = (await context.executeTool('browser_open', {}, 'profiles')) as {
        profiles: { id: string }[];
      };
      expect(profiles.profiles.map((p) => p.id)).toEqual([profileId]);
      const opened = (await context.executeTool(
        'browser_open',
        { profileId, url: 'https://example.com' },
        'open',
      )) as { sessionId: string };
      const first = await context.executeTool(
        'browser_snapshot',
        { sessionId: opened.sessionId },
        'read1',
      );
      const second = await context.executeTool(
        'browser_snapshot',
        { sessionId: opened.sessionId },
        'read2',
      );
      expect(second).toEqual(first);
      return { text: '资料已读取' };
    }, host.host);
    profileId = result.profile.id;
    const sent = result.core.tasks.send({ conversationId: result.room.id, content: '读取资料' });
    await eventually(
      () => result.core.state.storage.get<Task>('tasks', sent.taskIds[0])?.status === 'completed',
    );
    const artifacts = result.core.state.snapshot().artifacts;
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]).toMatchObject({
      name: 'report.txt',
      purpose: 'intermediate',
      taskId: sent.taskIds[0],
      botId: result.member.id,
    });
  });

  it('人工接管释放运行，交回后原任务读取新页面继续', async () => {
    const host = hostHarness();
    let profileId = '',
      sessionId = '',
      rounds = 0;
    const result = await configured(async (context) => {
      if (++rounds === 1) {
        const opened = (await context.executeTool('browser_open', { profileId }, 'open')) as {
          sessionId: string;
        };
        sessionId = opened.sessionId;
        await context.executeTool(
          'browser_handoff',
          { sessionId, reason: '请登录工作网站' },
          'handoff',
        );
      } else {
        expect(context.prompt).toContain('重新读取页面状态');
        const snapshot = await context.executeTool(
          'browser_snapshot',
          { sessionId },
          'after-login',
        );
        expect(snapshot).toHaveProperty('content');
      }
      return { text: '已读取登录后的资料' };
    }, host.host);
    profileId = result.profile.id;
    const sent = result.core.tasks.send({
      conversationId: result.room.id,
      content: '读取登录资料',
    });
    await eventually(
      () =>
        result.core.state.storage.get<Task>('tasks', sent.taskIds[0])?.status === 'waiting_input' &&
        !result.core.scheduler.hasActive(),
    );
    expect(host.sessions.get(sessionId)?.interactive).toBe(true);
    await expect(result.core.request('browser.closeSession', { id: sessionId })).rejects.toThrow(
      '先停止任务',
    );
    const waits = (await result.core.request('waits.list')) as TaskWait[];
    await result.core.request('waits.resume', { id: waits[0].id });
    await eventually(() =>
      ['completed', 'failed'].includes(
        result.core.state.storage.get<Task>('tasks', sent.taskIds[0])?.status ?? '',
      ),
    );
    expect(result.core.state.storage.get<Task>('tasks', sent.taskIds[0])).toMatchObject({
      status: 'completed',
    });
    expect(rounds).toBe(2);
    expect(result.core.state.snapshot().tasks).toHaveLength(1);
  });

  it('停止会话中断挂起导航，等待宿主释放后结束任务', async () => {
    const host = hostHarness();
    host.stall();
    let profileId = '';
    const result = await configured(async (context) => {
      await context.executeTool(
        'browser_open',
        { profileId, url: 'https://example.com/slow' },
        'open',
      );
      return { text: '' };
    }, host.host);
    profileId = result.profile.id;
    const sent = result.core.tasks.send({ conversationId: result.room.id, content: '打开网页' });
    await eventually(() => host.calls.some((c) => c.method === 'browser.open' && !!c.params.url));
    await result.core.scheduler.cancel(sent.taskIds[0]);
    expect(host.sessions.size).toBe(0);
    expect(result.core.scheduler.hasActive()).toBe(false);
    expect(
      result.core.state.storage.get<Task>('tasks', sent.taskIds[0])?.reconciliationRequired,
    ).toBe(true);
  });

  it('配置登录支持人工导航、标签管理和释放独立登录会话', async () => {
    const host = hostHarness();
    const result = await configured(async () => ({ text: '' }), host.host);
    const session = (await result.core.request('browser.profileOpen', {
      profileId: result.profile.id,
    })) as BrowserSession;
    expect(session.purpose).toBe('setup');
    expect(host.sessions.get(session.id)?.interactive).toBe(true);
    await result.core.request('browser.navigate', {
      id: session.id,
      url: 'https://example.com/login',
    });
    expect(host.sessions.get(session.id)?.interactive).toBe(true);
    expect(await result.core.request('browser.userTabs', { id: session.id })).toHaveLength(1);
    await result.core.request('browser.resume', { id: session.id });
    expect(host.sessions.size).toBe(0);
  });

  it('权限撤销后拒绝新动作', async () => {
    const host = hostHarness();
    let profileId = '';
    const result = await configured(async (context) => {
      const opened = (await context.executeTool('browser_open', { profileId }, 'open')) as {
        sessionId: string;
      };
      await result.core.request('browser.saveProfile', {
        input: { id: profileId, name: 'Work', allowedBotIds: [] },
      });
      const value = await context.executeTool(
        'browser_snapshot',
        { sessionId: opened.sessionId },
        'revoked',
      );
      expect(value).toMatchObject({ error: expect.stringContaining('未获准') });
      return { text: '权限已撤销' };
    }, host.host);
    profileId = result.profile.id;
    const sent = result.core.tasks.send({ conversationId: result.room.id, content: '检查权限' });
    await eventually(
      () => result.core.state.storage.get<Task>('tasks', sent.taskIds[0])?.status === 'completed',
    );
    expect(host.calls.some((c) => c.method === 'browser.snapshot')).toBe(false);
  });
});
