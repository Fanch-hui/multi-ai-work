import type { ProviderEvent } from '../../domain/provider.js';
import type { Usage } from '../../domain/types.js';
import { ModelActivity } from '../activity.js';
import { hasOutputText } from '../first-output.js';

export interface AntigravityUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_tokens?: number;
  thinking_tokens?: number;
  total_tokens?: number;
}
export interface AntigravityInitialization {
  conversationId: string;
  cwd: string;
  tools: string[];
  permissionMode: string;
  model?: string;
  agent?: string;
}
export interface AntigravityTurn {
  text: string;
  nativeSessionId: string;
  usage: Usage;
  cumulativeUsage?: AntigravityUsage;
}
type ObjectValue = Record<string, unknown>;
const object = (value: unknown): ObjectValue | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as ObjectValue)
    : undefined;
const tokenFields = [
  'input_tokens',
  'output_tokens',
  'cache_read_tokens',
  'thinking_tokens',
  'total_tokens',
] as const;

function usageValue(value: unknown): AntigravityUsage | undefined {
  const source = object(value);
  if (!source) return undefined;
  const usage: AntigravityUsage = {};
  for (const name of tokenFields)
    if (typeof source[name] === 'number' && Number.isFinite(source[name]) && source[name] >= 0)
      usage[name] = source[name];
  return Object.keys(usage).length ? usage : undefined;
}

export class AntigravityEvents {
  initialization?: AntigravityInitialization;
  text = '';
  private turnSequence = 0;
  private stepUsage = new Map<number, AntigravityUsage>();
  private activity: ModelActivity;
  private workStarted = false;
  constructor(
    private options: {
      expectedSessionId?: string;
      previousUsage?: AntigravityUsage;
      emit?: (event: ProviderEvent) => void;
    } = {},
  ) {
    this.activity = new ModelActivity(options.emit);
  }

  nextTurn(previousUsage?: AntigravityUsage): void {
    this.text = '';
    this.turnSequence++;
    this.stepUsage.clear();
    this.activity.reset();
    this.options.previousUsage = previousUsage;
    this.options.expectedSessionId = this.initialization?.conversationId;
  }

  accept(value: unknown): AntigravityTurn | undefined {
    const event = object(value);
    if (!event || typeof event.event !== 'string')
      throw new Error('Antigravity 返回了无效协议事件');
    if (event.event === 'init') this.initialize(event);
    else if (event.event === 'step_update') this.step(object(event.step_update));
    else if (event.event === 'result') return this.finish(object(event.result));
    return undefined;
  }

  private initialize(event: ObjectValue): void {
    if (this.initialization) throw new Error('Antigravity 重复初始化会话');
    const init = object(event.init),
      id = event.conversation_id;
    if (
      !init ||
      typeof id !== 'string' ||
      !id ||
      typeof init.cwd !== 'string' ||
      !Array.isArray(init.tools) ||
      !init.tools.every((tool) => typeof tool === 'string') ||
      typeof init.permission_mode !== 'string'
    )
      throw new Error('Antigravity 初始化信息不完整');
    if (this.options.expectedSessionId && id !== this.options.expectedSessionId)
      throw new Error('Antigravity 返回了其他原生会话');
    this.initialization = {
      conversationId: id,
      cwd: init.cwd,
      tools: init.tools as string[],
      permissionMode: init.permission_mode,
      model: typeof init.model === 'string' ? init.model : undefined,
      agent: typeof init.agent === 'string' ? init.agent : undefined,
    };
  }

  private validateSession(payload: ObjectValue | undefined): ObjectValue {
    if (!this.initialization || !payload) throw new Error('Antigravity 在初始化前返回了轮次事件');
    if (payload.conversation_id !== this.initialization.conversationId)
      throw new Error('Antigravity 返回了其他原生会话');
    return payload;
  }

