import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";

const storageOperationCorrelation = new AsyncLocalStorage<string>();

/** ストレージ要求の受付、実行開始、完了を区別する計測段階。 */
export type StorageOperationDiagnosticStage =
  "queued" | "started" | "completed";
/** 診断の対象操作が未完了か、成功または失敗で終わったかを示す区分。 */
export type StorageOperationDiagnosticOutcome =
  "pending" | "success" | "failure";

/** 操作名と相関 ID を軸に、要求の段階・結果・取得できた計測時間を伝えるイベント。 */
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

/** ストレージ操作の計測イベントを受け取る診断出力先。 */
export type StorageOperationDiagnosticSink = (
  event: StorageOperationDiagnostic,
) => void;

/** 経過時間計測に使うミリ秒単位の時刻の取得元。 */
export type StorageOperationDiagnosticClock = () => number;

/** イベントループ遅延の分位点・最大値・平均値をミリ秒で受け取る出力先。 */
export type StorageOperationEventLoopDelayLogger = (input: {
  p50Ms: number;
  p99Ms: number;
  maxMs: number;
  meanMs: number;
}) => void;

/** 操作とそこから派生する非同期処理の範囲で、同じ診断用相関 ID を利用できるようにする。 */
export function runWithStorageOperationCorrelation<T>(
  correlationId: string,
  operation: () => T,
): T {
  return storageOperationCorrelation.run(correlationId, operation);
}

/** 現在の非同期処理に設定された診断用相関 ID を返し、未設定なら undefined を返す。 */
export function getStorageOperationCorrelationId(): string | undefined {
  return storageOperationCorrelation.getStore();
}

/** 受付時刻を記録し、現在の相関 ID を継承する。相関 ID がなければ要求用に発行する。 */
export function createStorageOperationDiagnosticContext(
  clock: StorageOperationDiagnosticClock = () => performance.now(),
): {
  correlationId: string;
  queuedAt: number;
  startedAt?: number;
  clock: StorageOperationDiagnosticClock;
} {
  return {
    correlationId: getStorageOperationCorrelationId() ?? randomUUID(),
    queuedAt: clock(),
    clock,
  };
}

/** 診断イベントを出力する。出力先が未設定でも例外を投げても、操作の結果には影響させない。 */
export function emitStorageOperationDiagnostic(
  sink: StorageOperationDiagnosticSink | undefined,
  event: StorageOperationDiagnostic,
): void {
  try {
    sink?.(event);
  } catch {
    // 診断によって操作結果が変わってはならない。
  }
}

/** イベントループの遅延を集計・定期報告し、タイマーと計測を止める関数を返す。 */
export function startEventLoopDelayMonitoring(
  logger: StorageOperationEventLoopDelayLogger,
  options: { intervalMs?: number; resolutionMs?: number } = {},
): () => void {
  const histogram = monitorEventLoopDelay({
    resolution: options.resolutionMs ?? 20,
  });
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
    if (
      !Object.values(report).every(
        (value) => Number.isFinite(value) && value >= 0,
      )
    ) {
      return;
    }
    try {
      logger({
        ...report,
      });
    } catch {
      // 診断の報告が Main のイベントループを終了させてはならない。
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
