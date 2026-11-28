import { StorageWorkerClient } from "./storage-worker-client.js";
import type { StorageWorkerCommandHandlers } from "./storage-worker-dispatcher.js";
import { inspectAppDatabase } from "./app-database-diagnostics.js";
import {
  resolveOrMigrateAppDatabasePath,
  type AppDatabaseMigrationProgress,
} from "./app-database-path.js";

/** 保存先の解決と起動時移行を要求する Worker コマンド。 */
export const APP_DATABASE_RESOLVE_COMMAND = "app-database.resolve-or-migrate";
/** 指定した保存先の診断結果を取得する Worker コマンド。 */
export const APP_DATABASE_INSPECT_COMMAND = "app-database.inspect";

/** 保存先を解決する Worker に渡すユーザーデータの位置と、保存先上書きの適用状態。 */
export type AppDatabaseBootstrapRequest = {
  userDataPath: string;
  userDataPathOverrideApplied: boolean;
};

/** 解決または移行が完了したアプリ DB のパス。 */
export type AppDatabaseBootstrapResult = {
  dbPath: string;
};

/** 診断対象のユーザーデータと、起動時に選択された DB を指定する要求。 */
export type AppDatabaseInspectRequest = {
  userDataPath: string;
  activeDatabasePath: string;
  userDataPathOverrideApplied: boolean;
};

/** 移行を開始する前に、Worker に届いた要求の保存先と上書きフラグの型を確認する。 */
function isAppDatabaseBootstrapRequest(
  value: unknown,
): value is AppDatabaseBootstrapRequest {
  if (!value || typeof value !== "object") {
    return false;
  }
  const request = value as Partial<AppDatabaseBootstrapRequest>;
  return (
    typeof request.userDataPath === "string" &&
    typeof request.userDataPathOverrideApplied === "boolean"
  );
}

/** 診断を実行する前に、Worker に届いた要求にユーザーデータと稼働中 DB のパスがあるか確認する。 */
function isAppDatabaseInspectRequest(
  value: unknown,
): value is AppDatabaseInspectRequest {
  if (!value || typeof value !== "object") {
    return false;
  }
  const request = value as Partial<AppDatabaseInspectRequest>;
  return (
    typeof request.userDataPath === "string" &&
    typeof request.activeDatabasePath === "string" &&
    typeof request.userDataPathOverrideApplied === "boolean"
  );
}

/** 保存先の解決と診断を受け付け、検証済みの要求を各ストレージ処理に渡す。 */
export function createStorageWorkerCommandHandlers(): StorageWorkerCommandHandlers {
  return {
    /** 保存先を解決し、必要なら移行を実行する。移行の進捗は要求元へ転送する。 */
    [APP_DATABASE_RESOLVE_COMMAND]: async (
      payload,
      context,
    ): Promise<AppDatabaseBootstrapResult> => {
      if (!isAppDatabaseBootstrapRequest(payload)) {
        throw new Error("App database bootstrap request is invalid.");
      }
      const dbPath = await resolveOrMigrateAppDatabasePath(
        payload.userDataPath,
        (event) => {
          context.reportProgress(event);
        },
      );
      return { dbPath };
    },
    /** 要求された稼働中 DB とユーザーデータ配下の既知 DB を診断する。 */
    [APP_DATABASE_INSPECT_COMMAND]: async (payload) => {
      if (!isAppDatabaseInspectRequest(payload)) {
        throw new Error("App database inspection request is invalid.");
      }
      return inspectAppDatabase(
        payload.userDataPath,
        payload.activeDatabasePath,
        payload.userDataPathOverrideApplied,
      );
    },
  };
}

/** 起動側が Worker 経由で DB の準備・診断・終了を行うための窓口。 */
export type AppDatabaseBootstrapWorker = {
  /** 稼働用 DB のパスを取得する。起動時移行が必要な場合は進捗を通知する。 */
  resolveOrMigrate(
    request: AppDatabaseBootstrapRequest,
    onProgress?: (progress: AppDatabaseMigrationProgress) => void,
  ): Promise<AppDatabaseBootstrapResult>;
  /** 指定された DB の診断結果を取得する。 */
  inspect(
    request: AppDatabaseInspectRequest,
  ): Promise<ReturnType<typeof inspectAppDatabase>>;
  /** 起動時処理を担った Worker 接続を閉じる。 */
  close(): Promise<void>;
};

/** 実行中の拡張子に応じて Worker の入口を選び、DB 起動時処理用のクライアントを構成する。 */
export function createAppDatabaseBootstrapWorker(): AppDatabaseBootstrapWorker {
  const workerEntry = new URL(
    import.meta.url.endsWith(".ts")
      ? "./storage-worker-entry.ts"
      : "./storage-worker-entry.js",
    import.meta.url,
  );
  const client = new StorageWorkerClient(workerEntry, {
    ...(import.meta.url.endsWith(".ts")
      ? { execArgv: ["--import", "tsx"] }
      : {}),
    workerData: {
      handlerModule: import.meta.url,
      handlerExport: "createStorageWorkerCommandHandlers",
    },
  });
  return {
    /** 保存先の解決を更新系のコマンドとして呼び出し、進捗を受け取る。 */
    async resolveOrMigrate(request, onProgress) {
      return client.call<
        AppDatabaseBootstrapResult,
        AppDatabaseMigrationProgress
      >(APP_DATABASE_RESOLVE_COMMAND, request, {
        mutation: true,
        onProgress,
      });
    },
    /** 保存先の診断を読み取り用コマンドとして呼び出す。 */
    inspect(request) {
      return client.call<ReturnType<typeof inspectAppDatabase>>(
        APP_DATABASE_INSPECT_COMMAND,
        request,
      );
    },
    /** クライアントを閉じ、起動時処理用の Worker を終了する。 */
    close() {
      return client.close();
    },
  };
}
