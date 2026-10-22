import type { FormEvent, ReactElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Connection, Snapshot } from '../src/domain/types.js';
import type { PresetInstallation, PresetMemberResult } from '../src/domain/market.js';
import type { Mutate } from '../apps/ui/src/store.js';
import { ConfigurePresets } from '../apps/ui/src/market/ConfigurePresets.js';
import { MemberConfiguration } from '../apps/ui/src/market/MemberConfiguration.js';
import { ConnectionEditor } from '../apps/ui/src/ConnectionEditor.js';
import { Button, Modal } from '../apps/ui/src/components.js';
import { ConnectionAuthorization } from '../apps/ui/src/ConnectionAuthorization.js';

const hooks = vi.hoisted(() => ({ values: [] as unknown[], cursor: 0 }));
vi.mock('react', async (original) => ({
  ...(await original<typeof import('react')>()),
  useState: <T>(initial: T | (() => T)) => {
    const index = hooks.cursor++;
    if (!(index in hooks.values))
      hooks.values[index] = typeof initial === 'function' ? (initial as () => T)() : initial;
    return [
      hooks.values[index],
      (next: T | ((value: T) => T)) => {
        hooks.values[index] =
          typeof next === 'function' ? (next as (value: T) => T)(hooks.values[index] as T) : next;
      },
    ];
  },
}));

function elements(node: unknown): ReactElement<Record<string, unknown>>[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!node || typeof node !== 'object') return [];
  const element = node as ReactElement<Record<string, unknown>>;
  return [element, ...elements(element.props?.children)];
}

function element(tree: unknown, type: unknown) {
  const found = elements(tree).find((item) => item.type === type);
  expect(found).toBeDefined();
  return found!;
}

function installation(id: string): PresetInstallation {
  return {
    id,
    source: 'official',
    status: 'installed',
    progress: 100,
    skillIds: [],
    createdAt: '',
    preset: {
      id,
      version: '1',
      name: id,
      role: 'reviewer',
      description: '',
      professions: [],
      rank: 1,
      instructions: '',
      examples: [],
      outputs: [],
      skills: [],
      dependencies: [],
      platforms: ['darwin'],
      license: 'MIT',
      releaseNotes: '',
    },
  };
}

const connection = {
  id: 'connection',
  name: 'API',
  provider: 'custom',
  status: 'ready',
  models: [{ id: 'model', name: 'Model' }],
} as Connection;
const event = { preventDefault() {} } as FormEvent;

function workflow(installations: PresetInstallation[]) {
  let data = { connections: [connection], toolConnections: [], skills: [] } as unknown as Snapshot;
  const close = vi.fn();
  const mutate = vi.fn();
  const created = vi.fn();
  return {
    close,
    mutate,
    created,
    connect(next: Connection) {
      data = { ...data, connections: [...data.connections, next] };
    },
    render() {
      hooks.cursor = 0;
      return ConfigurePresets({ installations, data, close, created, mutate: mutate as Mutate });
    },
  };
}

function updateMember(tree: unknown, fields: Record<string, unknown>) {
  const change = element(tree, MemberConfiguration).props.change as (value: typeof fields) => void;
  change(fields);
}

function addConnection(tree: unknown) {
  const open = element(tree, MemberConfiguration).props.configureConnection as () => void;
  open();
}

