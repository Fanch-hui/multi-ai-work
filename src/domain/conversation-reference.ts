import { z } from 'zod';

export const conversationReferenceSchema = z.object({
  kind: z.enum(['skill', 'connector', 'routine', 'conversation']),
  id: z.string().min(1).max(200),
});
export type ConversationReference = z.infer<typeof conversationReferenceSchema>;
export interface ConversationReferenceOption extends ConversationReference {
  label: string;
  description?: string;
}
