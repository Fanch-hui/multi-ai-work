import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConnectorDraftView } from '../src/domain/connector-drafts.js';
import { draftFieldValue, withDraftField } from '../src/domain/connector-drafts.js';
import type { Snapshot } from '../src/domain/types.js';
import { ConnectorDraftsPanel } from '../apps/ui/src/connectors/ConnectorDraftsPanel.js';
import { ConnectorsPanel } from '../apps/ui/src/connectors/ConnectorsPanel.js';

const resources = vi.hoisted(() => ({
  drafts: [] as unknown[],
  connections: [] as unknown[],
  calls: [] as unknown[],
}));
vi.mock('../apps/ui/src/local-work/useResource.js', () => ({
  useResource: (method: string, params: unknown) => {
    resources.calls.push([method, params]);
    return {
      value: method === 'connectors.list' ? resources.connections : resources.drafts,
      error: '',
      loading: false,
      reload: () => {},
    };
  },
}));
const mutate = async () => undefined as never;
const draft: ConnectorDraftView = {
  id: 'draft',
  requestId: 'request',
  conversationId: 'room',
  sourceTaskId: 'source',
  botId: 'member',
  connectionId: 'mail',
  connectionConfiguration: '',
  toolName: 'send_message',
  title: '发给项目组',
  arguments: { to: ['项目组'], content: '请核对这份报告。' },
  fields: [
    { path: ['to'], label: '收件人', kind: 'recipient' },
    { path: ['content'], label: '正文', kind: 'body' },
  ],
  revision: 2,
  status: 'draft',
  createdAt: '2026-10-23T10:00:00Z',
  updatedAt: '2026-10-23T10:00:00Z',
  connectionName: '工作消息',
  botName: '助理',
};
beforeEach(() => {
  resources.drafts = [];
  resources.connections = [];
  resources.calls = [];
});
describe('连接器与草稿界面', () => {
  it('缺少独立发送权限时展示成员配置提示并禁用确认', () => {
    resources.drafts = [{ ...draft, sendBlockedReason: '请到我的团队启用发送权限' }];
    const markup = renderToStaticMarkup(
      createElement(ConnectorDraftsPanel, { compact: true, mutate }),
    );
    expect(markup).toContain('请到我的团队启用发送权限');
    expect(markup).toMatch(/<button[^>]*disabled[^>]*>[\s\S]*?确认发送/);
  });
  it('当前聊天请求独立会话草稿，展示实际发送字段与确认操作', () => {
    resources.drafts = [draft];
    const markup = renderToStaticMarkup(
      createElement(ConnectorDraftsPanel, { conversationId: 'room', compact: true, mutate }),
    );
    expect(resources.calls).toContainEqual(['connectorDrafts.list', { conversationId: 'room' }]);
    for (const text of [
      '收件人',
      '项目组',
      '正文',
      '请核对这份报告',
      '确认发送',
      'send_message',
      '版本 2',
    ])
      expect(markup).toContain(text);
  });
  it('管家汇集关联工作的待审阅草稿并保持其他私聊隔离', () => {
    resources.drafts = [
      { ...draft, id: 'main', conversationId: 'main-part', title: '主对话草稿' },
      { ...draft, id: 'worker', conversationId: 'work-part', title: '后台工作草稿' },
      { ...draft, id: 'foreign', conversationId: 'foreign', title: '其他私聊草稿' },
    ];
    const markup = renderToStaticMarkup(
      createElement(ConnectorDraftsPanel, {
        conversationIds: ['main-part', 'work-part'],
        compact: true,
        mutate,
      }),
    );
    expect(resources.calls).toContainEqual(['connectorDrafts.list', {}]);
    expect(markup).toContain('主对话草稿');
    expect(markup).toContain('后台工作草稿');
    expect(markup).not.toContain('其他私聊草稿');
    expect(markup.match(/aria-label="外发草稿"/g)).toHaveLength(1);
  });

  it('发送完成后退出聊天待办，未知结果保留核查入口', () => {
    resources.drafts = [{ ...draft, status: 'sent' }];
    expect(
      renderToStaticMarkup(createElement(ConnectorDraftsPanel, { compact: true, mutate })),
    ).toBe('');
    resources.drafts = [{ ...draft, status: 'unknown', error: '连接中断' }];
    const markup = renderToStaticMarkup(
      createElement(ConnectorDraftsPanel, { compact: true, mutate }),
    );
    expect(markup).toContain('我已核查外部结果');
    expect(markup).not.toContain('确认发送</button>');
    expect(markup).not.toContain('保存修改</button>');
  });
  it('连接器展示实际发现工具、授权成员与浏览器授权状态', () => {
    resources.connections = [
      {
        id: 'mail',
        name: '工作消息',
        kind: 'mcp',
        transport: 'http',
        url: 'https://work.test/mcp',
        enabled: true,
        status: 'ready',
        toolNames: ['send_message'],
        authenticated: false,
        authorizedBots: [{ id: 'member', name: '助理' }],
        authentication: { enabled: true, phase: 'connected' },
      },
    ];
    const data = { bots: [], toolConnections: [] } as unknown as Snapshot;
    const markup = renderToStaticMarkup(createElement(ConnectorsPanel, { data, mutate }));
    for (const text of [
      '应用连接器',
      '工作消息',
      '已通过浏览器授权',
      'send_message',
      '已授权：助理',
      '授权成员',
      '检测',
    ])
      expect(markup).toContain(text);
  });
  it('修改正文仅更新参数副本，保留收件人与嵌套结构', () => {
    const original = { message: { to: ['项目组'], body: '初稿' } };
    const edited = withDraftField(original, ['message', 'body'], '修改后的正文');
    expect(draftFieldValue(edited, ['message', 'body'])).toBe('修改后的正文');
    expect(original.message.body).toBe('初稿');
    expect(edited).toEqual({ message: { to: ['项目组'], body: '修改后的正文' } });
    expect(() => withDraftField(original, ['missing', 'body'], '内容')).toThrow('路径不存在');
  });
});
