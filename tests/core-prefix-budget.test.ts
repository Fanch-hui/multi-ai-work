import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import type { Artifact, Task } from '../src/domain/types.js';
import type { ModelHistoryEntry } from '../src/runtime/model-history.js';
import { estimateTokens } from '../src/runtime/model-history.js';
import { createClient } from '../src/providers/managed/client.js';
import { runManaged } from '../src/providers/managed/loop.js';
import { eventually, setup } from './core-harness.js';

it('retains a stable request prefix across budgeted file tools and the following turn', async () => {
  const requests: {
    instructions: string;
    tools: { name: string }[];
    input: Record<string, unknown>[];
  }[] = [];
  const client = createClient('http://127.0.0.1:7777/v1', undefined, async (_url, init) => {
    requests.push(JSON.parse(String(init?.body)));
    const output =
      requests.length === 1
        ? [0, 1, 2].map((index) => ({
            type: 'function_call',
            id: `item-${index}`,
            call_id: `read-${index}`,
            name: 'read_file',
            arguments: JSON.stringify({ path: `source-${index}.txt` }),
            status: 'completed',
          }))
        : [
            {
              type: 'message',
              id: `reply-${requests.length}`,
              role: 'assistant',
              status: 'completed',
              content: [{ type: 'output_text', text: '已核对资料。', annotations: [] }],
            },
          ];
    return new Response(
      `data: ${JSON.stringify({ type: 'response.completed', response: { id: `r${requests.length}`, status: 'completed', output } })}\n\n`,
      { headers: { 'content-type': 'text/event-stream' } },
    );
  });
  const { core, bot, connection } = await setup((context) =>
    runManaged(client, context, 'responses'),
  );
  core.state.storage.put('connections', { ...connection, protocol: 'responses', status: 'ready' });
  const member = core.entities.saveBot({
    ...bot('资料助理', ['read_file', 'read_artifact']),
    contextWindow: 64000,
  });
  const workspace = core.state.snapshot().workspaces[0];
  const bodies = [0, 1, 2].map(
    (index) => `开头-${index}\n${'资料'.repeat(6000)}\n完整中段-${index}\n结尾-${index}`,
  );
  await Promise.all(
    bodies.map((body, index) => writeFile(join(workspace.path, `source-${index}.txt`), body)),
  );
  const room = core.entities.createConversation({
    name: '资料会话',
    kind: 'private',
    memberIds: [member.id],
    workspaceId: workspace.id,
  });
  const turn = async (content: string) => {
    const taskId = core.tasks.send({ conversationId: room.id, content }).taskIds[0];
    await eventually(
      () =>
        ['completed', 'failed'].includes(
          core.state.storage.get<Task>('tasks', taskId)?.status ?? '',
        ),
      10000,
    );
    expect(core.state.storage.get<Task>('tasks', taskId)?.status).toBe('completed');
    return taskId;
  };
  await turn('请读取并核对三份资料。');
  expect(requests).toHaveLength(2);
  const outputs = requests[1].input.filter((item) => item.type === 'function_call_output');
  expect(outputs.map((item) => item.call_id)).toEqual(['read-0', 'read-1', 'read-2']);
  expect(estimateTokens(outputs)).toBeLessThan(16000);
  const operations = core.state.storage.all<{
    name: string;
    result: { content: string; version: string };
  }>('tool_operations');
  expect(operations).toHaveLength(3);
  bodies.forEach((body, index) => {
    const operation = operations.find((item) => item.result.content === body)!;
    expect(operation).toBeDefined();
    expect(JSON.stringify(outputs[index])).toContain(operation.result.version);
  });
  const artifacts = core.state.storage.all<Artifact>('artifacts');
  expect(artifacts.filter((artifact) => artifact.purpose === 'intermediate')).toHaveLength(3);
  const archives = core.state.storage.all<{ entries: ModelHistoryEntry[] }>('provider_archive');
  const rawTools = archives
    .flatMap((record) => record.entries)
    .filter((entry) => entry.message.role === 'tool');
  expect(rawTools).toHaveLength(3);
  const firstUser = core.state.storage
    .messages(room.id)
    .find((message) => message.authorType === 'user')!;
  expect(
    archives
      .flatMap((record) => record.entries)
      .find((entry) => entry.message.role === 'user' && !entry.message.appContext),
  ).toMatchObject({ messageId: firstUser.id, sequence: firstUser.sequence });
  bodies.forEach((body, index) =>
    expect(JSON.parse(rawTools[index].message.content).content).toBe(body),
  );
  await turn('继续，保留刚才的资料依据。');
  expect(requests).toHaveLength(3);
  expect(requests[2].instructions).toBe(requests[0].instructions);
  expect(requests[2].tools).toEqual(requests[0].tools);
  expect(requests[2].input.slice(0, requests[0].input.length)).toEqual(requests[0].input);
});
