import { randomUUID } from "node:crypto";
import { Worker, type WorkerOptions } from "node:worker_threads";

import {
  isStorageWorkerMessage,
  type StorageWorkerMessage,
  type StorageWorkerRequest,
} from "./storage-worker-protocol.js";
import { RuntimeTurnInactiveError } from "../platform/agent-runtime/runtime-turn-admission.js";
import {
  createStorageOperationDiagnosticContext,
  emitStorageOperationDiagnostic,
  type StorageOperationDiagnosticSink,
} from "./storage-operation-diagnostics.js";

/** Worker へ送信したかどうかと、要求の完了待ち・進捗通知・計測に必要な情報を保持する。 */
type PendingRequest = {
  mutation: boolean;
  sent: boolean;
  /** 対応する呼び出しを Worker の成功結果で完了させる。 */
  resolve(value: unknown): void;
  /** 対応する呼び出しを応答の失敗または通信中断で終了させる。 */
  reject(error: unknown): void;
  onProgress?: (progress: unknown) => void;
  operation: string;
  diagnostic?: ReturnType<typeof createStorageOperationDiagnosticContext>;
  workerQueueWaitMs?: number;
  workerExecutionMs?: number;
};

/** 送信済みの更新について、適用されたか確定できないことを示すエラー。 */
export class StorageWorkerUnknownOutcomeError extends Error {
  /** 更新結果が不明になった経緯を、必要に応じてメッセージに含める。 */
  constructor(message = "Storage worker write outcome is unknown.") {
    super(message);
    this.name = "StorageWorkerUnknownOutcomeError";
  }
}

/** Worker の世代が異なるか、既に利用できないことを示すエラー。 */
export class StorageWorkerGenerationError extends Error {
  /** 利用できなくなった世代の状態を、必要に応じてメッセージに含める。 */
  constructor(message = "Storage worker generation is no longer active.") {
    super(message);
    this.name = "StorageWorkerGenerationError";
  }
}

/** Worker から返された失敗を、コード・結果の分類・詳細とともに親側で扱うためのエラー。 */
export class StorageWorkerRemoteError extends Error {
  readonly code: string;
  readonly outcome: "not-executed" | "rejected" | "unknown";
  readonly details?: Record<string, string | number>;

  /** Worker から受け取った分類を保持し、分類がなければ未実行の一般的な失敗として構成する。 */
  constructor(
    message: string,
    code = "STORAGE_WORKER_COMMAND_FAILED",
    outcome: "not-executed" | "rejected" | "unknown" = "not-executed",
    details?: Record<string, string | number>,
  ) {
    super(message);
    this.name = "StorageWorkerRemoteError";
    this.code = code;
    this.outcome = outcome;
    this.details = details;
  }
}

/** 一つのストレージ Worker 世代への要求と応答を対応付け、終了や通信障害時に待機中の呼び出しを解決する。 */
export class StorageWorkerClient {
  readonly generationId = randomUUID();
  private readonly worker: Worker;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly queued: StorageWorkerRequest[] = [];
  private ready = false;
  private closed = false;
  private faulted = false;
  private closePromise: Promise<void> | null = null;
  private terminationPromise: Promise<number> | null = null;
  private readonly diagnosticSink?: StorageOperationDiagnosticSink;

  /** 一意の世代を割り当てて Worker を起動し、通知・エラー・終了の受信を開始する。 */
  constructor(
    workerUrl: URL | string,
    options: Omit<WorkerOptions, "workerData"> & {
      workerData: Record<string, unknown>;
      diagnosticSink?: StorageOperationDiagnosticSink;
    },
  ) {
    this.diagnosticSink = options.diagnosticSink;
    const { diagnosticSink: _diagnosticSink, ...workerOptions } = options;
    this.worker = new Worker(workerUrl, {
      ...workerOptions,
      workerData: {
        ...workerOptions.workerData,
        generationId: this.generationId,
      },
    });
    this.worker.on("message", (message: unknown) =>
      this.handleMessage(message),
    );
    this.worker.on("error", (error) => this.fail(error));
    this.worker.on("exit", (code) => {
      if (code !== 0) {
        this.fail(new Error(`Storage worker exited with code ${code}.`));
      } else if (!this.closed) {
        this.fail(new Error("Storage worker exited unexpectedly."));
      } else {
        this.rejectPendingForWorkerExit(
          "Storage worker exited before the request completed.",
        );
      }
    });
  }

