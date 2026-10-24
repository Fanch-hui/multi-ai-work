import { inputReplyMessage, referencePrompt } from './conversation-references.js';
import type { Message, Run, Task, TaskInput } from '../domain/types.js';
import type { ModelMessage, RunUserInput } from '../domain/provider.js';
import type { ToolExecutionContext } from '../domain/tools.js';
import { State, now } from './state.js';
import { modelImage } from './run-images.js';
import { taskInputs } from './task-input-records.js';
import { acknowledgeRequirement, updateRequirement } from './task-requirements.js';

export class TaskInputService {
  constructor(private state: State) {}

  append(task: Task, message: Message) {
    const input: TaskInput = {
      id: `${task.id}:${message.id}`,
      kind: 'user-input',
      taskId: task.id,
      botId: task.botId,
      conversationId: task.conversationId,
      messageId: message.id,
      status: 'pending',
      createdAt: now(),
      requirementVersion: updateRequirement(this.state.storage, task, message),
    };
    this.state.storage.put('deliveries', input);
  }
  hasPending(taskId: string) {
    return taskInputs(this.state.storage, taskId).some(
      (input) => input.taskId === taskId && input.status === 'pending',
    );
  }

  forRun(
    run: Run,
    context: ToolExecutionContext,
    cutoff: number,
    beginReply: (output?: string) => void,
  ): RunUserInput {
    const s = this.state.storage;
    this.claim(run, (input) => (s.getMessage(input.messageId)?.sequence ?? Infinity) <= cutoff);
    return {
      take: () => {
        context.signal.throwIfAborted();
        const claimed = this.claim(run, () => true);
        const messages: ModelMessage[] = claimed.flatMap((input) => {
          const message = s.getMessage(input.messageId);
          if (!message) return [];
          const images = message.artifactIds.flatMap((artifactId) => {
            const image = modelImage(context.findArtifact(artifactId));
            return image ? [image] : [];
          });
          const quoted = inputReplyMessage(this.state, message);
          const body =
            message.authorType === 'bot'
              ? `管家要求：${message.content}`
              : referencePrompt(message, quoted);
          const content = message.artifactIds.length
            ? `${body}\n附件 ID：${message.artifactIds.join('、')}`
            : body;
          return [
            {
              role: 'user' as const,
              content,
              sourceMessageId: message.id,
              sourceSequence: message.sequence,
              ...(images.length ? { images } : {}),
            },
          ];
        });
        if (claimed.length) this.state.changed();
        return messages;
      },
      hasPending: () => this.hasPending(run.taskId),
      acknowledge: (messageIds) => {
        const ids = new Set(messageIds);
        const delivered = taskInputs(s, run.taskId).filter(
          (input) =>
            input.runId === run.id && input.status === 'claimed' && ids.has(input.messageId),
        );
        for (const input of delivered)
          s.put('deliveries', { ...input, status: 'delivered', deliveredAt: now() });
        acknowledgeRequirement(
          s,
          run,
          delivered.flatMap((input) =>
            input.requirementVersion === undefined ? [] : [input.requirementVersion],
          ),
        );
        if (delivered.length) this.state.changed();
      },
      subscribe: (listener) =>
        this.state.subscribe((kind) => {
          if (kind === 'state' && this.hasPending(run.taskId)) listener();
        }),
      beginReply,
    };
  }

  private claim(run: Run, matches: (input: TaskInput) => boolean) {
    const s = this.state.storage;
    return s.transaction(() =>
      taskInputs(s, run.taskId)
        .filter(
          (input) => input.taskId === run.taskId && input.status === 'pending' && matches(input),
        )
        .sort(
          (a, b) =>
            (s.getMessage(a.messageId)?.sequence ?? 0) - (s.getMessage(b.messageId)?.sequence ?? 0),
        )
        .map((input) =>
          s.put('deliveries', { ...input, status: 'claimed' as const, runId: run.id }),
        ),
    );
  }

  complete(runId: string, cutoff: number) {
    const s = this.state.storage,
      run = s.get<Run>('runs', runId);
    const received = taskInputs(s).filter(
      (input) =>
        (input.runId === runId && input.status !== 'pending') ||
        (input.taskId === run?.taskId && input.status === 'delivered'),
    );
    for (const input of received.filter((input) => input.status === 'claimed'))
      s.put('deliveries', { ...input, status: 'delivered', deliveredAt: now() });
    return Math.max(
      cutoff,
      ...received.map((input) => s.getMessage(input.messageId)?.sequence ?? 0),
    );
  }
  release(runId: string) {
    for (const input of taskInputs(this.state.storage).filter(
      (item) => item.runId === runId && item.status === 'claimed',
    ))
      this.state.storage.put('deliveries', { ...input, status: 'pending', runId: undefined });
  }
}
