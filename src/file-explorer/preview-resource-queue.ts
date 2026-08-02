export type PreviewResourceTask = (
  isCurrent: () => boolean,
) => Promise<string | null>;

type PreviewResourceQueueEntry = {
  generation: number;
  task: PreviewResourceTask;
  resolve: (value: string | null) => void;
  reject: (reason: unknown) => void;
};

export class PreviewResourceQueue {
  private readonly concurrency: number;

  private activeCount = 0;

  private generation = 0;

  private readonly pending: PreviewResourceQueueEntry[] = [];

  constructor(concurrency: number) {
    if (!Number.isInteger(concurrency) || concurrency < 1) {
      throw new Error("Preview resource concurrency must be a positive integer.");
    }
    this.concurrency = concurrency;
  }

  run(task: PreviewResourceTask): Promise<string | null> {
    return new Promise((resolve, reject) => {
      this.pending.push({
        generation: this.generation,
        task,
        resolve,
        reject,
      });
      this.drain();
    });
  }

  invalidate(): void {
    this.generation += 1;
    const staleEntries = this.pending.splice(0);
    for (const entry of staleEntries) {
      entry.resolve(null);
    }
  }

  private drain(): void {
    while (this.activeCount < this.concurrency && this.pending.length > 0) {
      const entry = this.pending.shift();
      if (!entry) {
        return;
      }
      if (entry.generation !== this.generation) {
        entry.resolve(null);
        continue;
      }

      this.activeCount += 1;
      const isCurrent = () => entry.generation === this.generation;
      void Promise.resolve()
        .then(() => entry.task(isCurrent))
        .then(entry.resolve, entry.reject)
        .finally(() => {
          this.activeCount -= 1;
          this.drain();
        });
    }
  }
}
