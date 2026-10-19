import { z } from 'zod';
import type { Conversation, Run } from '../domain/types.js';
import type { State } from './state.js';
import { readConversation } from './conversation-read.js';
import { required } from './errors.js';

export class HistoryRequests {
  constructor(private state: State) {}

  async request(method: string, params: Record<string, unknown>): Promise<unknown> {
    const s = this.state.storage;
    const objectId = () => z.string().parse(params.id);
    switch (method) {
      case 'state.snapshot':
        return this.state.snapshot();
      case 'state.view':
        return this.state.sync.view(
          z.string().optional().parse(params.conversationId),
          z.number().int().positive().optional().parse(params.from),
        );
      case 'state.changes':
        return this.state.sync.delta(
          z
            .object({
              epoch: z.string(),
              version: z.number().int().nonnegative(),
              eventSequence: z.number().int().nonnegative().optional(),
            })
            .parse(params.cursor),
          z.string().optional().parse(params.conversationId),
        );
      case 'conversations.messages': {
        const room = required(s.get<Conversation>('conversations', objectId()), '对话不存在');
        return s.messagePage(
          room.id,
          z.number().int().positive().optional().parse(params.before),
          z.number().int().min(1).max(200).optional().parse(params.limit),
        );
      }
      case 'messages.get':
        return z
          .array(z.string())
          .max(200)
          .parse(params.ids)
          .map((id) => s.getMessage(id))
          .filter(Boolean);
      case 'conversations.read': {
        const changed = readConversation(
          s,
          objectId(),
          z.array(z.string()).parse(params.messageIds),
        );
        if (changed) this.state.changed();
        return { ok: true };
      }
      case 'runs.events': {
        const run = required(s.get<Run>('runs', objectId()), '运行记录不存在');
        return s.runEvents(
          run.id,
          z.number().int().positive().optional().parse(params.cursor),
          z.number().int().min(1).max(200).optional().parse(params.limit),
        );
      }
      default:
        throw new Error('不支持的应用操作');
    }
  }
}
