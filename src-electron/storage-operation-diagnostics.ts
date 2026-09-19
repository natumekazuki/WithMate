import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";

const storageOperationCorrelation = new AsyncLocalStorage<string>();

export type StorageOperationDiagnosticStage = "queued" | "started" | "completed";
export type StorageOperationDiagnosticOutcome = "pending" | "success" | "failure";

export type StorageOperationDiagnostic = {
  operation: string;
  correlationId: string;
  generationId?: string;
  stage: StorageOperationDiagnosticStage;
  outcome: StorageOperationDiagnosticOutcome;
  waitMs?: number;
  holdMs?: number;
  requestId?: string;
};

export type StorageOperationDiagnosticSink = (event: StorageOperationDiagnostic) => void;

export type StorageOperationDiagnosticClock = () => number;

export type StorageOperationEventLoopDelayLogger = (input: {
  p50Ms: number;
  p99Ms: number;
  maxMs: number;
  meanMs: number;
}) => void;

export function runWithStorageOperationCorrelation<T>(correlationId: string, operation: () => T): T {
  return storageOperationCorrelation.run(correlationId, operation);
}

export function getStorageOperationCorrelationId(): string | undefined {
  return storageOperationCorrelation.getStore();
}

export function createStorageOperationDiagnosticContext(
  clock: StorageOperationDiagnosticClock = () => performance.now(),
): {
  correlationId: string;
  queuedAt: number;
  startedAt?: number;
  clock: StorageOperationDiagnosticClock;
} {
  return { correlationId: getStorageOperationCorrelationId() ?? randomUUID(), queuedAt: clock(), clock };
}

export function emitStorageOperationDiagnostic(
  sink: StorageOperationDiagnosticSink | undefined,
  event: StorageOperationDiagnostic,
): void {
  try {
    sink?.(event);
  } catch {
    // Diagnostics must never change the operation result.
  }
}

export function startEventLoopDelayMonitoring(
  logger: StorageOperationEventLoopDelayLogger,
  options: { intervalMs?: number; resolutionMs?: number } = {},
): () => void {
  const histogram = monitorEventLoopDelay({ resolution: options.resolutionMs ?? 20 });
  histogram.enable();
  const timer = setInterval(() => {
    if (histogram.count === 0) {
      return;
    }
    const report = {
      p50Ms: histogram.percentile(50) / 1e6,
      p99Ms: histogram.percentile(99) / 1e6,
      maxMs: histogram.max / 1e6,
      meanMs: histogram.mean / 1e6,
    };
    if (!Object.values(report).every((value) => Number.isFinite(value) && value >= 0)) {
      return;
    }
    try {
      logger({
        ...report,
      });
    } catch {
      // Diagnostic reporting must never terminate the Main event loop.
    } finally {
      histogram.reset();
    }
  }, options.intervalMs ?? 60_000);
  timer.unref?.();
  return () => {
    clearInterval(timer);
    histogram.disable();
  };
}
