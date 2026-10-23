export const hostApiVersion = '1' as const;

export type HostDeviceScope = 'read' | 'send' | 'stop';
export interface HostDevice {
  id: string;
  name: string;
  scopes: HostDeviceScope[];
  conversationIds: string[];
  createdAt: string;
  lastSeenAt?: string;
  revokedAt?: string;
}
export interface HostAccessStatus {
  apiVersion: typeof hostApiVersion;
  hostId: string;
  platform: string;
  enabled: boolean;
  url?: string;
  transport: 'loopback';
  activeTaskCount: number;
  capabilities: string[];
}
export interface ResidentSettings {
  available: boolean;
  openAtLogin: boolean;
  keepAwake: boolean;
}
