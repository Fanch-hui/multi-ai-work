export interface ComputerApp {
  bundleId: string;
  name: string;
  pid: number;
}
export interface ComputerGrant {
  bundleId: string;
  name: string;
  allowedBotIds: string[];
}
export interface ComputerSettings {
  enabled: boolean;
  grants: ComputerGrant[];
}
export interface ComputerCapabilities {
  available: boolean;
  accessibility: boolean;
  screenCapture: boolean;
  guidance?: string;
}
export interface ComputerElement {
  ref: string;
  role: string;
  name: string;
  editable: boolean;
}
export interface ComputerObservation {
  revision: string;
  bundleId: string;
  windowId: number;
  title: string;
  elements: ComputerElement[];
  screenshot?: string;
  sensitive: boolean;
}
export type ComputerAction = {
  revision: string;
  action: 'click' | 'fill' | 'press' | 'scroll';
  ref?: string;
  text?: string;
  key?: string;
  deltaY?: number;
};
export interface ComputerSession {
  id: string;
  taskId: string;
  runId: string;
  botId: string;
  conversationId: string;
  bundleId: string;
  status: 'active' | 'handoff';
}
export type ComputerHostMethod =
  | 'computer.capabilities'
  | 'computer.apps'
  | 'computer.observe'
  | 'computer.action'
  | 'computer.release'
  | 'computer.permissions';
export type ComputerHostRequest = (
  method: ComputerHostMethod,
  params?: Record<string, unknown>,
) => Promise<unknown>;
