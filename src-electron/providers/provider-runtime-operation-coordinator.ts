/** 排他区間内で実行する処理。結果を同期値または Promise で返せる。 */
export type ProviderRuntimeOperation<T> = () => T | Promise<T>;
import {
  createStorageOperationDiagnosticContext,
  emitStorageOperationDiagnostic,
  runWithStorageOperationCorrelation,
  type StorageOperationDiagnosticSink,
} from "../storage/storage-operation-diagnostics.js";

/** 呼び出し側が処理を排他区間に送り、その戻り値を非同期に受け取るための契約。 */
export type RunProviderRuntimeOperationExclusive = <T>(
  operation: ProviderRuntimeOperation<T>,
) => Promise<T>;

/** 同じ調整役へ届く処理を受付順に直列化し、待機時間と実行時間を識別できるようにする。 */
export class ProviderRuntimeOperationCoordinator {
  private tail: Promise<void> = Promise.resolve();

  /** 診断の通知先と、関連付けに使うストア世代を設定する。診断なしでも排他処理を使える。 */
  constructor(
    private readonly diagnosticSink?: StorageOperationDiagnosticSink,
    private readonly generationId?: string,
  ) {}

  /** 先行処理の後に相関 ID 付きで実行し、例外をそのまま伝えつつ後続処理の待機を解除する。 */
  async runExclusive<T>(
    operation: ProviderRuntimeOperation<T>,
    operationName = "provider-runtime-exclusive",
  ): Promise<T> {
    const context = createStorageOperationDiagnosticContext();
    emitStorageOperationDiagnostic(this.diagnosticSink, {
      operation: operationName,
      correlationId: context.correlationId,
      ...(this.generationId ? { generationId: this.generationId } : {}),
      stage: "queued",
      outcome: "pending",
    });
    const previous = this.tail;
    /** この処理の終了を知らせ、待機中の後続処理を進める。 */
    let release: () => void = () => undefined;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });

    await previous;
    context.startedAt = context.clock();
    emitStorageOperationDiagnostic(this.diagnosticSink, {
      operation: operationName,
      correlationId: context.correlationId,
      ...(this.generationId ? { generationId: this.generationId } : {}),
      stage: "started",
      outcome: "pending",
      waitMs: Math.max(0, context.startedAt - context.queuedAt),
    });
    try {
      const result = await runWithStorageOperationCorrelation(
        context.correlationId,
        () => operation(),
      );
      emitStorageOperationDiagnostic(this.diagnosticSink, {
        operation: operationName,
        correlationId: context.correlationId,
        ...(this.generationId ? { generationId: this.generationId } : {}),
        stage: "completed",
        outcome: "success",
        waitMs: Math.max(0, context.startedAt - context.queuedAt),
        holdMs: Math.max(0, context.clock() - context.startedAt),
      });
      return result;
    } catch (error) {
      emitStorageOperationDiagnostic(this.diagnosticSink, {
        operation: operationName,
        correlationId: context.correlationId,
        ...(this.generationId ? { generationId: this.generationId } : {}),
        stage: "completed",
        outcome: "failure",
        waitMs: Math.max(0, context.startedAt - context.queuedAt),
        holdMs: Math.max(0, context.clock() - context.startedAt),
      });
      throw error;
    } finally {
      release();
    }
  }
}
