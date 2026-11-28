import type {
  StorageWorkerCallRequest,
  StorageWorkerErrorMessage,
  StorageWorkerRequestContext,
} from "./storage-worker-protocol.js";
import { RuntimeTurnInactiveError } from "../platform/agent-runtime/runtime-turn-admission.js";
import {
  CoordinationDeletedError,
  CoordinationRejectedError,
} from "../coordination/coordination-errors.js";

/** 要求の識別子と、進捗通知・DB アクセスの順序制御をコマンドに渡す。 */
export type StorageWorkerHandlerContext = StorageWorkerRequestContext & {
  /** 実行中の要求に対して、コマンド固有の進捗を通知する。 */
  reportProgress(progress: unknown): void;
  /** DB 読み取りを共有の実行列に追加し、その結果を待つ。 */
  scheduleDb<T>(read: () => T): Promise<T>;
};

/** 要求の引数と実行環境を受け取り、同期または非同期で応答するコマンド処理。 */
export type StorageWorkerCommandHandler = (
  payload: unknown,
  context: StorageWorkerHandlerContext,
) => unknown | Promise<unknown>;

/** コマンド名から呼び出しを許可された処理を引くための読み取り専用の対応表。 */
export type StorageWorkerCommandHandlers = Readonly<
  Record<string, StorageWorkerCommandHandler>
>;

/** 対応表にないコマンドを実行せず拒否したことを示すエラー。 */
export class StorageWorkerCommandNotAllowedError extends Error {
  readonly code = "STORAGE_WORKER_COMMAND_NOT_ALLOWED";

  /** 拒否したコマンドの情報を含むエラーを構成する。 */
  constructor(message: string) {
    super(message);
    this.name = "StorageWorkerCommandNotAllowedError";
  }
}

/** 明示的に登録されたコマンドだけを実行し、要求コンテキストを添えて結果を待つ。 */
export async function dispatchStorageWorkerCall(
  handlers: StorageWorkerCommandHandlers,
  request: StorageWorkerCallRequest,
  context: Pick<StorageWorkerHandlerContext, "reportProgress"> &
    Partial<Pick<StorageWorkerHandlerContext, "scheduleDb">> = {
    /** 親への通知先を渡さない呼び出しでは、進捗を送らない。 */
    reportProgress: () => {},
  },
): Promise<unknown> {
  if (!Object.prototype.hasOwnProperty.call(handlers, request.command)) {
    throw new StorageWorkerCommandNotAllowedError(
      `Storage worker command is not allowed: ${request.command}`,
    );
  }
  const handler = handlers[request.command];
  if (!handler) {
    throw new StorageWorkerCommandNotAllowedError(
      `Storage worker command is not allowed: ${request.command}`,
    );
  }
  return handler(request.payload, {
    ...request.context,
    /** 実行列を渡さない呼び出しでは、DB 読み取りを直ちに実行する。 */
    scheduleDb: async (read) => read(),
    ...context,
  });
}

/** エラーを親へ転送できる形式にし、判明している未実行や業務上の拒否を結果不明と区別する。 */
export function serializeStorageWorkerError(
  requestId: string,
  generationId: string,
  error: unknown,
  outcome: "not-executed" | "rejected" | "unknown" = "unknown",
): StorageWorkerErrorMessage {
  const normalized = error instanceof Error ? error : new Error(String(error));
  let code = "STORAGE_WORKER_COMMAND_FAILED";
  if (normalized instanceof RuntimeTurnInactiveError) {
    code = "RUNTIME_TURN_INACTIVE";
  } else if (
    normalized instanceof CoordinationRejectedError ||
    normalized instanceof CoordinationDeletedError
  ) {
    code = normalized.code;
  } else if (normalized instanceof StorageWorkerCommandNotAllowedError) {
    code = normalized.code;
  }
  // 業務上の拒否は結果が確定しており、拒否のテレメトリが保存される場合もある。
  // 変更後の任意の例外は、引き続き書き込み結果が不明とみなす。
  if (
    normalized instanceof StorageWorkerCommandNotAllowedError ||
    normalized instanceof RuntimeTurnInactiveError
  )
    outcome = "not-executed";
  else if (code !== "STORAGE_WORKER_COMMAND_FAILED") outcome = "rejected";
  return {
    type: "error",
    requestId,
    generationId,
    name: normalized.name,
    message: normalized.message,
    code,
    outcome,
    ...(normalized.stack ? { stack: normalized.stack } : {}),
  };
}
