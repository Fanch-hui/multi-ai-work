import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { State } from '../src/core/state.js';
import { BrowserTeachingService } from '../src/core/browser-teaching-service.js';
import type { BrowserTeachingDraft } from '../src/domain/browser-teaching.js';
const resources: { state: State; directory: string }[] = [];
afterEach(async () => {
  for (const resource of resources.splice(0)) {
    resource.state.storage.close();
    await rm(resource.directory, { recursive: true, force: true });
  }
});
async function setup() {
  const directory = await mkdtemp(join(tmpdir(), 'teaching-state-'));
  const state = new State(directory);
  resources.push({ state, directory });
  let draft: BrowserTeachingDraft | null = null;
  const host = vi.fn(async (method: string) => {
    if (method === 'teaching.start')
      draft = {
        id: 'draft',
        sessionId: 'browser',
        name: 'Report',
        startedAt: '2026-10-23T12:00:00Z',
        status: 'recording',
        steps: [
          {
            action: 'click',
            url: 'https://example.com/reports',
            target: 'Create',
            instruction: '点击 Create',
          },
        ],
        truncated: false,
      };
    if (method === 'teaching.stop' && draft)
      draft = { ...draft, status: 'draft', endedAt: '2026-10-23T12:02:00Z' };
    return draft;
  });
  state.storage.put('browser_sessions', {
    id: 'browser',
    profileId: 'profile',
    purpose: 'setup',
    status: 'handoff',
    createdAt: '2026-10-23T12:00:00Z',
  });
  const service = new BrowserTeachingService(state, host);
  return { state, service, host };
}
describe('教学草稿持久保存', () => {
  it('需人工接管且明确开始后才调用录制组件', async () => {
    const fixture = await setup();
    fixture.state.storage.put('browser_sessions', {
      id: 'browser',
      profileId: 'profile',
      status: 'active',
      createdAt: '2026-10-23T12:00:00Z',
    });
    await expect(
      fixture.service.request('teaching.start', { sessionId: 'browser' }),
    ).rejects.toThrow('先接管');
    expect(fixture.host).not.toHaveBeenCalled();
  });
  it('人工交回前结束录制，固定草稿保存一次并保留审阅入口', async () => {
    const fixture = await setup();
    await fixture.service.request('teaching.start', { sessionId: 'browser' });
    expect(await fixture.service.request('teaching.drafts', {})).toEqual([]);
    await fixture.service.finishSession('browser');
    await fixture.service.finishSession('browser');
    const drafts = (await fixture.service.request('teaching.drafts', {})) as BrowserTeachingDraft[];
    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toMatchObject({ status: 'draft', steps: [{ instruction: '点击 Create' }] });
    expect(fixture.host.mock.calls.filter(([method]) => method === 'teaching.stop')).toHaveLength(
      1,
    );
  });
  it('关闭时只结束本次活动录制，旧会话记录不访问不存在的浏览器', async () => {
    const fixture = await setup();
    await fixture.service.close();
    expect(fixture.host).not.toHaveBeenCalled();
    await fixture.service.request('teaching.start', { sessionId: 'browser' });
    await fixture.service.close();
    expect(await fixture.service.request('teaching.drafts', {})).toHaveLength(1);
  });
});
