import { contextBridge, ipcRenderer } from 'electron';
contextBridge.exposeInMainWorld('aiTeam', {
  request: (method: string, params: Record<string, unknown> = {}) => ipcRenderer.invoke('team:request', method, params),
  subscribe: (listener: () => void) => {
    const handler = () => listener(); ipcRenderer.on('team:changed', handler);
    return () => ipcRenderer.removeListener('team:changed', handler);
  },
});