  /** コマンドを要求 ID とともに登録し、準備できていれば送信、未準備なら送信待ちにする。 */
  call<T, TProgress = unknown>(
    command: string,
    payload: unknown,
    options: {
      mutation?: boolean;
      onProgress?: (progress: TProgress) => void;
      operation?: string;
    } = {},
  ): Promise<T> {
    if (this.closed || this.faulted) {
      return Promise.reject(
        new StorageWorkerGenerationError("Storage worker is closed."),
      );
    }
    const requestId = randomUUID();
    const mutation = options.mutation ?? false;
    const operation = options.operation ?? command;
    const diagnostic = this.diagnosticSink
      ? createStorageOperationDiagnosticContext()
      : undefined;
    emitStorageOperationDiagnostic(this.diagnosticSink, {
      operation,
      correlationId: diagnostic?.correlationId ?? requestId,
      generationId: this.generationId,
      stage: "queued",
      outcome: "pending",
      requestId,
    });
    const request: StorageWorkerRequest = {
      type: "call",
      context: { requestId, generationId: this.generationId },
      command,
      payload,
      mutation,
    };
    return new Promise<T>((resolve, reject) => {
      this.pending.set(requestId, {
        mutation,
        sent: false,
        resolve,
        reject,
        onProgress: options.onProgress as
          ((progress: unknown) => void) | undefined,
        operation,
        diagnostic,
      });
      if (this.ready) {
        this.send(request);
      } else {
        this.queued.push(request);
      }
    });
  }

  /** 新規受付と未送信要求を止め、Worker に終了を依頼して実際の終了まで待つ。 */
  async close(): Promise<void> {
    if (this.closePromise) {
      return this.closePromise;
    }
    if (this.faulted) {
      await this.terminateWorker();
      return;
    }
    this.closed = true;
    for (const request of this.queued.splice(0)) {
      this.rejectPending(
        request.type === "call" ? request.context.requestId : request.requestId,
        new StorageWorkerGenerationError(
          "Storage worker was closed before dispatch.",
        ),
      );
    }
    this.closePromise = (async () => {
      const requestId = randomUUID();
      const exited = new Promise<void>((resolve) =>
        this.worker.once("exit", resolve),
      );
      try {
        this.worker.postMessage({ type: "shutdown", requestId });
      } catch (error) {
        this.fail(error);
        await this.terminateWorker();
        return;
      }
      await exited;
      if (this.terminationPromise) await this.terminationPromise;
    })();
    return this.closePromise;
  }

  /** 要求を転送し、送信成功を記録する。複製できない入力はその要求だけを失敗させる。 */
  private send(request: StorageWorkerRequest): void {
    try {
      this.worker.postMessage(request);
      if (request.type === "call") {
        const pending = this.pending.get(request.context.requestId);
        if (pending) pending.sent = true;
      }
    } catch (error) {
      const requestId =
        request.type === "call" ? request.context.requestId : request.requestId;
      if (isStructuredCloneError(error)) {
        this.rejectPending(
          requestId,
          error instanceof Error ? error : new Error(String(error)),
        );
      } else {
        this.fail(error);
      }
    }
  }

