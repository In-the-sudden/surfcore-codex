let pending = Promise.resolve();

export function runSongModelJob(work, { signal } = {}) {
  signal?.throwIfAborted();
  let cancel;
  const operation = pending.then(async () => {
    signal?.removeEventListener('abort', cancel);
    signal?.throwIfAborted();
    const result = await work();
    signal?.throwIfAborted();
    return result;
  });
  pending = operation.catch(() => {});
  if (!signal) return operation;
  const aborted = new Promise((_, reject) => {
    cancel = () => reject(signal.reason);
    signal.addEventListener('abort', cancel, { once: true });
    if (signal.aborted) cancel();
  });
  return Promise.race([operation, aborted]);
}
