import { describe, expect, it } from 'vitest';
import type { ChiefContextView, ChiefInput } from '../src/domain/chief-work.js';
import type { Task } from '../src/domain/types.js';
import { eventually, setup } from './core-harness.js';

const handoff = ['目标', '约束', '进度', '决定', '待办', '成果', '历史位置']
  .map((name) => `## ${name}\n无`)
  .join('\n');

describe('上下文维护与待发送输入', () => {
  it.each([false, true])(
    '维护结束后自动唤醒等待的输入，来源发生变化：%s',
    async (sourceChanged) => {
      let release = () => {};
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      let maintenanceStarted = false;
      let workCalls = 0;
      const { core, connection } = await setup(async (context) => {
        if (context.binding.purpose === 'chief-context-maintenance') {
          maintenanceStarted = true;
          await held;
          return { text: JSON.stringify({ action: 'switch', handoff }) };
        }
        workCalls++;
        if (workCalls === 1)
          context.emit({
            type: 'context',
            data: { estimatedTokens: 9000, triggerTokens: 8500, source: 'app-estimated' },
          });
        return { text: `已完成第 ${workCalls} 次工作` };
      });
      try {
        await core.request('chief.configure', {
          input: {
            connectionId: connection.id,
            model: 'test',
            memoryMode: 'off',
            contextWindow: 10000,
          },
        });
        const work = (await core.request('chief.contexts.create', {
          title: '报告修改',
        })) as ChiefContextView;
        const first = (await core.request('chief.inputs.send', {
          content: '完成报告',
          targetContextId: work.id,
        })) as { messageId: string; taskIds: string[] };
        await eventually(() => maintenanceStarted);
        const waiting = (await core.request('chief.inputs.send', {
          content: '再修改报告标题',
          targetContextId: work.id,
        })) as { inputId: string; messageId: string; taskIds: string[] };
        expect(waiting.taskIds).toEqual([]);
        expect(core.state.storage.getMessage(waiting.messageId)).toBeUndefined();
        expect(core.state.storage.get<ChiefInput>('chief_inputs', waiting.inputId)?.status).toBe(
          'pending',
        );
        if (sourceChanged) {
          const message = core.state.storage.getMessage(first.messageId)!;
          core.state.storage.updateMessage({ ...message, content: '完成报告并保留日期' });
        }
        release();
        await eventually(
          () =>
            core.state.storage.get<ChiefInput>('chief_inputs', waiting.inputId)?.status ===
            'dispatched',
        );
        const dispatched = core.state.storage.get<ChiefInput>('chief_inputs', waiting.inputId)!;
        await eventually(
          () =>
            core.state.storage.get<Task>('tasks', dispatched.taskIds[0])?.status === 'completed',
        );
        expect(workCalls).toBe(2);
        expect(core.state.storage.getMessage(waiting.messageId)?.content).toBe('再修改报告标题');
        expect(core.chief.contexts.current(work.id).part.id).toBe(work.currentPartId);
      } finally {
        release();
      }
    },
  );
});
