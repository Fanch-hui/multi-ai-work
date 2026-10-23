import { z } from 'zod';
import {
  hostApiVersion,
  type HostAccessStatus,
  type ResidentSettings,
} from '../domain/host-access.js';
import type { Task } from '../domain/types.js';
import type { HostRequest } from './artifact-requests.js';
import { HostDevices } from './host-access-devices.js';
import { HostAccessApi, type HostDispatch } from './host-access-api.js';
import { startHostAccessHttp } from './host-access-http.js';
import { id, type State } from './state.js';
import { terminal } from './tasks.js';

export class HostAccessService {
  readonly devices: HostDevices;
  private api: HostAccessApi;
  private server?: Awaited<ReturnType<typeof startHostAccessHttp>>;
  private starting?: ReturnType<typeof startHostAccessHttp>;
  private changing = false;
  constructor(
    private state: State,
    dispatch: HostDispatch,
    private host?: HostRequest,
  ) {
    this.devices = new HostDevices(state);
    this.api = new HostAccessApi(state, dispatch);
    if (!state.storage.metadata('host-access-id'))
      state.storage.setMetadata('host-access-id', id());
  }
  status(): HostAccessStatus {
    return {
      apiVersion: hostApiVersion,
      hostId: this.state.storage.metadata<string>('host-access-id')!,
      platform: process.platform,
      enabled: !!this.server,
      url: this.server?.url,
      transport: 'loopback',
      activeTaskCount: this.state.storage
        .all<Task>('tasks')
        .filter((task) => !terminal(task.status)).length,
      capabilities: ['conversations.read', 'conversations.send', 'tasks.stop'],
    };
  }
  async request(method: string, params: Record<string, unknown>) {
    switch (method) {
      case 'hostAccess.status':
        return this.status();
      case 'hostAccess.devices':
        return this.devices.list();
      case 'hostAccess.configure':
        return this.configure(z.boolean().parse(params.enabled));
      case 'hostAccess.pairing': {
        if (!this.server) throw new Error('请先启用本机接口');
        return this.devices.createPairing(params);
      }
      case 'hostAccess.revoke':
        return this.devices.revoke(z.string().parse(params.id));
      case 'hostAccess.resident.get':
        return this.host
          ? this.host('resident.get', {})
          : ({ available: false, openAtLogin: false, keepAwake: false } satisfies ResidentSettings);
      case 'hostAccess.resident.set': {
        if (!this.host) throw new Error('常驻设置需要桌面 App');
        const input = z.object({ openAtLogin: z.boolean(), keepAwake: z.boolean() }).parse(params);
        return this.host('resident.set', input);
      }
      default:
        throw new Error('不支持的宿主操作');
    }
  }
  async close() {
    await this.starting;
    const server = this.server;
    this.server = undefined;
    this.devices.clearPairing();
    await server?.close();
  }
  async resetAfterRestore() {
    await this.close();
    this.devices.reset();
    this.state.storage.setMetadata('host-access-id', id());
  }
  private async configure(enabled: boolean) {
    if (this.changing) throw new Error('正在更新接口状态');
    this.changing = true;
    try {
      if (enabled && !this.server) {
        this.starting = startHostAccessHttp(this.devices, this.api, () => this.status());
        try {
          this.server = await this.starting;
        } finally {
          this.starting = undefined;
        }
      }
      if (!enabled) await this.close();
      this.state.changed();
      return this.status();
    } finally {
      this.changing = false;
    }
  }
}
