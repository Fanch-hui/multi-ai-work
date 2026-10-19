import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { Artifact, Run, Task } from '../src/domain/types.js';
import {
  activityStalled,
  currentActivityLabel,
  recoveryWaitLabel,
  stoppingTask,
} from '../apps/ui/src/task-activity.js';
import { TaskActivityDetails } from '../apps/ui/src/TaskActivityDetails.js';
import { taskRecordStatus } from '../apps/ui/src/conversation-records.js';
import { activeTask } from '../apps/ui/src/components.js';
import { ArtifactRequirement, RequirementDetails } from '../apps/ui/src/RequirementDetails.js';
import { agentActivity } from '../apps/ui/src/AgentActivity.js';
import type { ModelActivityKind } from '../src/domain/task-activity.js';

const time = '2026-10-14T12:46:00Z';
const task: Task = {
  id: 'task',
  botId: 'member',
  conversationId: 'room',
  dependencyIds: [],
  goal: '制作材料',
  expectedOutput: '',
  status: 'running',
  runIds: ['run'],
  artifactIds: [],
  requestId: 'task',
  depth: 0,
  createdAt: time,
  updatedAt: '2026-10-14T13:00:00Z',
};
const run: Run = {
  id: 'run',
  taskId: task.id,
  botId: task.botId,
  bindingId: 'binding',
  configRevision: 1,
  status: 'running',
  createdAt: time,
  cancelRequestedAt: '2026-10-14T13:01:00Z',
};

describe('task activity diagnostics', () => {
  it('聊天状态区分实际模型活动并保留业务等待和终态优先级', () => {
    const labels: Record<ModelActivityKind, string> = {
      waiting: '正在等待响应',
      thinking: '正在认真思考',
      responding: '正在组织回复',
      tool: '正在努力工作',
      working: '正在努力工作',
      finishing: '正在收尾',
    };
    for (const [kind, label] of Object.entries(labels)) {
      const current: Task = {
        ...task,
        activity: { phase: 'model', modelActivity: kind as ModelActivityKind },
      };
      expect(agentActivity(current)).toBe(label);
      expect(agentActivity({ ...current, status: 'completed' })).toBe('已完成');
    }
    expect(
      agentActivity({ ...task, status: 'waiting_approval', activity: { phase: 'approval' } }),
    ).toBe('等待批准');
    expect(agentActivity({ ...task, activity: { phase: 'tool', toolName: 'read_file' } })).toBe(
      '正在努力工作',
    );
  });

  it('uses actual activity timestamps and excludes declared waits from a stalled-model hint', () => {
    const now = Date.parse('2026-10-14T13:00:30Z');
    expect(activityStalled(task, now)).toBe(false);
    const thinking = { ...task, activity: { phase: 'model' as const, lastActivityAt: time } };
    expect(activityStalled(thinking, now)).toBe(true);
    expect(
      activityStalled(
        { ...thinking, activity: { phase: 'model', lastActivityAt: '2026-10-14T13:00:00Z' } },
        now,
      ),
    ).toBe(false);
    expect(
      activityStalled(
        {
          ...thinking,
          status: 'waiting_children',
          activity: { phase: 'children', lastActivityAt: time },
        },
        now,
      ),
    ).toBe(false);
  });

  it('shows recovery attempts and retry time without reporting a stalled model', () => {
    const recovery = { attempt: 3, maxAttempts: 5, nextAttemptAt: '2026-10-14T13:00:05Z' };
    const recovering: Task = {
      ...task,
      status: 'recovering',
      recovery,
      activity: { phase: 'recovering', recovery, lastActivityAt: time },
    };
    const now = Date.parse('2026-10-14T13:00:00Z');
    expect(activeTask(recovering.status)).toBe(true);
    expect(currentActivityLabel(recovering)).toBe('正在恢复连接，第 3/5 次');
    expect(currentActivityLabel({ ...recovering, activity: undefined })).toBe(
      '正在恢复连接，第 3/5 次',
    );
    expect(activityStalled({ ...recovering, status: 'running' }, now)).toBe(false);
    expect(recoveryWaitLabel(recovering, now)).toBe('5 秒后重试');
    expect(recoveryWaitLabel(recovering, now + 6_000)).toBe('即将重试');
    expect(taskRecordStatus(recovering, [])).toContain('正在恢复连接，第 3/5 次 · 下次尝试');
    const html = renderToStaticMarkup(
      createElement(TaskActivityDetails, {
        task: recovering,
        mutate: async () => undefined as never,
      }),
    );
    expect(html).toContain('正在恢复连接，第 3/5 次');
    expect(html).toContain('下次尝试');
    expect(html).toContain('2026-10-14T13:00:05Z');
    expect(html).not.toContain('较长时间未收到活动');
    expect(currentActivityLabel({ ...recovering, status: 'failed' })).toBe('失败');
    expect(taskRecordStatus({ ...recovering, status: 'failed' }, [])).toBe('失败');
    expect(recoveryWaitLabel({ ...recovering, status: 'failed' }, now)).toBeUndefined();
  });

  it('distinguishes a cancellation request from the actual stopped state', () => {
    expect(stoppingTask(task, run)).toBe(true);
    expect(currentActivityLabel(task, run)).toBe('停止处理中');
    const stopped = { ...task, status: 'cancelled' as const };
    expect(stoppingTask(stopped, run)).toBe(false);
    expect(currentActivityLabel(stopped, run)).toBe('已停止');
  });
});

describe('requirement version presentation', () => {
  it('shows the source requirement, changes and the version attached to a historical artifact', () => {
    const changed = {
      ...task,
      requirement: {
        taskId: task.id,
        version: 2,
        updates: [
          {
            version: 2,
            messageId: 'update',
            conversationId: task.conversationId,
            content: '预算改为260元',
            artifactIds: ['brief'],
            createdAt: time,
          },
        ],
      },
    };
    const html = renderToStaticMarkup(createElement(RequirementDetails, { task: changed }));
    expect(html).toContain('v2');
    expect(html).toContain('制作材料');
    expect(html).toContain('预算改为260元');
    const artifact: Artifact = {
      id: 'old',
      name: '材料.xlsx',
      path: '/materials.xlsx',
      mimeType: 'application/octet-stream',
      sha256: '',
      size: 0,
      conversationId: 'room',
      createdAt: time,
      requirementVersion: 1,
      superseded: true,
    };
    const artifactHtml = renderToStaticMarkup(createElement(ArtifactRequirement, { artifact }));
    expect(artifactHtml).toContain('需求 v1');
    expect(artifactHtml).toContain('已替代');
  });
});
