import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request as httpRequest } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { State } from '../src/core/state.js';
import { HostAccessService } from '../src/core/host-access.js';
import { HostAccessApi } from '../src/core/host-access-api.js';
import type { HostDevice } from '../src/domain/host-access.js';
import type { Message, Task } from '../src/domain/types.js';

const fixtures: { directory: string; service: HostAccessService; state: State }[] = [];
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) {
    await fixture.service.close();
    fixture.state.storage.close();
    await rm(fixture.directory, { recursive: true, force: true });
  }
});
async function setup() {
  const directory = await mkdtemp(join(tmpdir(), 'host-access-'));
  const state = new State(directory);
  const dispatch = vi.fn(async () => ({ ok: true }));
  const service = new HostAccessService(state, dispatch);
  fixtures.push({ directory, service, state });
  const room = state.storage.all<{ id: string }>('conversations')[0]!;
  const grant = { conversationIds: [room.id], scopes: ['read', 'send', 'stop'] as const };
  return { state, service, dispatch, room, grant };
}
function rawStatus(url: string, headers: Record<string, string>) {
  return new Promise<number>((resolve, reject) => {
    const request = httpRequest(url, { headers }, (response) => {
      response.resume();
      resolve(response.statusCode!);
    });
    request.on('error', reject);
    request.end();
  });
}
describe('桌面宿主配对与版本化接口', () => {
  it('启动默认关闭，只有桌面明确启用后才生成本机监听与配对码', async () => {
    const { service } = await setup();
    expect(service.status()).toMatchObject({
      apiVersion: '1',
      enabled: false,
      transport: 'loopback',
    });
    expect(service.status().url).toBeUndefined();
    await expect(
      service.request('hostAccess.pairing', { conversationIds: ['a'], scopes: ['read'] }),
    ).rejects.toThrow('先启用');
    await service.request('hostAccess.configure', { enabled: true });
    expect(service.status().url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/host\/v1$/);
    await service.close();
    expect(service.status().enabled).toBe(false);
  });
  it('一次性配对、hash存储、错误尝试限制和撤销立即生效', async () => {
    const { service, state, grant } = await setup();
    const pairing = service.devices.createPairing(grant);
    const paired = service.devices.exchange({ code: pairing.code, name: '测试手机' });
    expect(service.devices.authenticate(paired.token)).toMatchObject({ name: '测试手机' });
    const persisted = JSON.stringify(state.storage.metadata('host-access-devices'));
    expect(persisted).not.toContain(paired.token);
    expect(persisted).not.toContain(pairing.code);
    expect(JSON.stringify(service.devices.list())).not.toContain('tokenHash');
    expect(() => service.devices.exchange({ code: pairing.code, name: '重复' })).toThrow('失效');
    service.devices.revoke(paired.device.id);
    expect(service.devices.authenticate(paired.token)).toBeUndefined();
    const second = service.devices.createPairing(grant);
    for (let i = 0; i < 5; i++)
      expect(() => service.devices.exchange({ code: 'wrong', name: '测试' })).toThrow('无效');
    expect(() => service.devices.exchange({ code: second.code, name: '测试' })).toThrow('失效');
  });
  it('过期与替换后的配对码失效，备份恢复重置宿主身份和全部设备', async () => {
    const { service, grant } = await setup();
    const pairing = service.devices.createPairing(grant);
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 6 * 60_000);
    expect(() => service.devices.exchange({ code: pairing.code, name: '测试' })).toThrow('失效');
    clock.mockRestore();
    const old = service.devices.createPairing(grant);
    const current = service.devices.createPairing(grant);
    expect(() => service.devices.exchange({ code: old.code, name: '测试' })).toThrow('无效');
    const paired = service.devices.exchange({ code: current.code, name: '测试' });
    const hostId = service.status().hostId;
    await service.resetAfterRestore();
    expect(service.status().hostId).not.toBe(hostId);
    expect(service.status().enabled).toBe(false);
    expect(service.devices.authenticate(paired.token)).toBeUndefined();
    expect(service.devices.list()).toEqual([]);
  });
  it('HTTP 拒绝浏览器来源、错误 Host、缺失身份，协议版本和退出清理可用', async () => {
    const { service, grant } = await setup();
    await service.request('hostAccess.configure', { enabled: true });
    const base = service.status().url!;
    const pairing = service.devices.createPairing(grant);
    const pair = await fetch(`${base}/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: pairing.code, name: '桌面接口测试' }),
    });
    const paired = (await pair.json()) as { token: string; apiVersion: string };
    expect(paired.apiVersion).toBe('1');
    expect((await fetch(`${base}/status`)).status).toBe(401);
    const headers = { authorization: `Bearer ${paired.token}` };
    expect(
      (await fetch(`${base}/status`, { headers: { ...headers, origin: 'https://example.com' } }))
        .status,
    ).toBe(403);
    expect(await rawStatus(`${base}/status`, { ...headers, host: 'attacker.invalid' })).toBe(403);
    expect(
      (await fetch(`${base}/status`, { headers: { ...headers, 'sec-fetch-site': 'cross-site' } }))
        .status,
    ).toBe(403);
    expect(await (await fetch(`${base}/status`, { headers })).json()).toMatchObject({
      enabled: true,
      apiVersion: '1',
    });
    expect(
      (
        await fetch(`${base}/rpc`, {
          method: 'POST',
          headers: { ...headers, 'content-type': 'application/json' },
          body: JSON.stringify({ method: 'connections.list' }),
        })
      ).status,
    ).toBe(400);
    const device = service.devices.authenticate(paired.token)!;
    service.devices.revoke(device.id);
    expect((await fetch(`${base}/status`, { headers })).status).toBe(401);
    await service.close();
    await expect(fetch(`${base}/status`, { headers })).rejects.toThrow();
  });
  it('设备只读到授权会话已发表消息，写操作复用 Core 且请求标识按设备隔离', async () => {
    const { service, state, dispatch, room, grant } = await setup();
    const api = new HostAccessApi(state, dispatch);
    const pair = service.devices.exchange({
      code: service.devices.createPairing(grant).code,
      name: '测试',
    });
    const device = pair.device;
    const messages: Message[] = [
      {
        id: 'public',
        conversationId: room.id,
        sequence: 1,
        authorType: 'bot',
        content: '最终回复',
        artifactIds: [],
        status: 'committed',
        createdAt: new Date().toISOString(),
      },
      {
        id: 'system',
        conversationId: room.id,
        sequence: 2,
        authorType: 'system',
        content: '内部资料',
        artifactIds: [],
        status: 'committed',
        createdAt: new Date().toISOString(),
      },
      {
        id: 'draft',
        conversationId: room.id,
        sequence: 3,
        authorType: 'bot',
        content: '未发表',
        artifactIds: [],
        status: 'draft',
        createdAt: new Date().toISOString(),
      },
    ];
    for (const message of messages) state.storage.appendMessage(message);
    expect(
      await api.request(device, 'GET', `/conversations/${room.id}/messages`, {}),
    ).toMatchObject({ messages: [{ id: 'public', content: '最终回复' }] });
    await api.request(device, 'POST', `/conversations/${room.id}/messages`, {
      content: '工作',
      requestId: 'request-1',
    });
    expect(dispatch).toHaveBeenCalledWith('conversations.send', {
      conversationId: room.id,
      content: '工作',
      requestId: `device:${device.id}:request-1`,
    });
    await expect(
      api.request({ ...device, scopes: ['read'] }, 'POST', `/conversations/${room.id}/messages`, {
        content: '工作',
        requestId: 'request-1',
      }),
    ).rejects.toThrow('未获准');
    await expect(api.request(device, 'GET', '/conversations/other/messages', {})).rejects.toThrow(
      '未获准',
    );
    state.storage.put('tasks', { id: 'other-task', conversationId: 'other' } as Task);
    await expect(
      api.request(device, 'POST', `/conversations/${room.id}/stop`, { taskId: 'other-task' }),
    ).rejects.toThrow('不属于');
    expect((await api.request(device, 'GET', '/conversations', {})) as HostDevice[]).toHaveLength(
      1,
    );
  });
  it('请求正文等待期间撤销设备，正文完成后拒绝派发', async () => {
    const { service, dispatch, room, grant } = await setup();
    await service.request('hostAccess.configure', { enabled: true });
    const pair = service.devices.exchange({
      code: service.devices.createPairing(grant).code,
      name: '延迟请求设备',
    });
    let authenticated!: () => void;
    const started = new Promise<void>((resolve) => {
      authenticated = resolve;
    });
    const authenticate = service.devices.authenticate.bind(service.devices);
    const spy = vi.spyOn(service.devices, 'authenticate').mockImplementation((token) => {
      const device = authenticate(token);
      authenticated();
      return device;
    });
    const response = new Promise<number>((resolve, reject) => {
      const request = httpRequest(
        `${service.status().url}/conversations/${room.id}/messages`,
        {
          method: 'POST',
          headers: { authorization: `Bearer ${pair.token}`, 'content-type': 'application/json' },
        },
        (result) => {
          result.resume();
          resolve(result.statusCode!);
        },
      );
      request.on('error', reject);
      request.write('{"content":');
      void started
        .then(() => {
          service.devices.revoke(pair.device.id);
          request.end('"工作","requestId":"delayed-request"}');
        })
        .catch(reject);
    });
    try {
      expect(await response).toBe(401);
      expect(dispatch).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});
