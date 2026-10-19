import type { Message } from '../../../src/domain/types.js';

export function readableBotMessageIds(messages: Message[], conversationId: string): string[] {
  return messages
    .filter(
      (message) =>
        message.conversationId === conversationId &&
        message.authorType === 'bot' &&
        (message.content.trim().length > 0 || message.artifactIds.length > 0),
    )
    .map((message) => message.id);
}

export class ConversationReadReceipts {
  private acknowledged = new Set<string>();
  private pending = false;

  async mark(
    conversationId: string,
    messageIds: string[],
    send: (params: { id: string; messageIds: string[] }) => Promise<unknown>,
  ): Promise<boolean> {
    if (this.pending) return false;
    const ids = [...new Set(messageIds)].filter((id) => !this.acknowledged.has(id));
    if (!ids.length) return false;
    this.pending = true;
    try {
      await send({ id: conversationId, messageIds: ids });
      ids.forEach((id) => this.acknowledged.add(id));
      return true;
    } finally {
      this.pending = false;
    }
  }
}
