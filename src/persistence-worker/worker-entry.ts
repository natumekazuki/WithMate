import { parentPort, workerData } from "node:worker_threads";

import {
  PERSISTENCE_PROTOCOL_VERSION,
  type PersistenceError,
  type PersistenceStartupFailedMessage,
} from "../shared/persistence-protocol.js";
import { isCanonicalUuid, isPlainObject } from "../shared/persistence-runtime-protocol.js";
import { DatabaseBootstrapError, openOrBootstrapDatabase } from "./sqlite-bootstrap.js";
import { PersistenceWorkerRuntime } from "./worker-runtime.js";

type PersistenceWorkerData = Readonly<{
  generationId: string;
  databasePath: string;
  legacyDatabasePaths: readonly string[];
  maxQueueDepth: number;
  maxConcurrentRuns: number;
  maxConcurrentRunsPerProvider: number;
}>;

if (parentPort === null) {
  throw new Error("Persistence worker requires a parent port.");
}

const port = parentPort;

try {
  const options = decodeWorkerData(workerData);
  const opened = openOrBootstrapDatabase({
    databasePath: options.databasePath,
    legacyDatabasePaths: options.legacyDatabasePaths,
  });
  const runtime = new PersistenceWorkerRuntime(
    options.generationId,
    opened.database,
    options.databasePath,
    (message, transferList) => {
      port.postMessage(message, transferList === undefined ? [] : [...transferList]);
      if (message.kind === "closed") {
        port.close();
      }
    },
    options.maxQueueDepth,
    {
      maxConcurrentRuns: options.maxConcurrentRuns,
      maxConcurrentRunsPerProvider: options.maxConcurrentRunsPerProvider,
    },
  );
  port.on("message", (message: unknown) => runtime.handleMessage(message));
  port.postMessage({
    protocolVersion: PERSISTENCE_PROTOCOL_VERSION,
    generationId: options.generationId,
    kind: "ready",
  });
} catch (error) {
  const generationId = readGenerationId(workerData);
  if (generationId !== undefined) {
    const failure: PersistenceStartupFailedMessage = {
      protocolVersion: PERSISTENCE_PROTOCOL_VERSION,
      generationId,
      kind: "startupFailed",
      error: mapStartupError(error),
    };
    port.postMessage(failure);
  }
  port.close();
}

function mapStartupError(error: unknown): PersistenceError {
  if (error instanceof DatabaseBootstrapError) {
    return {
      code: error.code,
      message: "Persistence database failed to start.",
      retryable: error.retryable,
      effect: "none",
    };
  }
  return {
    code: "worker_start_failed",
    message: "Persistence worker failed to start.",
    retryable: false,
    effect: "none",
  };
}

function decodeWorkerData(value: unknown): PersistenceWorkerData {
  if (
    !isPlainObject(value) ||
    !isCanonicalUuid(value.generationId) ||
    typeof value.databasePath !== "string" ||
    !Array.isArray(value.legacyDatabasePaths) ||
    !value.legacyDatabasePaths.every((item: unknown) => typeof item === "string") ||
    !Number.isSafeInteger(value.maxQueueDepth) ||
    (value.maxQueueDepth as number) < 0 ||
    !Number.isSafeInteger(value.maxConcurrentRuns) ||
    (value.maxConcurrentRuns as number) < 1 ||
    !Number.isSafeInteger(value.maxConcurrentRunsPerProvider) ||
    (value.maxConcurrentRunsPerProvider as number) < 1
  ) {
    throw new TypeError("Persistence worker data is invalid.");
  }
  return value as unknown as PersistenceWorkerData;
}

function readGenerationId(value: unknown): string | undefined {
  return isPlainObject(value) && isCanonicalUuid(value.generationId) ? value.generationId : undefined;
}