  private step(value: ObjectValue | undefined): void {
    const step = this.validateSession(value);
    if (typeof step.step_index !== 'number' || !Number.isInteger(step.step_index))
      throw new Error('Antigravity 返回了无效步骤序号');
    if (step.state === 'ACTIVE') {
      let phase: 'tool' | 'responding' | 'working' = 'working';
      if (step.step_type === 'tool') phase = 'tool';
      else if (step.step_type === 'agent_response' && step.text_delta) phase = 'responding';
      this.activity.report(phase, `step_update:${step.step_type}`);
    }
    if (step.step_type === 'agent_response' && typeof step.text_delta === 'string')
      this.append(step.text_delta, `${this.turnSequence}:${step.step_index}`);
    if (step.state === 'DONE') {
      const usage = usageValue(step.usage);
      if (usage) this.stepUsage.set(step.step_index, usage);
    }
    if (step.step_type === 'tool' && typeof step.tool_name === 'string') {
      if (hasOutputText(step.tool_name)) this.markWorkStarted();
      const toolStatus = () => {
        if (step.state !== 'DONE') return 'running';
        return object(step.tool_info)?.error ? 'failed' : 'completed';
      };
      this.options.emit?.({
        type: 'tool',
        data: {
          source: 'native',
          name: step.tool_name,
          callId: `${this.initialization!.conversationId}:${this.turnSequence}:${step.step_index}`,
          status: toolStatus(),
        },
      });
    }
  }

  private finish(value: ObjectValue | undefined): AntigravityTurn {
    const result = this.validateSession(value);
    if (result.status !== 'SUCCESS') throw new Error('Antigravity 未完成当前轮次');
    const text =
      typeof result.response === 'string' && result.response.trim() ? result.response : this.text;
    if (!text.trim()) throw new Error('Antigravity 返回空结果');
    if (!this.text) this.append(text);
    const cumulativeUsage = usageValue(result.usage),
      usage = this.turnUsage(cumulativeUsage);
    this.options.emit?.({ type: 'usage', data: { ...usage, scope: 'turn' } });
    this.options.emit?.({ type: 'status', data: { stopReason: 'SUCCESS' } });
    return { text, nativeSessionId: this.initialization!.conversationId, usage, cumulativeUsage };
  }

  private turnUsage(cumulative?: AntigravityUsage): Usage {
    const previous = this.options.previousUsage;
    if (cumulative && (!this.options.expectedSessionId || previous)) {
      const delta: AntigravityUsage = {};
      for (const field of tokenFields) {
        if (cumulative[field] === undefined || (previous && previous[field] === undefined))
          continue;
        const amount = cumulative[field]! - (previous?.[field] ?? 0);
        if (amount < 0) return this.stepsUsage();
        delta[field] = amount;
      }
      return this.usage(delta);
    }
    return this.stepsUsage();
  }

  private stepsUsage(): Usage {
    const total: AntigravityUsage = {};
    const steps = [...this.stepUsage.values()];
    for (const field of tokenFields)
      if (steps.length && steps.every((usage) => usage[field] !== undefined))
        total[field] = steps.reduce((sum, usage) => sum + usage[field]!, 0);
    return this.usage(total);
  }

  private usage(value: AntigravityUsage): Usage {
    if (value.input_tokens === undefined && value.output_tokens === undefined)
      return { source: 'unknown' };
    return {
      inputTokens: value.input_tokens,
      outputTokens: value.output_tokens,
      cachedInputTokens: value.cache_read_tokens,
      source: 'reported',
    };
  }

  private append(delta: string, messageKey = `${this.turnSequence}:result`): void {
    if (hasOutputText(delta)) this.markWorkStarted();
    this.text += delta;
    this.options.emit?.({ type: 'text', data: { delta, messageKey: `agy:${messageKey}` } });
  }

  private markWorkStarted(): void {
    if (this.workStarted) return;
    this.workStarted = true;
    this.options.emit?.({ type: 'status', data: { phase: 'model-work-started' } });
  }
}