  /** 形式と世代が正しい通知だけを受け付け、送信待ちの解除、進捗通知、要求の確定に振り分ける。 */
  private handleMessage(message: unknown): void {
    if (!isStorageWorkerMessage(message)) {
      this.fail(new Error("Storage worker response is invalid."));
      return;
    }
    if (message.type === "ready") {
      if (message.generationId !== this.generationId) {
        this.fail(
          new StorageWorkerGenerationError(
            "Storage worker generation does not match.",
          ),
        );
        return;
      }
      this.ready = true;
      for (const request of this.queued.splice(0)) {
        this.send(request);
      }
      return;
    }
    if (message.type === "shutdown-complete") {
      if (message.generationId !== this.generationId) {
        this.fail(
          new StorageWorkerGenerationError(
            "Storage worker shutdown generation does not match.",
          ),
        );
        return;
      }
      for (const requestId of [...this.pending.keys()]) {
        this.rejectPending(
          requestId,
          this.pending.get(requestId)?.sent &&
            this.pending.get(requestId)?.mutation
            ? new StorageWorkerUnknownOutcomeError(
                "Storage worker closed before the write result was received.",
              )
            : new StorageWorkerGenerationError(
                "Storage worker closed before the request completed.",
              ),
        );
      }
      return;
    }
    if (message.type === "progress") {
      if (message.generationId !== this.generationId) {
        this.fail(
          new StorageWorkerGenerationError(
            "Storage worker progress generation does not match.",
          ),
        );
        return;
      }
      this.pending.get(message.requestId)?.onProgress?.(message.progress);
      return;
    }
    if (message.type === "started") {
      if (message.generationId !== this.generationId) {
        this.fail(
          new StorageWorkerGenerationError(
            "Storage worker start generation does not match.",
          ),
        );
        return;
      }
      const pending = this.pending.get(message.requestId);
      if (pending) {
        pending.workerQueueWaitMs = message.queueWaitMs;
        if (pending.diagnostic) {
          pending.diagnostic.startedAt = pending.diagnostic.clock();
          emitStorageOperationDiagnostic(this.diagnosticSink, {
            operation: pending.operation,
            correlationId: pending.diagnostic.correlationId,
            generationId: this.generationId,
            stage: "started",
            outcome: "pending",
            waitMs: message.queueWaitMs,
            requestId: message.requestId,
          });
        }
      }
      return;
    }
    if (message.generationId !== this.generationId) {
      this.fail(
        new StorageWorkerGenerationError(
          "Storage worker response generation does not match.",
        ),
      );
      return;
    }
    this.resolveMessage(message);
  }

  /** 最終応答を要求 ID で照合し、計測を記録して、成功結果または分類済みのエラーを返す。 */
  private resolveMessage(
    message: Extract<StorageWorkerMessage, { type: "result" | "error" }>,
  ): void {
    const requestId = message.requestId;
    const pending = this.pending.get(requestId);
    if (!pending) {
      return;
    }
    this.pending.delete(requestId);
    pending.workerQueueWaitMs =
      message.timing?.queueWaitMs ?? pending.workerQueueWaitMs;
    pending.workerExecutionMs =
      message.timing?.executionMs ?? pending.workerExecutionMs;
    /** Worker の計測値を優先し、不足していればクライアント側の時刻で補って完了を記録する。 */
    const finishDiagnostic = (outcome: "success" | "failure") => {
      if (!pending.diagnostic) return;
      const completedAt = pending.diagnostic.clock();
      emitStorageOperationDiagnostic(this.diagnosticSink, {
        operation: pending.operation,
        correlationId: pending.diagnostic.correlationId,
        generationId: this.generationId,
        stage: "completed",
        outcome,
        waitMs:
          pending.workerQueueWaitMs ??
          (pending.diagnostic.startedAt === undefined
            ? completedAt - pending.diagnostic.queuedAt
            : undefined),
        holdMs:
          pending.workerExecutionMs ??
          (pending.diagnostic.startedAt === undefined
            ? undefined
            : completedAt - pending.diagnostic.startedAt),
        requestId,
      });
    };
    if (message.type === "result") {
      finishDiagnostic("success");
      pending.resolve(message.value);
      return;
    }
    finishDiagnostic("failure");
    const error =
      message.outcome === "unknown"
        ? new StorageWorkerUnknownOutcomeError(message.message)
        : rehydrateStorageWorkerError(message);
    error.name = message.name;
    if (message.stack) {
      error.stack = message.stack;
    }
    pending.reject(error);
  }

