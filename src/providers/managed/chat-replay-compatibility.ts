import type { ModelMessage, RunContext } from '../../domain/provider.js';
import { chatReplayFields, type ChatReplayField } from './chat-replay.js';

const empty = new Set<ChatReplayField>();
const unsupported =
  /(?:unknown|unsupported|unrecognized|unrecognised|unexpected|not supported|not permitted|not allowed|not recognized)/i;

function namesRejectedField(name: ChatReplayField, param: string, message: string): boolean {
  const token = `(?:^|[^a-z_])${name}(?:$|[^a-z_])`;
  if (new RegExp(token, 'i').test(param)) return true;
  const qualifier = '(?:unknown|unsupported|unrecognized|unrecognised|unexpected)';
  return (
    new RegExp(
      `${qualifier}(?: request| input)? (?:parameter|argument|field|property|key)[^\\n]{0,100}${token}`,
      'i',
    ).test(message) ||
    new RegExp(
      `${token}[^\\n]{0,30}(?:not supported|not permitted|not allowed|not recognized)`,
      'i',
    ).test(message)
  );
}

export class ChatReplayCompatibility {
  private rejected = new Map<string, Set<ChatReplayField>>();
  fields(context: RunContext): ReadonlySet<ChatReplayField> {
    return this.rejected.get(this.key(context)) ?? empty;
  }
  reject(error: unknown, context: RunContext, messages: ModelMessage[]): boolean {
    if (!error || typeof error !== 'object') return false;
    const failure = error as {
      status?: number;
      partialOutput?: boolean;
      message?: string;
      param?: string;
      error?: { message?: string; param?: string; code?: string };
    };
    if (![400, 422].includes(failure.status ?? 0) || failure.partialOutput) return false;
    const message = failure.error?.message ?? failure.message ?? '';
    if (!unsupported.test(message)) return false;
    const param = failure.error?.param ?? failure.param ?? '';
    const sent = new Set(
      messages.flatMap((item) =>
        Object.keys(
          chatReplayFields(item, {
            bindingId: context.binding.id,
            generation: context.binding.generation,
            rejectedFields: this.fields(context),
          }),
        ),
      ) as ChatReplayField[],
    );
    const field = [...sent].find((name) => namesRejectedField(name, param, message));
    if (!field) return false;
    const key = this.key(context);
    const fields = this.rejected.get(key) ?? new Set<ChatReplayField>();
    fields.add(field);
    this.rejected.delete(key);
    this.rejected.set(key, fields);
    if (this.rejected.size > 256) this.rejected.delete(this.rejected.keys().next().value!);
    return true;
  }
  clear() {
    this.rejected.clear();
  }
  private key(context: RunContext): string {
    return JSON.stringify([
      context.connection.id,
      context.connection.revision,
      context.connection.baseUrl,
      context.bot.model,
      'chat-completions',
    ]);
  }
}
