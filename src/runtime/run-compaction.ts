import type { ModelMessage } from '../domain/provider.js';
import type { Protocol } from '../domain/types.js';
import { balancedHistoryUnits, estimateModelMessagesTokens, toolsPaired } from './model-history.js';
import { summarizeUnits } from './context-summary.js';

interface RunCompactionOptions {
  currentStart: number;
  force: boolean;
  budget: number;
  trigger: number;
  fixedTokens: number;
  protocol: Protocol;
  signal: AbortSignal;
  summarize(prompt: string, signal: AbortSignal): Promise<string>;
  preserveToolOutput?(message: ModelMessage): Promise<{ text: string; artifactIds: string[] } | undefined>;
  preserveReferences?(messages: ModelMessage[], previousArtifactIds?: readonly string[]): Promise<{ text: string; artifactIds: string[] }>;
}

/** Original user inputs and the newest complete tool exchange remain directly readable. */
export async function compactRunMessages(original: ModelMessage[], options: RunCompactionOptions) {
  const estimate = (messages: ModelMessage[]) => options.fixedTokens + estimateModelMessagesTokens(messages, options.protocol);
  const originalSize = estimate(original);
  if (!options.force && originalSize <= options.trigger) return undefined;
  let messages = original;
  let currentStart = options.currentStart;
  for (let attempt = 0; attempt < 3; attempt++) {
    options.signal.throwIfAborted();
    const range = removableRange(messages, currentStart);
    if (!range) return compactLatestResult(messages, currentStart, options);
    const [start, end] = range;
    const history = messages.slice(start, end).map((message, sequence) => ({ message: { ...message }, sequence, messageId: String(sequence) }));
    let references = await options.preserveReferences?.(history.map(entry => entry.message),
      history.flatMap(entry => entry.message.contextArtifactIds ?? []));
    if (!options.preserveReferences && options.preserveToolOutput) {
      for (const entry of history) {
        if (entry.message.role !== 'tool' || entry.message.content.length <= 1200 || entry.message.contextArtifactIds?.length) continue;
        const preserved = await options.preserveToolOutput(entry.message);
        if (preserved?.artifactIds.length) {
          entry.message.contextArtifactIds = [...new Set([...(entry.message.contextArtifactIds ?? []), ...preserved.artifactIds])];
          references = {
            text: [references?.text, preserved.text].filter(Boolean).join('\n'),
            artifactIds: [...new Set([...(references?.artifactIds ?? []), ...preserved.artifactIds])],
          };
        }
      }
    }
    const content = await summarizeUnits(history, '', options.budget, options.summarize, options.signal);
    options.signal.throwIfAborted();
    const summary: ModelMessage = { role: 'assistant', contextSummary: true, contextArtifactIds: references?.artifactIds,
      content: `已完成工作摘要（历史资料）：\n${content}${references?.text ? `\n${references.text}` : ''}` };
    const next = [...messages.slice(0, start), summary, ...messages.slice(end)];
    if (estimate(next) >= estimate(messages)) return compactLatestResult(messages, currentStart, options);
    if (start < currentStart) currentStart = currentStart - (Math.min(end, currentStart) - start) + 1;
    messages = next;
    if (estimate(messages) <= options.trigger && estimate(messages) < originalSize) return { messages, currentStart };
  }
  return compactLatestResult(messages, currentStart, options);
}

async function compactLatestResult(messages: ModelMessage[], currentStart: number, options: RunCompactionOptions) {
  if (!options.preserveToolOutput) return undefined;
  let assistant = messages.length - 1;
  while (assistant >= currentStart && !messages[assistant].toolCalls?.length) assistant--;
  if (assistant < currentStart) return undefined;
  const exchange = messages.slice(assistant);
  const entries = exchange.map((message, sequence) => ({ message, sequence, messageId: String(sequence) }));
  if (!toolsPaired(entries)) return undefined;
  const candidates = exchange.filter(message => message.role === 'tool' && !message.contextSummary)
    .sort((a, b) => b.content.length - a.content.length);
  let next = [...messages];
  for (const tool of candidates.slice(0, 3)) {
    options.signal.throwIfAborted();
    const reference = await options.preserveToolOutput(tool);
    if (!reference?.artifactIds.length) return undefined;
    const call = messages[assistant].toolCalls!.find(call => call.id === tool.callId);
    if (!call) return undefined;
    const annotatedTool: ModelMessage = {
      ...tool,
      contextArtifactIds: [...new Set([...(tool.contextArtifactIds ?? []), ...reference.artifactIds])],
    };
    const history = [{ ...messages[assistant], toolCalls: [call] }, annotatedTool]
      .map((message, sequence) => ({ message, sequence, messageId: String(sequence) }));
    const summary = await summarizeUnits(history, '', options.budget, options.summarize, options.signal);
    const replacement = { ...tool, providerItems: undefined, contextSummary: true, contextArtifactIds: reference.artifactIds,
      content: `工具结果摘要：\n${summary}\n${reference.text}` };
    if (estimateModelMessagesTokens([replacement], options.protocol) >= estimateModelMessagesTokens([tool], options.protocol)) return undefined;
    next = next.map(message => message === tool ? replacement : message);
    if (options.fixedTokens + estimateModelMessagesTokens(next, options.protocol) <= options.trigger) return { messages: next, currentStart };
  }
  return undefined;
}

function removableRange(messages: ModelMessage[], currentStart: number): [number, number] | undefined {
  if (currentStart > 0 && estimateModelMessagesTokens(messages.slice(0, currentStart)) > 256
    && !(currentStart === 1 && messages[0].contextSummary) && toolsPaired(messages.slice(0, currentStart).map((message, sequence) => ({ message, sequence, messageId: String(sequence) }))))
    return [0, currentStart];
  const units = balancedHistoryUnits(messages.map((message, sequence) => ({ message, sequence, messageId: String(sequence) })));
  let latest = -1;
  units.forEach((unit, index) => {
    if (unit.some(entry => entry.message.role === 'assistant' && entry.message.toolCalls?.length) && toolsPaired(unit)) latest = index;
  });
  let start = -1, end = -1;
  for (let index = 0; index < units.length; index++) {
    const unit = units[index];
    const eligible = unit[0].sequence >= currentStart && index < (latest < 0 ? units.length - 1 : latest) && toolsPaired(unit)
      && !unit.some(entry => entry.message.role === 'user' && entry.message.appContext?.source !== 'app.repeat-tool-reminder');
    if (eligible) {
      start = start < 0 ? unit[0].sequence : start;
      end = unit.at(-1)!.sequence + 1;
    } else if (start >= 0) break;
  }
  return start >= 0 ? [start, end] : undefined;
}
