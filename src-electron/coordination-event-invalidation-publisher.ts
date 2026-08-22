import type { CoordinationEventInvalidation } from "../src/coordination-event.js";

export type CoordinationEventInvalidationTarget = {
  isAvailable(): boolean;
  publish(invalidation: CoordinationEventInvalidation): void;
};

export type CoordinationEventInvalidationPublisherDeps = {
  getTargets(): CoordinationEventInvalidationTarget[];
  scheduleRetry?(callback: () => void, delayMs: number): unknown;
  cancelRetry?(handle: unknown): void;
  retryDelayMs?: number;
};

export class CoordinationEventInvalidationPublisher {
  private retryHandle: unknown | null = null;
  private retryInvalidation: CoordinationEventInvalidation | null = null;
  private disposed = false;

  constructor(private readonly deps: CoordinationEventInvalidationPublisherDeps) {}

  publish(invalidation: CoordinationEventInvalidation): void {
    if (this.disposed) return;
    const nextInvalidation = mergeInvalidations(this.retryInvalidation, invalidation);
    const failure = this.publishAvailableTargets(nextInvalidation);
    if (failure) {
      this.retryInvalidation = nextInvalidation;
      this.ensureRetry();
      throw failure;
    }
    this.clearRetry();
  }

  dispose(): void {
    this.disposed = true;
    this.clearRetry();
  }

  private publishAvailableTargets(invalidation: CoordinationEventInvalidation): unknown | null {
    let firstFailure: unknown | null = null;
    for (const target of this.deps.getTargets()) {
      if (!target.isAvailable()) continue;
      try {
        target.publish(invalidation);
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
      const invalidation = this.retryInvalidation;
      if (!invalidation) return;
      const failure = this.publishAvailableTargets(invalidation);
      if (failure) this.ensureRetry();
      else this.retryInvalidation = null;
    }, this.deps.retryDelayMs ?? 250);
  }

  private clearRetry(): void {
    this.retryInvalidation = null;
    if (this.retryHandle === null) return;
    (this.deps.cancelRetry ?? clearTimeout)(this.retryHandle);
    this.retryHandle = null;
  }
}

function mergeInvalidations(
  current: CoordinationEventInvalidation | null,
  next: CoordinationEventInvalidation,
): CoordinationEventInvalidation {
  if (!current) return next;
  if (current.eventId === next.eventId && current.eventId !== null) {
    return {
      eventId: current.eventId,
      revision: Math.max(current.revision ?? 0, next.revision ?? 0),
    };
  }
  return { eventId: null, revision: null };
}

function defaultScheduleRetry(callback: () => void, delayMs: number): ReturnType<typeof setTimeout> {
  const handle = setTimeout(callback, delayMs);
  handle.unref?.();
  return handle;
}
