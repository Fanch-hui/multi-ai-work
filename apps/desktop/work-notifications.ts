import { Notification, type BrowserWindow } from 'electron';

let activeConversationId: string | undefined;
export function setActiveConversation(id: string | undefined) {
  activeConversationId = id;
}

export function notifyWork(window: BrowserWindow | undefined, params: Record<string, unknown>) {
  if (!window || window.isDestroyed() || !Notification.isSupported()) return { shown: false };
  const conversationId = String(params.conversationId ?? '');
  if (window.isFocused() && conversationId === activeConversationId) return { shown: false };
  const notification = new Notification({
    title: String(params.title ?? 'multi-AI work'),
    body: String(params.body ?? ''),
  });
  notification.on('click', () => {
    if (window.isDestroyed()) return;
    window.show();
    window.focus();
    window.webContents.send('team:navigate', conversationId);
  });
  notification.show();
  return { shown: true };
}
