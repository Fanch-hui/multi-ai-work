export type CoreRequest = {
  type: 'request';
  id: string;
  method: string;
  params?: Record<string, unknown>;
};

export type CoreResult = {
  type: 'result';
  id: string;
  result?: unknown;
  error?: string;
};

export type CoreHostRequest = {
  type: 'host';
  id: string;
  method: string;
  params: Record<string, unknown>;
};

export type CoreHostResult = {
  type: 'host-result';
  id: string;
  result?: unknown;
  error?: string;
};

export type DesktopToCoreMessage = CoreRequest | CoreHostResult | { type: 'close' };

export type CoreToDesktopMessage =
  | CoreResult
  | CoreHostRequest
  | { type: 'ready' | 'changed' | 'closed' }
  | { type: 'fatal'; error: string };
