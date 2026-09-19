import { StorageWorkerClient } from "./storage-worker-client.js";
import type { StorageWorkerCommandHandlers } from "./storage-worker-dispatcher.js";
import { inspectAppDatabase } from "./app-database-diagnostics.js";
import { resolveOrMigrateAppDatabasePath, type AppDatabaseMigrationProgress } from "./app-database-path.js";

export const APP_DATABASE_RESOLVE_COMMAND = "app-database.resolve-or-migrate";
export const APP_DATABASE_INSPECT_COMMAND = "app-database.inspect";

export type AppDatabaseBootstrapRequest = {
  userDataPath: string;
  userDataPathOverrideApplied: boolean;
};

export type AppDatabaseBootstrapResult = {
  dbPath: string;
};

export type AppDatabaseInspectRequest = {
  userDataPath: string;
  activeDatabasePath: string;
  userDataPathOverrideApplied: boolean;
};

function isAppDatabaseBootstrapRequest(value: unknown): value is AppDatabaseBootstrapRequest {
  if (!value || typeof value !== "object") {
    return false;
  }
  const request = value as Partial<AppDatabaseBootstrapRequest>;
  return typeof request.userDataPath === "string"
    && typeof request.userDataPathOverrideApplied === "boolean";
}

function isAppDatabaseInspectRequest(value: unknown): value is AppDatabaseInspectRequest {
  if (!value || typeof value !== "object") {
    return false;
  }
  const request = value as Partial<AppDatabaseInspectRequest>;
  return typeof request.userDataPath === "string"
    && typeof request.activeDatabasePath === "string"
    && typeof request.userDataPathOverrideApplied === "boolean";
}

export function createStorageWorkerCommandHandlers(): StorageWorkerCommandHandlers {
  return {
    [APP_DATABASE_RESOLVE_COMMAND]: async (payload, context): Promise<AppDatabaseBootstrapResult> => {
      if (!isAppDatabaseBootstrapRequest(payload)) {
        throw new Error("App database bootstrap request is invalid.");
      }
      const dbPath = await resolveOrMigrateAppDatabasePath(payload.userDataPath, (event) => {
        context.reportProgress(event);
      });
      return { dbPath };
    },
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

export type AppDatabaseBootstrapWorker = {
  resolveOrMigrate(
    request: AppDatabaseBootstrapRequest,
    onProgress?: (progress: AppDatabaseMigrationProgress) => void,
  ): Promise<AppDatabaseBootstrapResult>;
  inspect(request: AppDatabaseInspectRequest): Promise<ReturnType<typeof inspectAppDatabase>>;
  close(): Promise<void>;
};

export function createAppDatabaseBootstrapWorker(): AppDatabaseBootstrapWorker {
  const workerEntry = new URL(
    import.meta.url.endsWith(".ts") ? "./storage-worker-entry.ts" : "./storage-worker-entry.js",
    import.meta.url,
  );
  const client = new StorageWorkerClient(workerEntry, {
    ...(import.meta.url.endsWith(".ts") ? { execArgv: ["--import", "tsx"] } : {}),
    workerData: {
      handlerModule: import.meta.url,
      handlerExport: "createStorageWorkerCommandHandlers",
    },
  });
  return {
    async resolveOrMigrate(request, onProgress) {
      return client.call<AppDatabaseBootstrapResult, AppDatabaseMigrationProgress>(APP_DATABASE_RESOLVE_COMMAND, request, {
        mutation: true,
        onProgress,
      });
    },
    inspect(request) {
      return client.call<ReturnType<typeof inspectAppDatabase>>(APP_DATABASE_INSPECT_COMMAND, request);
    },
    close() {
      return client.close();
    },
  };
}
