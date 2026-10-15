import type { Snapshot } from "../../../src/domain/types.js";
export type Request = <T = unknown>(method: string, params?: Record<string, unknown>) => Promise<T>;
interface DesktopBridge {
  request: Request;
  subscribe(listener: (event: unknown) => void): () => void;
}
const desktop = () => (window as Window & { aiTeam?: DesktopBridge }).aiTeam;
async function initializeWebSession(): Promise<void> {
  if (desktop()) return;
  const fragment = new URLSearchParams(window.location.hash.slice(1));
  const launchCode = fragment.get('web-launch');
  if (!launchCode) return;
  fragment.delete('web-launch');
  const remaining = fragment.toString();
  window.history.replaceState(window.history.state, '', `${window.location.pathname}${window.location.search}${remaining ? `#${remaining}` : ''}`);
  const response = await fetch('/api/session', {
    method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ launchCode }),
  });
  if (!response.ok) throw new Error('开发会话入口已失效，请重新启动 Core');
}
const webSessionReady = initializeWebSession();
void webSessionReady.catch(() => {});
export const request: Request = async <T>(method: string, params: Record<string, unknown> = {}): Promise<T> => {
  const bridge = desktop();
  if (bridge) return bridge.request<T>(method, params);
  await webSessionReady;
  const attachmentUpload = method === "conversations.attachBytes";
  const response = await fetch(attachmentUpload ? "/api/attachments" : "/api/rpc", {
    method: "POST",
    credentials: 'same-origin',
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(attachmentUpload ? params : { method, params }),
  });
  const value = await response.json();
  if (!response.ok || value.error)
    throw new Error(
      typeof value.error === "string" ? value.error : value.error?.message || `请求失败 (${response.status})`,
    );
  return (value.result ?? value) as T;
};
export async function snapshot(): Promise<Snapshot> {
  if (desktop()) return request<Snapshot>("state.snapshot");
  await webSessionReady;
  const response = await fetch("/api/snapshot", { credentials: 'same-origin' });
  if (!response.ok) throw new Error("无法连接本地 Core 服务");
  return response.json();
}
export function subscribe(listener: () => void): () => void {
  const bridge = desktop();
  if (bridge) return bridge.subscribe(listener);
  let events: EventSource | undefined, closed = false;
  void webSessionReady.then(() => {
    if (closed) return;
    events = new EventSource("/api/events");
    events.onmessage = listener;
    events.onopen = listener;
    events.onerror = listener;
  }).catch(() => { if (!closed) listener(); });
  return () => { closed = true; events?.close(); };
}
export async function choosePath(kind: "file" | "directory"): Promise<string | undefined> {
  const result = await request<string | { path?: string } | null>(
    kind === "file" ? "dialogs.chooseFile" : "dialogs.chooseDirectory",
  );
  return typeof result === "string" ? result : result?.path;
}
export function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/^Error invoking remote method 'team:request': (?:Error: )?/, '');
}
