import type { SDKMessage } from '@qodercn-ai/qodercn-agent-sdk';
import { describe, expect, it } from 'vitest';
import type { ProviderEvent, RunContext } from '../src/domain/provider.js';
import { QoderEvents } from '../src/providers/native/qoder-events.js';

function fixture() {
  const events: ProviderEvent[] = [];
  const context: RunContext = {
    runId: 'run',
    bot: {} as RunContext['bot'],
    connection: {} as RunContext['connection'],
    binding: {} as RunContext['binding'],
    workspacePath: '/workspace',
    prompt: 'hello',
    messages: [],
    instructions: '',
    tools: [],
    signal: new AbortController().signal,
    emit: (event) => events.push(event),
    nativeMcp: { command: '', args: [], env: {} },
    nativeTools: {
      names: ['WebSearch'],
      authorize: async () => ({}),
      complete: async () => undefined,
      fail: () => {},
    },
    executeTool: async () => undefined,
    getSecret: async () => undefined,
    saveSecret: async () => {},
    persistBinding: () => {},
  };
  const projection = new QoderEvents(context);
  const accept = (message: unknown) => projection.accept(message as SDKMessage);
  const start = (id: string, name = 'NativeRead') =>
    accept({
      type: 'stream_event',
      parent_tool_use_id: null,
      event: {
        type: 'content_block_start',
        content_block: { type: 'tool_use', id, name, input: {} },
      },
    });
  const finish = (id: string, is_error = false, extra = {}) =>
    accept({
      type: 'user',
      parent_tool_use_id: null,
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: id, is_error, content: 'private result' }],
      },
      ...extra,
    });
  const tools = () => events.filter((event) => event.type === 'tool').map((event) => event.data);
  return { projection, accept, start, finish, tools };
}

describe('Qoder native tool lifecycle', () => {
  it.each([false, true])('uses the matching native tool result error flag: %s', (failed) => {
    const run = fixture();
    run.start('call');
    run.finish('call', failed);
    run.finish('call', failed);
    expect(run.tools()).toEqual([
      { source: 'native', callId: 'call', name: 'NativeRead', status: 'running' },
      {
        source: 'native',
        callId: 'call',
        name: 'NativeRead',
        status: failed ? 'failed' : 'completed',
      },
    ]);
    expect(JSON.stringify(run.tools())).not.toContain('private result');
  });

  it('keeps parallel calls independently active until each matching result arrives', () => {
    const run = fixture();
    run.start('first');
    run.start('second', 'NativeSearch');
    run.finish('first');
    run.accept({ type: 'assistant', message: { content: [{ type: 'text', text: 'Continuing' }] } });
    expect(run.tools().map((event) => [event.callId, event.status])).toEqual([
      ['first', 'running'],
      ['second', 'running'],
      ['first', 'completed'],
    ]);
    run.projection.beginReply();
    run.finish('second', true);
    expect(run.tools().at(-1)).toMatchObject({ callId: 'second', status: 'failed' });
  });

  it('leaves App-managed tools and unrelated or nested results to their existing owners', () => {
    const run = fixture();
    run.start('app', 'WebSearch');
    run.start('mcp', 'mcp__ai-team__read_file');
    run.finish('app');
    run.finish('mcp');
    run.finish('unknown');
    expect(run.tools()).toEqual([]);
    run.start('native');
    run.finish('native', false, { parent_tool_use_id: 'other-agent' });
    expect(run.tools()).toHaveLength(1);
    run.finish('native');
    expect(run.tools().at(-1)?.status).toBe('completed');
  });

  it('records explicit non-execution metadata as failure', () => {
    const run = fixture();
    run.start('denied');
    run.finish('denied', false, {
      tool_result_meta: [{ id: 'denied', non_execution_kind: 'user-rejected' }],
    });
    expect(run.tools().at(-1)?.status).toBe('failed');
  });
});
