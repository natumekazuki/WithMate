import type { AppLogInput } from "../../src-shared/window/app-log-types.js";
import type { StorageOperationDiagnostic } from "../storage/storage-operation-diagnostics.js";

const SUMMARY_INTERVAL_MS = 60_000;
const MAX_OPERATIONS = 16;
const SLOW_OPERATION_MS = 100;
const MAX_METADATA_LENGTH = 160;

/** 集計区間ごとの操作段階・成否の件数と、待ち時間・処理時間の最大値。 */
type OperationSummary = {
  queued: number;
  started: number;
  succeeded: number;
  failed: number;
  slow: number;
  maxWaitMs: number;
  maxHoldMs: number;
};

/** 操作別または操作名の収容上限を超えた分に使う、未集計のカウンターを作る。 */
function emptySummary(): OperationSummary {
  return {
    queued: 0,
    started: 0,
    succeeded: 0,
    failed: 0,
    slow: 0,
    maxWaitMs: 0,
    maxHoldMs: 0,
  };
}

/** ストレージ診断を有限の定期集計にまとめ、失敗イベントは集計を待たず記録する。 */
export class StorageOperationLogService {
  private readonly operations = new Map<string, OperationSummary>();
  private overflow = emptySummary();
  private eventCount = 0;
  private slowestWait: StorageOperationDiagnostic | undefined;
  private slowestHold: StorageOperationDiagnostic | undefined;
  private stopped = false;
  private readonly timer: ReturnType<typeof setInterval>;

  /** 定期出力を始める。タイマーだけでプロセスを存続させない。 */
  constructor(private readonly writeLog: (input: AppLogInput) => void) {
    this.timer = setInterval(() => this.flush(), SUMMARY_INTERVAL_MS);
    this.timer.unref?.();
  }

  /** 失敗は即時出力し、集計中は操作名ごとの件数と最長の待機・処理時間を更新する。 */
  record(event: StorageOperationDiagnostic): void {
    if (event.outcome === "failure") {
      this.write({
        level: "error",
        kind: "storage.operation",
        process: "main",
        message: `${event.operation}: ${event.stage} failed`,
        correlationId: event.correlationId,
        requestId: event.requestId,
        data: event,
      });
    }
    if (this.stopped) return;

    const operation = event.operation.slice(0, MAX_METADATA_LENGTH);
    let summary = this.operations.get(operation);
    if (!summary && this.operations.size < MAX_OPERATIONS) {
      summary = emptySummary();
      this.operations.set(operation, summary);
    }
    summary ??= this.overflow;
    this.eventCount += 1;
    if (event.stage === "queued") summary.queued += 1;
    if (event.stage === "started") summary.started += 1;
    if (event.stage === "completed") {
      if (event.outcome === "success") summary.succeeded += 1;
      if (event.outcome === "failure") summary.failed += 1;
      if (
        (event.waitMs ?? 0) >= SLOW_OPERATION_MS ||
        (event.holdMs ?? 0) >= SLOW_OPERATION_MS
      )
        summary.slow += 1;
    }
    if (event.waitMs !== undefined && event.waitMs > summary.maxWaitMs)
      summary.maxWaitMs = event.waitMs;
    if (event.holdMs !== undefined && event.holdMs > summary.maxHoldMs)
      summary.maxHoldMs = event.holdMs;
    if ((event.waitMs ?? 0) > (this.slowestWait?.waitMs ?? 0))
      this.slowestWait = sample(event);
    if ((event.holdMs ?? 0) > (this.slowestHold?.holdMs ?? 0))
      this.slowestHold = sample(event);
  }

  /** 空でない集計を区切って出力する。失敗または遅い操作があれば警告とする。 */
  flush(): void {
    if (this.eventCount === 0) return;
    const data = {
      eventCount: this.eventCount,
      operations: [...this.operations].map(([operation, summary]) => ({
        operation,
        ...summary,
      })),
      overflow: this.overflow,
      slowestWait: this.slowestWait,
      slowestHold: this.slowestHold,
    };
    this.operations.clear();
    this.overflow = emptySummary();
    this.eventCount = 0;
    this.slowestWait = undefined;
    this.slowestHold = undefined;
    this.write({
      level:
        data.operations.some((entry) => entry.failed > 0) ||
        data.overflow.failed > 0 ||
        (data.slowestWait?.waitMs ?? 0) >= SLOW_OPERATION_MS ||
        (data.slowestHold?.holdMs ?? 0) >= SLOW_OPERATION_MS
          ? "warn"
          : "info",
      kind: "storage.operation.summary",
      process: "main",
      message: "Storage operation diagnostic summary",
      data,
    });
  }

  /** タイマーと集計受付を停止し、残る集計を一度だけ出力する。 */
  dispose(): void {
    if (this.stopped) return;
    this.stopped = true;
    clearInterval(this.timer);
    this.flush();
  }

  /** 診断ログの書き込み失敗を、ストレージ操作の呼び出し元に伝播させない。 */
  private write(input: AppLogInput): void {
    try {
      this.writeLog(input);
    } catch (error) {
      console.warn("Storage diagnostic log write failed", error);
    }
  }
}

/** 最長時間のサンプルを集計に残すため、含める診断項目を選び、識別文字列を短縮する。 */
function sample(event: StorageOperationDiagnostic): StorageOperationDiagnostic {
  return {
    operation: event.operation.slice(0, MAX_METADATA_LENGTH),
    correlationId: event.correlationId.slice(0, MAX_METADATA_LENGTH),
    generationId: event.generationId?.slice(0, MAX_METADATA_LENGTH),
    requestId: event.requestId?.slice(0, MAX_METADATA_LENGTH),
    stage: event.stage,
    outcome: event.outcome,
    waitMs: event.waitMs,
    holdMs: event.holdMs,
  };
}
