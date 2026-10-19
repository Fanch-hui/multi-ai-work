import { createServer, type Server, type ServerResponse } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ManagedProgress, ProviderEvent, RunContext } from '../src/domain/provider.js';
import { createClient } from '../src/providers/managed/client.js';
import { runManaged } from '../src/providers/managed/loop.js';

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    ),
  );
});
const call = (id: string, name = 'read') => ({
  type: 'function_call',
  id: `fc-${id}`,
  call_id: id,
  name,
  arguments: '{}',
  status: 'completed',
});
const answer = {
  type: 'message',
  id: 'answer',
  role: 'assistant',
  status: 'completed',
  content: [{ type: 'output_text', text: 'Done', annotations: [] }],
};
const done = (item: unknown, output_index: number) => ({
  type: 'response.output_item.done',
  output_index,
  item,
});
const terminal = (output: unknown[]) => ({
  type: 'response.completed',
  response: {
    id: 'response',
    status: 'completed',
    output,
    usage: { input_tokens: 1, output_tokens: 1 },
  },
});
const send = (response: ServerResponse, event: unknown) =>
  response.write(`data: ${JSON.stringify(event)}\n\n`);
const gate = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
};

async function fixture(
  first: (response: ServerResponse, index: number) => void | Promise<void>,
  repeat = false,
) {
  const requests: Record<string, unknown>[] = [];
  const server = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    requests.push(JSON.parse(body));
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    if (requests.length === 1 || repeat) await first(response, requests.length);
    else {
      send(response, terminal([answer]));
      response.end();
    }
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('fixture address');
  const url = `http://127.0.0.1:${address.port}/v1`;
  const saved: ManagedProgress[] = [];
  const events: ProviderEvent[] = [];
  const context: RunContext = {
    runId: 'run',
    bot: { model: 'model' } as RunContext['bot'],
    connection: {
      provider: 'custom',
      protocol: 'responses',
      baseUrl: url,
    } as RunContext['connection'],
    binding: {} as RunContext['binding'],
    workspacePath: '/workspace',
    prompt: 'go',
    messages: [],
    instructions: 'Help',
    tools: ['read', 'write'].map((name) => ({
      name,
      description: name,
      inputSchema: { type: 'object' },
    })),
    parallelToolNames: ['read'],
    signal: new AbortController().signal,
    nativeMcp: { command: '', args: [], env: {} },
    emit: (event) => {
      events.push(event);
    },
    executeTool: async () => ({}),
    getSecret: async () => undefined,
    saveSecret: async () => {},
    persistBinding: () => {},
    saveProgress: async (progress) => {
      saved.push(structuredClone(progress));
    },
  };
  return {
    context,
    saved,
    events,
    requests,
    run: () => runManaged(createClient(url), context, 'responses', [0]),
  };
}