  /** 未完了の要求を取り除き、計測を失敗で終了して呼び出し元にエラーを返す。 */
  private rejectPending(requestId: string, error: Error): void {
    const pending = this.pending.get(requestId);
    if (!pending) {
      return;
    }
    this.pending.delete(requestId);
    if (pending.diagnostic) {
      const completedAt = pending.diagnostic.clock();
      emitStorageOperationDiagnostic(this.diagnosticSink, {
        operation: pending.operation,
        correlationId: pending.diagnostic.correlationId,
        generationId: this.generationId,
        stage: "completed",
        outcome: "failure",
        waitMs:
          pending.workerQueueWaitMs ??
          (pending.diagnostic.startedAt === undefined
            ? completedAt - pending.diagnostic.queuedAt
            : undefined),
        holdMs:
          pending.workerExecutionMs ??
          (pending.diagnostic.startedAt === undefined
            ? undefined
            : completedAt - pending.diagnostic.startedAt),
        requestId,
      });
    }
    pending.reject(error);
  }

  /** 現時点で未完了のすべての要求を同じエラーで終了させる。 */
  private rejectAllPending(error: Error): void {
    for (const requestId of [...this.pending.keys()])
      this.rejectPending(requestId, error);
  }

  /** Worker 終了後の未完了要求を終了させ、送信済みの更新だけを結果不明と区別する。 */
  private rejectPendingForWorkerExit(message: string): void {
    for (const requestId of [...this.pending.keys()]) {
      const pending = this.pending.get(requestId);
      this.rejectPending(
        requestId,
        pending?.sent && pending.mutation
          ? new StorageWorkerUnknownOutcomeError(message)
          : new StorageWorkerGenerationError(message),
      );
    }
  }

  /** Worker 世代を異常終了扱いとし、送信済み更新の結果不明を区別して待機を解除する。 */
  private fail(error: unknown): void {
    if (this.faulted) {
      return;
    }
    this.faulted = true;
    this.closed = true;
    this.ready = false;
    for (const [requestId, pending] of [...this.pending]) {
      this.rejectPending(
        requestId,
        pending.sent && pending.mutation
          ? new StorageWorkerUnknownOutcomeError(
              error instanceof Error ? error.message : String(error),
            )
          : error instanceof Error
            ? error
            : new Error(String(error)),
      );
    }
    for (const request of this.queued.splice(0)) {
      this.rejectPending(
        request.type === "call" ? request.context.requestId : request.requestId,
        error instanceof Error ? error : new Error(String(error)),
      );
    }
    void this.terminateWorker();
  }

  /** Worker に一度だけ強制終了を要求し、その完了を待つ Promise を再利用する。 */
  private terminateWorker(): Promise<number> {
    if (!this.terminationPromise) {
      this.terminationPromise = this.worker.terminate();
    }
    return this.terminationPromise;
  }
}

/** メッセージの構造化複製に失敗した場合に、転送先の障害と区別する。 */
function isStructuredCloneError(error: unknown): boolean {
  return error instanceof Error && error.name === "DataCloneError";
}

/** ターン受付終了のエラーは専用クラスへ戻し、それ以外は分類を保持したリモートエラーにする。 */
function rehydrateStorageWorkerError(
  message: Extract<StorageWorkerMessage, { type: "error" }>,
): Error {
  let error: Error;
  switch (message.code) {
    case "RUNTIME_TURN_INACTIVE":
      error = new RuntimeTurnInactiveError();
      break;
    default:
      return new StorageWorkerRemoteError(
        message.message,
        message.code,
        message.outcome,
        message.details,
      );
  }
  error.name = message.name || error.name;
  return error;
}
