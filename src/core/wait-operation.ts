export async function waitOperation<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const cleanup = () => signal.removeEventListener('abort', cancel);
    const cancel = () => { cleanup(); reject(signal.reason ?? new Error('操作已取消')); };
    signal.addEventListener('abort', cancel, { once: true });
    void operation.then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
  });
}