describe('Responses early readonly tools', () => {
  it('persists complete calls and overlaps reads with the remaining stream, keeping write barriers and result order', async () => {
    const tail = gate();
    const reads = [gate(), gate()];
    let terminalSent = false;
    const items = [call('a'), call('b'), call('c', 'write'), call('d')];
    const f = await fixture(async (response) => {
      for (const [index, item] of items.entries()) send(response, done(item, index));
      await tail.promise;
      terminalSent = true;
      send(response, terminal(items));
      response.end();
    });
    const started: string[] = [];
    f.context.executeTool = async (_name, _args, id) => {
      expect(
        f.saved.some((progress) =>
          progress.messages.some((message) => message.toolCalls?.some((entry) => entry.id === id)),
        ),
      ).toBe(true);
      started.push(id);
      if (id === 'a' || id === 'b') {
        expect(terminalSent).toBe(false);
        await reads[id === 'a' ? 0 : 1].promise;
      }
      return id;
    };
    const running = f.run();
    await vi.waitFor(() => expect(started).toEqual(['a', 'b']));
    reads[1].resolve();
    await vi.waitFor(() =>
      expect(
        f.saved
          .at(-1)
          ?.messages.filter((message) => message.role === 'tool')
          .map((message) => message.callId),
      ).toEqual(['b']),
    );
    reads[0].resolve();
    tail.resolve();
    const result = await running;
    expect(started).toEqual(['a', 'b', 'c', 'd']);
    expect(
      result.messages
        ?.filter((message) => message.role === 'tool')
        .map((message) => message.callId),
    ).toEqual(['a', 'b', 'c', 'd']);
    expect(f.requests).toHaveLength(2);
  });

  it('retains complete protocol and results after stream failure and continues without repeating the call', async () => {
    const opaque = {
      type: 'reasoning',
      id: 'reason',
      encrypted_content: 'fixture-opaque',
      summary: [],
    };
    const f = await fixture((response) => {
      send(response, done(opaque, 0));
      send(response, done(call('a'), 1));
      send(response, {
        type: 'response.output_text.delta',
        output_index: 2,
        item_id: 'unfinished',
        content_index: 0,
        delta: 'unfinished',
      });
      response.end();
    });
    const started: string[] = [];
    f.context.executeTool = async (_name, _args, id) => {
      started.push(id);
      return { read: true };
    };
    const result = await f.run();
    expect(started).toEqual(['a']);
    expect(result.text).toBe('Done');
    expect(f.requests[1].input).toEqual([
      { role: 'user', content: 'go' },
      opaque,
      call('a'),
      { type: 'function_call_output', call_id: 'a', output: '{"read":true}' },
    ]);
    expect(f.events.some((event) => event.data.phase === 'model-error')).toBe(true);
    expect(f.events).toContainEqual({ type: 'text', data: { replace: '' } });
  });

  it('drains and saves every in-flight result before recovering a real socket disconnect', async () => {
    const reads = [gate(), gate()];
    let disconnected = false;
    const f = await fixture(async (response) => {
      send(response, done(call('a'), 0));
      send(response, done(call('b'), 1));
      await vi.waitFor(() => expect(started).toHaveLength(2));
      disconnected = true;
      response.socket!.destroy();
    });
    const started: string[] = [];
    f.context.executeTool = async (_name, _args, id) => {
      started.push(id);
      await reads[id === 'a' ? 0 : 1].promise;
      return id;
    };
    const running = f.run();
    await vi.waitFor(() => expect(disconnected).toBe(true));
    reads[0].resolve();
    await vi.waitFor(() =>
      expect(f.saved.at(-1)?.messages.some((message) => message.callId === 'a')).toBe(true),
    );
    expect(f.requests).toHaveLength(1);
    reads[1].resolve();
    await running;
    expect(started).toEqual(['a', 'b']);
    expect(f.requests).toHaveLength(2);
    expect(
      (f.requests[1].input as { type?: string; call_id?: string }[])
        .filter((item) => item.type === 'function_call_output')
        .map((item) => item.call_id),
    ).toEqual(['a', 'b']);
  });

  it('drains cancelled reads, saves successful results and stops new dispatch', async () => {
    const hold = gate();
    const read = gate();
    const f = await fixture(async (response) => {
      send(response, done(call('a'), 0));
      await hold.promise;
      send(response, done(call('b'), 1));
      send(response, terminal([call('a'), call('b')]));
      response.end();
    });
    const controller = new AbortController();
    f.context.signal = controller.signal;
    const started: string[] = [];
    f.context.executeTool = async (_name, _args, id) => {
      started.push(id);
      await read.promise;
      return id;
    };
    const running = f.run();
    const rejected = expect(running).rejects.toThrow('cancel');
    await vi.waitFor(() => expect(started).toEqual(['a']));
    controller.abort(new Error('cancel'));
    hold.resolve();
    read.resolve();
    await rejected;
    expect(started).toEqual(['a']);
    expect(f.saved.at(-1)?.messages).toContainEqual({ role: 'tool', callId: 'a', content: 'a' });
  });

  it('never dispatches before a completed call checkpoint succeeds', async () => {
    const f = await fixture((response) => {
      send(response, done(call('a'), 0));
      send(response, terminal([call('a')]));
      response.end();
    });
    let started = 0;
    f.context.executeTool = async () => {
      started++;
      return {};
    };
    f.context.saveProgress = async (progress) => {
      if (progress.phase === 'tools') throw new Error('disk failed');
    };
    await expect(f.run()).rejects.toThrow('disk failed');
    expect(started).toBe(0);
  });

  it('uses four rolling workers while the model stream is open', async () => {
    const tail = gate();
    const reads = Array.from({ length: 6 }, gate);
    const items = Array.from({ length: 6 }, (_, index) => call(String(index)));
    const f = await fixture(async (response) => {
      items.forEach((item, index) => send(response, done(item, index)));
      await tail.promise;
      send(response, terminal(items));
      response.end();
    });
    const started: string[] = [];
    let active = 0;
    let peak = 0;
    f.context.executeTool = async (_name, _args, id) => {
      started.push(id);
      peak = Math.max(peak, ++active);
      await reads[Number(id)].promise;
      active--;
      return id;
    };
    const running = f.run();
    await vi.waitFor(() => expect(started).toEqual(['0', '1', '2', '3']));
    reads[2].resolve();
    await vi.waitFor(() => expect(started).toEqual(['0', '1', '2', '3', '4']));
    reads[0].resolve();
    await vi.waitFor(() => expect(started).toHaveLength(6));
    tail.resolve();
    await vi.waitFor(() =>
      expect(f.events.some((event) => event.data.phase === 'model-response')).toBe(true),
    );
    // The request timing finishes independently of reads still running after terminal output.
    expect(active).toBeGreaterThan(0);
    reads.forEach((read) => read.resolve());
    await running;
    expect(peak).toBe(4);
  });

  it('keeps a leading write as a barrier until the terminal event', async () => {
    const tail = gate();
    const items = [call('a', 'write'), call('b')];
    const f = await fixture(async (response) => {
      items.forEach((item, index) => send(response, done(item, index)));
      await tail.promise;
      send(response, terminal(items));
      response.end();
    });
    const started: string[] = [];
    f.context.executeTool = async (_name, _args, id) => {
      started.push(id);
      return id;
    };
    const running = f.run();
    await vi.waitFor(() => expect(f.requests).toHaveLength(1));
    await new Promise((resolve) => setImmediate(resolve));
    expect(started).toEqual([]);
    tail.resolve();
    await running;
    expect(started).toEqual(['a', 'b']);
  });

  it('does not pass an unfinished earlier output item to start a later read', async () => {
    const tail = gate();
    const first = call('a', 'write');
    const second = call('b');
    const f = await fixture(async (response) => {
      send(response, {
        type: 'response.output_item.added',
        output_index: 0,
        item: { ...first, status: 'in_progress' },
      });
      send(response, done(second, 1));
      await tail.promise;
      send(response, terminal([first, second]));
      response.end();
    });
    const started: string[] = [];
    f.context.executeTool = async (_name, _args, id) => {
      started.push(id);
      return id;
    };
    const running = f.run();
    await vi.waitFor(() => expect(f.requests).toHaveLength(1));
    await new Promise((resolve) => setImmediate(resolve));
    expect(started).toEqual([]);
    tail.resolve();
    await running;
    expect(started).toEqual(['a', 'b']);
  });

  it('caps consecutive recoveries after confirmed tools and keeps every real result', async () => {
    const f = await fixture((response, index) => {
      if (index > 6) send(response, terminal([answer]));
      else send(response, done(call(String(index)), 0));
      response.end();
    }, true);
    const started: string[] = [];
    f.context.executeTool = async (_name, _args, id) => {
      started.push(id);
      return id;
    };
    await expect(f.run()).rejects.toThrow('response.completed');
    expect(f.requests).toHaveLength(6);
    expect(started).toEqual(['1', '2', '3', '4', '5', '6']);
    expect(
      f.saved
        .at(-1)
        ?.messages.filter((message) => message.role === 'tool')
        .map((message) => message.callId),
    ).toEqual(started);
    expect(f.saved.at(-1)?.earlyFailures).toBe(6);
    f.context.progress = f.saved.at(-1);
    await expect(f.run()).rejects.toThrow('自动恢复次数已耗尽');
    expect(f.requests).toHaveLength(6);
    let pending = true;
    f.context.userInput = {
      take: () => {
        if (!pending) return [];
        pending = false;
        return [{ role: 'user', content: 'try again' }];
      },
      hasPending: () => pending,
      beginReply: () => {},
      subscribe: () => () => {},
    };
    expect((await f.run()).text).toBe('Done');
    expect(f.requests).toHaveLength(7);
    expect(f.saved.at(-1)?.earlyFailures).toBe(0);
  });

  it('falls back to terminal execution when complete item events are unavailable', async () => {
    let terminalSent = false;
    const f = await fixture((response) => {
      send(response, {
        type: 'response.function_call_arguments.delta',
        item_id: 'fc-a',
        output_index: 0,
        delta: '{}',
      });
      terminalSent = true;
      send(response, terminal([call('a')]));
      response.end();
    });
    let started = 0;
    f.context.executeTool = async () => {
      expect(terminalSent).toBe(true);
      started++;
      return {};
    };
    await f.run();
    expect(started).toBe(1);
  });
});
