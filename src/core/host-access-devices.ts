import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { HostDevice } from '../domain/host-access.js';
import type { State } from './state.js';
import { id, now } from './state.js';

type StoredDevice = HostDevice & { tokenHash: string };
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const grantSchema = z.object({
  scopes: z
    .array(z.enum(['read', 'send', 'stop']))
    .min(1)
    .max(3),
  conversationIds: z.array(z.string().min(1)).min(1).max(100),
});
export class HostDevices {
  private pairing?: {
    hash: string;
    expiresAt: number;
    attempts: number;
    grant: z.infer<typeof grantSchema>;
  };
  constructor(private state: State) {}

  list(): HostDevice[] {
    return this.stored().map(({ tokenHash: _, ...device }) => device);
  }
  createPairing(input: unknown) {
    const grant = grantSchema.parse(input);
    for (const conversationId of grant.conversationIds) {
      const room = this.state.storage.get<{ archived?: boolean }>('conversations', conversationId);
      if (!room || room.archived) throw new Error('请选择有效会话');
    }
    const code = randomBytes(12).toString('base64url');
    const expiresAt = Date.now() + 5 * 60_000;
    this.pairing = { hash: hash(code), expiresAt, attempts: 0, grant };
    return { code, expiresAt: new Date(expiresAt).toISOString() };
  }
  exchange(input: unknown) {
    const parsed = z
      .object({ code: z.string().max(100), name: z.string().trim().min(1).max(80) })
      .parse(input);
    const pairing = this.pairing;
    if (!pairing || pairing.expiresAt < Date.now() || ++pairing.attempts > 5)
      throw new Error('配对码已失效，请在桌面重新生成');
    if (!timingSafeEqual(Buffer.from(hash(parsed.code)), Buffer.from(pairing.hash)))
      throw new Error('配对码无效');
    this.pairing = undefined;
    const token = randomBytes(32).toString('base64url');
    const device: StoredDevice = {
      id: id(),
      name: parsed.name,
      ...pairing.grant,
      createdAt: now(),
      tokenHash: hash(token),
    };
    this.save([...this.stored(), device]);
    const { tokenHash: _, ...publicDevice } = device;
    return { device: publicDevice, token };
  }
  authenticate(token: string): HostDevice | undefined {
    if (!token || token.length > 100) return;
    const tokenHash = hash(token);
    const devices = this.stored();
    const device = devices.find(
      (entry) =>
        !entry.revokedAt && timingSafeEqual(Buffer.from(entry.tokenHash), Buffer.from(tokenHash)),
    );
    if (!device) return;
    const seen = { ...device, lastSeenAt: now() };
    if (!device.lastSeenAt || Date.now() - Date.parse(device.lastSeenAt) > 60_000)
      this.save(
        devices.map((entry) => (entry.id === seen.id ? seen : entry)),
        false,
      );
    const { tokenHash: _, ...result } = seen;
    return result;
  }
  revoke(deviceId: string) {
    const devices = this.stored();
    if (!devices.some((device) => device.id === deviceId)) throw new Error('设备不存在');
    this.save(
      devices.map((device) => (device.id === deviceId ? { ...device, revokedAt: now() } : device)),
    );
    return { ok: true };
  }
  clearPairing() {
    this.pairing = undefined;
  }
  reset() {
    this.clearPairing();
    this.save([]);
  }
  private stored() {
    return this.state.storage.metadata<StoredDevice[]>('host-access-devices') ?? [];
  }
  private save(devices: StoredDevice[], notify = true) {
    this.state.storage.setMetadata('host-access-devices', devices);
    if (notify) this.state.changed();
  }
}
