import type { FormEvent, ReactElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Bot, Connection, Conversation, Snapshot } from '../src/domain/types.js';
import type { Mutate } from '../apps/ui/src/store.js';
import { BotEditor } from '../apps/ui/src/BotEditor.js';
import { ChiefConversationEditor } from '../apps/ui/src/ChiefConversationEditor.js';
import { ReasoningField } from '../apps/ui/src/ReasoningField.js';

const hooks = vi.hoisted(() => ({ values: [] as unknown[], cursor: 0 }));
vi.mock('react', async (original) => ({
  ...(await original<typeof import('react')>()),
  useEffect: () => {},
  useState: <T>(initial: T | (() => T)) => {
    const index = hooks.cursor++;
    if (!(index in hooks.values)) {
      hooks.values[index] = typeof initial === 'function' ? (initial as () => T)() : initial;
    }
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

const connection: Connection = {
  id: 'connection',
  name: 'API',
  provider: 'custom',
  status: 'ready',
  concurrency: 1,
  revision: 1,
  createdAt: '',
  models: [{ id: 'model', name: 'Model', reasoning: ['high'] }],
};

function fixture(main = false) {
  const bot: Bot = {
    id: 'member',
    name: 'Old name',
    role: 'Reviewer',
    instructions: '',
    connectionId: connection.id,
    model: 'model',
    reasoning: 'max',
    color: '#047857',
    toolNames: [],
    skillIds: [],
    memoryMode: 'off',
    revision: 1,
    archived: false,
  };
  const data = {
    connections: [connection],
    bots: [bot],
    tasks: [],
    settings: { mainBotId: main ? bot.id : 'chief' },
  } as unknown as Snapshot;
  const mutate = vi.fn(async (..._args: unknown[]) => undefined as never);
  const close = vi.fn();
  const render = () => {
    hooks.cursor = 0;
    return BotEditor({ bot, data, mutate: mutate as Mutate, close });
  };
  return { close, data, mutate, render };
}

function chiefFixture() {
  const chief: Bot = {
    id: 'chief',
    name: 'Chief',
    role: '',
    instructions: '',
    connectionId: connection.id,
    model: 'model',
    color: '',
    toolNames: [],
    skillIds: [],
    memoryMode: 'off',
    revision: 1,
    archived: false,
  };
  const conversation: Conversation = {
    id: 'conversation',
    name: 'Old title',
    kind: 'private',
    memberIds: ['chief'],
    workspaceId: 'workspace',
    createdAt: '',
    purpose: 'chief',
    model: 'model',
    reasoning: 'max',
  };
  const data = {
    connections: [connection],
    bots: [chief],
    tasks: [],
    conversations: [conversation],
    workspaces: [],
    settings: { mainBotId: 'chief', mainConversationId: conversation.id },
  } as unknown as Snapshot;
  const mutate = vi.fn(async (..._args: unknown[]) => ({ id: conversation.id }));
  const close = vi.fn();
  const render = () => {
    hooks.cursor = 0;
    return ChiefConversationEditor({
      data,
      mutate: mutate as Mutate,
      close,
      configureChief: vi.fn(),
      conversation,
    });
  };
  return { close, mutate, render };
}

function submit(tree: unknown) {
  const onSubmit = element(tree, 'form').props.onSubmit as (event: FormEvent) => Promise<void>;
  return onSubmit({ preventDefault() {} } as FormEvent);
}

describe('reasoning value save behavior', () => {
  beforeEach(() => {
    hooks.values = [];
    hooks.cursor = 0;
  });

  it('does not save a renamed bot while its saved reasoning level is unsupported', async () => {
    const editor = fixture();
    const tree = editor.render();
    const name = elements(tree).find(
      (item) => item.type === 'input' && item.props.value === 'Old name',
    );
    expect(name).toBeDefined();
    (name!.props.onChange as (event: { target: { value: string } }) => void)({
      target: { value: 'New name' },
    });

    await submit(editor.render());

    expect(editor.mutate).not.toHaveBeenCalled();
    expect(element(editor.render(), ReasoningField).props.value).toBe('max');
  });

  it('saves the explicit default choice without the obsolete reasoning value', async () => {
    const editor = fixture();
    const tree = editor.render();
    const name = elements(tree).find(
      (item) => item.type === 'input' && item.props.value === 'Old name',
    );
    (name!.props.onChange as (event: { target: { value: string } }) => void)({
      target: { value: 'New name' },
    });
    const reasoning = element(tree, ReasoningField);
    (reasoning.props.onChange as (value: string) => void)('');

    await submit(editor.render());

    expect(editor.mutate).toHaveBeenCalledOnce();
    expect(editor.mutate.mock.calls[0][0]).toBe('bots.save');
    expect(editor.mutate.mock.calls[0][1]).toMatchObject({
      input: { name: 'New name', reasoning: undefined },
    });
    expect(editor.close).toHaveBeenCalledOnce();
  });

  it('blocks saving chief conversation settings while the saved level is unsupported', async () => {
    const editor = chiefFixture();

    await submit(editor.render());

    expect(editor.mutate).not.toHaveBeenCalled();
  });

  it('sends an explicit default for Chief that survives JSON transport', async () => {
    const editor = fixture(true);
    const reasoning = element(editor.render(), ReasoningField);
    (reasoning.props.onChange as (value: string) => void)('');
    await submit(editor.render());
    expect(editor.mutate).toHaveBeenCalledOnce();
    const [method, params] = JSON.parse(JSON.stringify(editor.mutate.mock.calls[0]));
    expect(method).toBe('chief.configure');
    expect(params.input.reasoning).toBe('');
    expect(editor.close).toHaveBeenCalledOnce();
  });
});
