export interface SessionLease { readonly key: string; release(): void }
interface Waiter { grant(): void; reject(reason: unknown): void; signal?: AbortSignal; abort(): void }
interface Queue { active?: SessionLease; waiting: Waiter[] }
const queues = new Map<string, Queue>();

export function assertSessionLease(lease: SessionLease, key: string): void {
  if (lease.key !== key || queues.get(key)?.active !== lease) throw new Error('Session operation lease is not active');
}

export function acquireSessionLease(key: string, signal?: AbortSignal): Promise<SessionLease> {
  signal?.throwIfAborted();
  const queue = queues.get(key) ?? { waiting: [] };
  queues.set(key, queue);
  return new Promise((resolve, reject) => {
    const waiter: Waiter = {
      signal, reject,
      abort() {
        const index = queue.waiting.indexOf(waiter);
        if (index >= 0) queue.waiting.splice(index, 1);
        signal?.removeEventListener('abort', waiter.abort);
        reject(signal?.reason ?? new Error('Session wait aborted'));
      },
      grant() {
        signal?.removeEventListener('abort', waiter.abort);
        const lease: SessionLease = { key, release() {
          if (queue.active !== lease) return;
          queue.active = undefined;
          const next = queue.waiting.shift();
          if (next) next.grant();
          else queues.delete(key);
        } };
        queue.active = lease;
        resolve(lease);
      },
    };
    if (!queue.active) waiter.grant();
    else {
      queue.waiting.push(waiter);
      signal?.addEventListener('abort', waiter.abort, { once: true });
      if (signal?.aborted) waiter.abort();
    }
  });
}
