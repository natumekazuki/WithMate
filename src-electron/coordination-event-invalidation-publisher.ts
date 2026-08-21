export type CoordinationEventInvalidationTarget = {
  isAvailable(): boolean;
  publish(): void;
};

export type CoordinationEventInvalidationPublisherDeps = {
  getTargets(): CoordinationEventInvalidationTarget[];
  scheduleRetry?(callback: () => void, delayMs: number): unknown;
  cancelRetry?(handle: unknown): void;
  retryDelayMs?: number;
};

export class CoordinationEventInvalidationPublisher {
  private retryHandle: unknown | null = null;
  private disposed = false;

  constructor(private readonly deps: CoordinationEventInvalidationPublisherDeps) {}

  publish(): void {
    if (this.disposed) return;
    const failure = this.publishAvailableTargets();
    if (failure) {
      this.ensureRetry();
      throw failure;
    }
    this.clearRetry();
  }

  dispose(): void {
    this.disposed = true;
    this.clearRetry();
  }

  private publishAvailableTargets(): unknown | null {
    let firstFailure: unknown | null = null;
    for (const target of this.deps.getTargets()) {
      if (!target.isAvailable()) continue;
      try {
        target.publish();
      } catch (error) {
        firstFailure ??= error;
      }
    }
    return firstFailure;
  }

  private ensureRetry(): void {
    if (this.retryHandle !== null || this.disposed) return;
    const schedule = this.deps.scheduleRetry ?? defaultScheduleRetry;
    this.retryHandle = schedule(() => {
      this.retryHandle = null;
      if (this.disposed) return;
      const failure = this.publishAvailableTargets();
      if (failure) this.ensureRetry();
    }, this.deps.retryDelayMs ?? 250);
  }

  private clearRetry(): void {
    if (this.retryHandle === null) return;
    (this.deps.cancelRetry ?? clearTimeout)(this.retryHandle);
    this.retryHandle = null;
  }
}

function defaultScheduleRetry(callback: () => void, delayMs: number): ReturnType<typeof setTimeout> {
  const handle = setTimeout(callback, delayMs);
  handle.unref?.();
  return handle;
}
