import type { ToolExecutionContext } from '../domain/tools.js';

type Waiter = { start(): void; signal: AbortSignal; abort(): void };
type Queue = { active: number; waiting: Waiter[] };

export class NetworkConcurrency {
  private readonly queues = new Map<string, Queue>();

  constructor(private readonly limit = 2) {}

  async run<T>(key: string, context: Pick<ToolExecutionContext, 'signal' | 'assertAuthorized'>, action: () => Promise<T>): Promise<T> {
    const queue = await this.acquire(key, context.signal);
    try {
      context.signal.throwIfAborted();
      context.assertAuthorized?.();
      return await action();
    } finally {
      this.release(key, queue);
    }
  }

  private acquire(key: string, signal: AbortSignal): Promise<Queue> {
    signal.throwIfAborted();
    const queue = this.queues.get(key) ?? { active: 0, waiting: [] };
    this.queues.set(key, queue);
    if (queue.active < this.limit) {
      queue.active++;
      return Promise.resolve(queue);
    }
    return new Promise((resolve, reject) => {
      const waiter: Waiter = {
        signal,
        start: () => { queue.active++; resolve(queue); },
        abort: () => {
          queue.waiting.splice(queue.waiting.indexOf(waiter), 1);
          reject(signal.reason);
        },
      };
      queue.waiting.push(waiter);
      signal.addEventListener('abort', waiter.abort, { once: true });
    });
  }

  private release(key: string, queue: Queue): void {
    queue.active--;
    const waiter = queue.waiting.shift();
    if (waiter) {
      waiter.signal.removeEventListener('abort', waiter.abort);
      waiter.start();
    } else if (queue.active === 0) {
      this.queues.delete(key);
    }
  }
}
