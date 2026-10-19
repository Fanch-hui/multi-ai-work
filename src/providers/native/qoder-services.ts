import type * as Qoder from '@qodercn-ai/qodercn-agent-sdk';
import type { RunContext } from '../../domain/provider.js';

const serviceNames = new Set(['WebSearch', 'WebFetch', 'ImageSearch', 'ImageGen']);
const denied = '请使用已授权的 multi-AI work 工具执行操作';

export function qoderServiceOptions(
  context: RunContext,
): Pick<Qoder.Options, 'tools' | 'canUseTool' | 'hooks' | 'securityScan'> {
  const appTools = new Set(context.tools.map((tool) => `mcp__ai-team__${tool.name}`));
  const nativeTools = new Set(
    context.nativeTools?.names.filter((name) => serviceNames.has(name)) ?? [],
  );
  const authorized = new Map<string, Promise<Record<string, unknown>>>();
  const authorize = async (name: string, args: Record<string, unknown>, callId: string) => {
    context.signal.throwIfAborted();
    if (appTools.has(name)) return args;
    if (!nativeTools.has(name) || !context.nativeTools) throw new Error(denied);
    const key = `${name}:${callId}`;
    if (!authorized.has(key))
      authorized.set(key, context.nativeTools.authorize(name, args, callId));
    const input = await authorized.get(key)!;
    context.signal.throwIfAborted();
    return input;
  };
  const permission: Qoder.CanUseTool = async (name, args, options) => {
    try {
      options.signal.throwIfAborted();
      return { behavior: 'allow', updatedInput: await authorize(name, args, options.toolUseID) };
    } catch (error) {
      context.signal.throwIfAborted();
      options.signal.throwIfAborted();
      return { behavior: 'deny', message: error instanceof Error ? error.message : denied };
    }
  };
  return {
    tools: [...nativeTools],
    canUseTool: permission,
    securityScan: { l1StaticCheck: false, l2LightweightScan: false, l3DeepScan: false },
    hooks: {
      PreToolUse: [
        {
          hooks: [
            async (input) => {
              if (input.hook_event_name !== 'PreToolUse') return {};
              const decision = await permission(input.tool_name, toolInput(input.tool_input), {
                signal: context.signal,
                toolUseID: input.tool_use_id,
              });
              return {
                hookSpecificOutput: {
                  hookEventName: 'PreToolUse',
                  permissionDecision: decision.behavior,
                  ...(decision.behavior === 'allow'
                    ? { updatedInput: decision.updatedInput }
                    : { permissionDecisionReason: decision.message }),
                },
              };
            },
          ],
        },
      ],
      PostToolUse: [
        {
          hooks: [
            async (input) => {
              if (input.hook_event_name !== 'PostToolUse' || !nativeTools.has(input.tool_name))
                return {};
              const result = await context.nativeTools!.complete(
                input.tool_name,
                toolInput(input.tool_input),
                input.tool_use_id,
                input.tool_response,
              );
              return {
                hookSpecificOutput: {
                  hookEventName: 'PostToolUse',
                  updatedToolOutput: typeof result === 'string' ? result : JSON.stringify(result),
                },
              };
            },
          ],
        },
      ],
      PostToolUseFailure: [
        {
          hooks: [
            async (input) => {
              if (
                input.hook_event_name === 'PostToolUseFailure' &&
                nativeTools.has(input.tool_name)
              ) {
                context.nativeTools!.fail(input.tool_name, input.tool_use_id, input.error);
              }
              return {};
            },
          ],
        },
      ],
    },
  };
}

function toolInput(input: unknown): Record<string, unknown> {
  return input && typeof input === 'object' && !Array.isArray(input)
    ? (input as Record<string, unknown>)
    : {};
}

export function qoderModelPolicy(context: RunContext): Qoder.ModelPolicyProvider | undefined {
  if (!context.bot.reasoning) return undefined;
  return (modelContext) => {
    // ImageGen chooses its own image model and must not inherit text-model settings.
    if (modelContext.purpose === 'image_gen') return undefined;
    const model = modelContext.availableModels.find(
      (value) => value.value === context.bot.model && value.isEnabled !== false,
    );
    const reasoning = model?.efforts ?? Object.keys(model?.thinking_config?.enabled?.efforts ?? {});
    if (!reasoning.includes(context.bot.reasoning!)) throw new Error('Qoder 不支持所选思考强度');
    return { model: context.bot.model, parameters: { reasoningEffort: context.bot.reasoning } };
  };
}
