import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { Task } from '../src/domain/types.js';
import { TaskDetail } from '../apps/ui/src/TaskDetail.js';
import { setup } from './core-harness.js';

describe('继续任务的成员阻碍提示', () => {
  it.each(['failed', 'waiting_input'] as const)(
    '%s 任务提前显示阻碍，状态解除后允许继续',
    async (status) => {
      const { core, bot } = await setup(async () => ({ text: '完成' }));
      core.scheduler.pause();
      const chief = bot('Chief');
      const member = bot('资料助手');
      const room = core.entities.createConversation({
        name: '协作',
        kind: 'group',
        chiefId: chief.id,
        memberIds: [chief.id, member.id],
        workspaceId: core.state.snapshot().workspaces[0].id,
      });
      const parent = core.tasks.create({
        conversationId: room.id,
        botId: chief.id,
        goal: '汇总资料',
      });
      const child = core.tasks.create({
        conversationId: room.id,
        botId: member.id,
        parentId: parent.id,
        goal: '检索资料',
      });
      core.tasks.update(parent, { status, coordinationPaused: status === 'waiting_input' });
      // Unrelated active tasks must not prevent this parent's continuation.
      core.tasks.create({ conversationId: room.id, botId: member.id, goal: '另一个工作' });
      const render = () => {
        const data = core.state.snapshot();
        return renderToStaticMarkup(
          createElement(TaskDetail, {
            task: data.tasks.find((task) => task.id === parent.id)!,
            data,
            mutate: async () => undefined as never,
            onSelect: () => undefined,
          }),
        );
      };
      const button = (html: string) =>
        html.match(/<button\b[^>]*>(?:(?!<\/button>)[\s\S])*?继续(?:原任务|处理)<\/button>/)?.[0];
      core.tasks.update(child, { status: 'running' });
      const running = render();
      expect(running).toContain('请等待以下成员任务结束，再继续。');
      expect(running).toContain('资料助手：检索资料');
      expect(button(running)).toContain('disabled=""');
      const before = core.state.storage.get<Task>('tasks', parent.id);
      expect(() => core.tasks.retry(parent.id)).toThrow('成员任务停止');
      expect(core.state.storage.get<Task>('tasks', parent.id)).toEqual(before);

      core.tasks.update(child, { status: 'interrupted', reconciliationRequired: true });
      const unresolved = render();
      expect(unresolved).toContain('请先核查以下成员任务的外部操作结果，再继续。');
      expect(button(unresolved)).toContain('disabled=""');
      expect(() => core.tasks.retry(parent.id)).toThrow('请先核查');
      expect(core.state.storage.get<Task>('tasks', parent.id)).toEqual(before);

      core.tasks.update(child, { reconciliationRequired: false });
      const ready = render();
      expect(ready).not.toContain('以下成员任务');
      expect(button(ready)).toBeDefined();
      expect(button(ready)).not.toContain('disabled=""');
      expect(core.tasks.retry(parent.id)).toMatchObject({
        id: parent.id,
        status: 'queued',
        coordinationPaused: false,
      });
      expect(render()).not.toContain('以下成员任务');
    },
  );
});
