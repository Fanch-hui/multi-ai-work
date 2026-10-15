/** Keeps SDK stdin open until the host sees an authoritative result. */
export class NativeInput<T> implements AsyncIterable<T> {
  private values: T[] = [];
  private waiter?: (value: IteratorResult<T>) => void;
  private ended = false;
  send(value: T): void {
    if (this.ended) throw new Error('原生输入流已关闭');
    if (this.waiter) { const waiter = this.waiter; this.waiter = undefined; waiter({ value, done: false }); }
    else this.values.push(value);
  }
  close(): void { this.ended = true; this.values = []; this.waiter?.({ value: undefined, done: true }); this.waiter = undefined; }
  [Symbol.asyncIterator](): AsyncIterator<T> {
    return { next: async () => {
      if (this.values.length) return { value: this.values.shift()!, done: false };
      if (this.ended) return { value: undefined, done: true };
      return new Promise<IteratorResult<T>>(resolve => { this.waiter = resolve; });
    } };
  }
}
