import { describe, expect, it, vi } from 'vitest';
import type * as Qoder from '@qodercn-ai/qodercn-agent-sdk';
import type { RunContext } from '../src/domain/provider.js';
import { qoderModelPolicy, qoderServiceOptions } from '../src/providers/native/qoder-services.js';

function context(): RunContext {
  return { signal: new AbortController().signal, bot: { model: 'text-model', reasoning: 'high' },
    tools: [{ name: 'read_file' }], nativeTools: {
      names: ['WebSearch', 'WebFetch', 'ImageSearch', 'ImageGen', 'Bash', 'Agent'],
      authorize: vi.fn(async (_name, args) => ({ ...args, name: 'validated' })),
      complete: vi.fn(async () => ({ artifactId: 'generated-image' })), fail: vi.fn(),
    } } as unknown as RunContext;
}

function hookInput(event: 'PreToolUse' | 'PostToolUse' | 'PostToolUseFailure', name = 'ImageGen'): Qoder.HookInput {
  return { hook_event_name: event, tool_name: name, tool_input: { name: 'picture', prompt: 'scene' },
    tool_use_id: 'call-1', session_id: 'session', transcript_path: '/private/transcript', cwd: '/workspace',
    tool_response: { filePath: '/workspace/vibe_images/picture.png' }, error: 'cancelled' } as Qoder.HookInput;
}

async function callHook(options: Qoder.Options, event: Qoder.HookEvent, input: Qoder.HookInput) {
  return options.hooks![event]![0].hooks[0](input, 'call-1', { signal: new AbortController().signal });
}

describe('Qoder native service permissions', () => {
  it('exposes only authorized native services and rejects runtime control and file tools', async () => {
    const ctx = context(), options = qoderServiceOptions(ctx);
    expect(options.tools).toEqual(['WebSearch', 'WebFetch', 'ImageSearch', 'ImageGen']);
    expect(options.securityScan).toEqual({ l1StaticCheck: false, l2LightweightScan: false, l3DeepScan: false });
    for (const name of ['Bash', 'Read', 'Skill', 'Agent', 'TaskCreate', 'Write', 'unknown']) {
      expect(await options.canUseTool!(name, {}, { signal: ctx.signal, toolUseID: name })).toMatchObject({ behavior: 'deny' });
    }
    expect(await options.canUseTool!('mcp__ai-team__read_file', {}, { signal: ctx.signal, toolUseID: 'app' }))
      .toEqual({ behavior: 'allow', updatedInput: {} });
    expect(ctx.nativeTools!.authorize).not.toHaveBeenCalled();
  });

  it('authorizes once across hook and permission callbacks and passes the Core normalized input', async () => {
    const ctx = context(), options = qoderServiceOptions(ctx);
    expect(await callHook(options, 'PreToolUse', hookInput('PreToolUse'))).toMatchObject({
      hookSpecificOutput: { permissionDecision: 'allow', updatedInput: { name: 'validated' } },
    });
    expect(await options.canUseTool!('ImageGen', { name: 'picture', prompt: 'scene' }, { signal: ctx.signal, toolUseID: 'call-1' }))
      .toMatchObject({ behavior: 'allow', updatedInput: { name: 'validated' } });
    expect(ctx.nativeTools!.authorize).toHaveBeenCalledTimes(1);
  });

  it('enforces Core rejection for read-only native tools at the pre-tool hook', async () => {
    const ctx = context();
    ctx.nativeTools!.authorize = async () => { throw new Error('联网权限已关闭'); };
    expect(await callHook(qoderServiceOptions(ctx), 'PreToolUse', hookInput('PreToolUse', 'WebSearch'))).toMatchObject({
      hookSpecificOutput: { permissionDecision: 'deny', permissionDecisionReason: '联网权限已关闭' },
    });
  });

  it('returns registered artifact references and reports native failures without duplicating App tool completion', async () => {
    const ctx = context(), options = qoderServiceOptions(ctx);
    expect(await callHook(options, 'PostToolUse', hookInput('PostToolUse'))).toMatchObject({
      hookSpecificOutput: { updatedToolOutput: '{"artifactId":"generated-image"}' },
    });
    expect(ctx.nativeTools!.complete).toHaveBeenCalledWith('ImageGen', { name: 'picture', prompt: 'scene' }, 'call-1',
      { filePath: '/workspace/vibe_images/picture.png' });
    await callHook(options, 'PostToolUse', hookInput('PostToolUse', 'mcp__ai-team__read_file'));
    expect(ctx.nativeTools!.complete).toHaveBeenCalledTimes(1);
    await callHook(options, 'PostToolUseFailure', hookInput('PostToolUseFailure'));
    expect(ctx.nativeTools!.fail).toHaveBeenCalledWith('ImageGen', 'call-1', 'cancelled');
  });

  it('preserves cancellation during pending authorization', async () => {
    const ctx = context(), controller = new AbortController(); ctx.signal = controller.signal;
    ctx.nativeTools!.authorize = async (_name, args) => { controller.abort(new Error('用户取消')); return args; };
    await expect(qoderServiceOptions(ctx).canUseTool!('ImageGen', {}, { signal: ctx.signal, toolUseID: 'cancel' }))
      .rejects.toThrow('用户取消');
  });
});

describe('Qoder image model routing', () => {
  it('keeps the CLI image model and applies selected reasoning only to text calls', async () => {
    const policy = qoderModelPolicy(context())!;
    const request = { purpose: 'image_gen', resolvedModel: 'ge3i', availableModels: [], sessionId: 'session', turnIndex: 0 } as Qoder.ModelPolicyContext;
    expect(await policy(request)).toBeUndefined();
    expect(await policy({ ...request, purpose: 'main', availableModels: [{ value: 'text-model', displayName: 'Text', description: '', efforts: ['high'] }] }))
      .toEqual({ model: 'text-model', parameters: { reasoningEffort: 'high' } });
  });
});
