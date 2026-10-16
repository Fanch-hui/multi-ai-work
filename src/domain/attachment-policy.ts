export const MAX_MESSAGE_ATTACHMENTS = 10;
export const ATTACHMENT_LIMIT_MESSAGE = `每条消息最多添加 ${MAX_MESSAGE_ATTACHMENTS} 个附件`;

export function requireAttachmentCapacity(existing: number, incoming: number) {
  if (existing + incoming > MAX_MESSAGE_ATTACHMENTS) throw new Error(ATTACHMENT_LIMIT_MESSAGE);
}