describe('hiring connection step', () => {
  beforeEach(() => {
    hooks.values = [];
    hooks.cursor = 0;
  });

  it('returns from connection configuration with a single member draft intact', () => {
    const flow = workflow([installation('first')]);
    updateMember(flow.render(), {
      name: 'My reviewer',
      connectionId: connection.id,
      model: 'model',
      personalInstructions: 'Keep the tables',
      contextWindow: '64000',
    });
    const before = element(flow.render(), MemberConfiguration).props.value;
    addConnection(flow.render());
    const step = flow.render();
    expect(elements(step).some((item) => item.type === 'form')).toBe(false);
    const editor = element(step, ConnectionEditor);
    expect(editor.props.inline).toBe(true);
    (editor.props.close as () => void)();
    expect(element(flow.render(), MemberConfiguration).props.value).toBe(before);
    expect(flow.close).not.toHaveBeenCalled();
  });

  it('returns on modal dismissal and makes a new connection available for explicit selection', () => {
    const flow = workflow([installation('first')]);
    addConnection(flow.render());
    (element(flow.render(), Modal).props.onOpenChange as (open: boolean) => void)(false);
    expect(element(flow.render(), MemberConfiguration)).toBeDefined();
    expect(flow.close).not.toHaveBeenCalled();
    addConnection(flow.render());
    const saved = { ...connection, id: 'new-connection' };
    flow.connect(saved);
    (element(flow.render(), ConnectionEditor).props.connected as (value: Connection) => void)(
      saved,
    );
    const member = element(flow.render(), MemberConfiguration);
    expect((member.props.data as Snapshot).connections).toContainEqual(saved);
    expect(member.props.value).toMatchObject({ connectionId: '', model: '' });
    (element(flow.render(), Modal).props.onOpenChange as (open: boolean) => void)(false);
    expect(flow.close).toHaveBeenCalledOnce();
  });

  it('retains batch selection, successful results and request IDs after adding a connection', async () => {
    const flow = workflow([installation('first'), installation('second')]);
    updateMember(flow.render(), { connectionId: connection.id, model: 'model' });
    const second = elements(flow.render()).find(
      (item) => item.type === Button && item.props.children === 'second',
    )!;
    (second.props.onClick as () => void)();
    updateMember(flow.render(), {
      connectionId: connection.id,
      model: 'model',
      personalInstructions: 'My second member',
    });
    addConnection(flow.render());
    (element(flow.render(), ConnectionEditor).props.close as () => void)();
    expect(element(flow.render(), MemberConfiguration).key).toBe('second');
    let requests: { requestId: string; installationId: string }[] = [];
    flow.mutate.mockImplementationOnce(async (_method, params) => {
      requests = params.items;
      return requests.map((item) => ({
        requestId: item.requestId,
        ...(item.installationId === 'first' ? { botId: 'created-bot' } : { error: 'Try again' }),
      }));
    });
    await (element(flow.render(), 'form').props.onSubmit as (value: FormEvent) => Promise<void>)(
      event,
    );
    addConnection(flow.render());
    (element(flow.render(), ConnectionEditor).props.connected as (value: Connection) => void)(
      connection,
    );
    const member = element(flow.render(), MemberConfiguration);
    expect(member.key).toBe('second');
    expect(member.props.value).toMatchObject({ personalInstructions: 'My second member' });
    flow.mutate.mockResolvedValueOnce([
      { requestId: requests[1].requestId, botId: 'second-bot' },
    ] satisfies PresetMemberResult[]);
    await (element(flow.render(), 'form').props.onSubmit as (value: FormEvent) => Promise<void>)(
      event,
    );
    expect(flow.mutate.mock.calls[1][1].items).toHaveLength(1);
    expect(flow.mutate.mock.calls[1][1].items[0]).toMatchObject(requests[1]);
    expect(flow.close).toHaveBeenCalledOnce();
    expect(flow.created).toHaveBeenCalledTimes(2);
  });

  it('provides a return action while authorization is pending or has failed', () => {
    const close = vi.fn();
    const edit = vi.fn();
    const tree = ConnectionAuthorization({
      close,
      cancelLabel: '返回',
      canLogin: true,
      flow: {
        phase: 'authorization',
        busy: false,
        error: 'Sign-in failed',
        edit,
      } as unknown as Parameters<typeof ConnectionAuthorization>[0]['flow'],
    });
    const back = elements(tree).find(
      (item) => item.type === Button && item.props.children === '返回',
    )!;
    (back.props.onClick as () => void)();
    expect(close).toHaveBeenCalledOnce();
    expect(edit).not.toHaveBeenCalled();
  });
});
