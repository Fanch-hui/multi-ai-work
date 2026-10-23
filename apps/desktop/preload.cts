import { contextBridge, ipcRenderer } from 'electron';
import type { AppUpdateState } from '../../src/domain/app-update.js';
contextBridge.exposeInMainWorld('aiTeam', {
  subscribeNavigation: (listener: (conversationId: string) => void) => {
    const handler = (_event: unknown, conversationId: string) => listener(conversationId);
    ipcRenderer.on('team:navigate', handler);
    return () => ipcRenderer.removeListener('team:navigate', handler);
  },
  request: (method: string, params: Record<string, unknown> = {}) =>
    ipcRenderer.invoke('team:request', method, params),
  changeDataDirectory: (path: string) =>
    ipcRenderer.invoke('team:request', 'app.dataDirectory.change', { path }),
  subscribe: (listener: () => void) => {
    const handler = () => listener();
    ipcRenderer.on('team:changed', handler);
    return () => ipcRenderer.removeListener('team:changed', handler);
  },
  subscribeUpdates: (listener: (state: AppUpdateState) => void) => {
    const handler = (_event: unknown, state: AppUpdateState) => listener(state);
    ipcRenderer.on('team:update', handler);
    return () => ipcRenderer.removeListener('team:update', handler);
  },
});
