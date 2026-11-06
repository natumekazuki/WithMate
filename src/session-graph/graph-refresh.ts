// A view has at most one refresh in flight and one coalesced continuation.
// Scheduling at the microtask boundary batches notifications without delaying live updates.
export function createGraphRefreshQueue(run: (more: boolean, moreTopics: boolean) => Promise<void>) {
  let active = false;
  let paused = false;
  let disposed = false;
  let scheduled = false;
  let pending: { more: boolean; moreTopics: boolean; refresh: boolean; promise: Promise<void>; done: () => void } | null = null;
  const flush = () => {
    if (active || paused || disposed || !pending || scheduled) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      if (active || paused || disposed || !pending) return;
      const next = pending;
      pending = null;
      active = true;
      const execute = async () => {
        if (next.moreTopics) await run(false, true);
        if (disposed || paused) return;
        if (next.more) await run(true, false);
        if (disposed || paused) return;
        if (next.refresh) await run(false, false);
      };
      void execute().finally(() => {
        active = false;
        next.done();
        flush();
      });
    });
  };
  return {
    request(more = false, moreTopics = false): Promise<void> {
      if (disposed) return Promise.resolve();
      if (!pending) {
        let done!: () => void;
        const promise = new Promise<void>((resolve) => { done = resolve; });
        pending = { more: false, moreTopics: false, refresh: false, promise, done };
      }
      pending.more ||= more;
      pending.moreTopics ||= moreTopics;
      pending.refresh ||= !more && !moreTopics;
      const result = pending.promise;
      flush();
      return result;
    },
    pause(value: boolean) { paused = value; flush(); },
    dispose() { disposed = true; pending?.done(); pending = null; },
  };
}
