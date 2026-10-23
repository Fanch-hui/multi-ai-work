export interface BrowserProfile {
  id: string;
  name: string;
  allowedBotIds: string[];
  createdAt: string;
}

export interface BrowserSession {
  id: string;
  profileId: string;
  taskId?: string;
  botId?: string;
  conversationId?: string;
  purpose?: 'setup' | 'task';
  status: 'active' | 'handoff' | 'closed';
  reason?: string;
  createdAt: string;
}

export interface BrowserTab {
  id: string;
  title: string;
  url: string;
  active: boolean;
}

export interface BrowserSnapshot {
  tabId: string;
  revision: string;
  url: string;
  title: string;
  text: string;
  elements: { ref: string; role: string; name: string }[];
  screenshot?: string;
}

export interface BrowserAction {
  tabId?: string;
  revision: string;
  action: 'click' | 'fill' | 'press' | 'select' | 'scroll' | 'back' | 'upload';
  ref?: string;
  text?: string;
  key?: string;
  x?: number;
  y?: number;
  deltaY?: number;
  artifactId?: string;
  path?: string;
}

export interface BrowserHostInput {
  sessionId: string;
  profileId?: string;
  url?: string;
  tabId?: string;
  screenshot?: boolean;
  action?: BrowserAction;
  operation?: 'list' | 'select' | 'close';
  bounds?: { x: number; y: number; width: number; height: number };
  visible?: boolean;
  interactive?: boolean;
  downloadDirectory?: string;
}

export interface BrowserDownload {
  path: string;
  name: string;
  mimeType: string;
  size: number;
}

export type BrowserHostMethod =
  | 'browser.open'
  | 'browser.snapshot'
  | 'browser.action'
  | 'browser.tabs'
  | 'browser.present'
  | 'browser.interactive'
  | 'browser.downloads'
  | 'browser.close';
