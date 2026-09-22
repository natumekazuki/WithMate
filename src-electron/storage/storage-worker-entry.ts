import { parentPort, workerData } from "node:worker_threads";
import { performance } from "node:perf_hooks";

import {
  dispatchStorageWorkerCall,
  serializeStorageWorkerError,
  type StorageWorkerCommandHandlers,
} from "./storage-worker-dispatcher.js";
import type {
  StorageWorkerEntryData,
  StorageWorkerMessage,
} from "./storage-worker-protocol.js";
import {
  isStorageWorkerCallRequest,
  isStorageWorkerShutdownRequest,
} from "./storage-worker-protocol.js";

if (!parentPort) {
  throw new Error("Storage worker requires a parent port.");
}

const entryData = workerData as StorageWorkerEntryData;
if (!entryData || typeof entryData.generationId !== "string" || typeof entryData.handlerModule !== "string") {
  throw new Error("Storage worker entry data is invalid.");
}

const handlersModule = await import(entryData.handlerModule);
const createHandlers = handlersModule[entryData.handlerExport ?? "createStorageWorkerCommandHandlers"] as
  | ((workerData: StorageWorkerEntryData) => StorageWorkerCommandHandlers | Promise<StorageWorkerCommandHandlers>)
  | undefined;
if (!createHandlers) {
  throw new Error("Storage worker command handler factory was not found.");
}
const handlers = await createHandlers(entryData);
const closeHandlers = handlersModule.closeStorageWorker as (() => void | Promise<void>) | undefined;

parentPort.postMessage({ type: "ready", generationId: entryData.generationId } satisfies StorageWorkerMessage);

let tail = Promise.resolve();
const resourceLanes = new Map<string, Promise<void>>();
let shuttingDown = false;

function scheduleFatalWorkerError(error: unknown): void {
  const fatal = error instanceof Error ? error : new Error(String(error));
  setImmediate(() => {
    throw fatal;
  });
}

function resourceLaneForRequest(request: Parameters<typeof dispatchStorageWorkerCall>[1]): string | null {
  if (request.command !== "store.call" || !request.payload || typeof request.payload !== "object") {
    return null;
  }
  const payload = request.payload as { store?: unknown };
  if (payload.store === "character") return "character";
  if (payload.store === "mate") return "mate";
  return null;
}

async function executeRequest(
  request: Parameters<typeof dispatchStorageWorkerCall>[1],
  receivedAt: number,
): Promise<void> {
  const startedAt = performance.now();
  parentPort!.postMessage({
    type: "started",
    requestId: request.context.requestId,
    generationId: entryData.generationId,
    queueWaitMs: startedAt - receivedAt,
  } satisfies StorageWorkerMessage);
  try {
    if (request.context.generationId !== entryData.generationId) {
      throw new Error("Storage worker request generation does not match.");
    }
    const value = await dispatchStorageWorkerCall(handlers, request, {
      reportProgress: (progress) => {
        parentPort!.postMessage({
          type: "progress",
          requestId: request.context.requestId,
          generationId: entryData.generationId,
          progress,
        } satisfies StorageWorkerMessage);
      },
    });
    parentPort!.postMessage({
      type: "result",
      requestId: request.context.requestId,
      generationId: entryData.generationId,
      value,
      timing: { queueWaitMs: startedAt - receivedAt, executionMs: performance.now() - startedAt },
    } satisfies StorageWorkerMessage);
  } catch (error) {
    const errorMessage = serializeStorageWorkerError(
      request.context.requestId,
      entryData.generationId,
      error,
      request.mutation ? "unknown" : "not-executed",
    );
    errorMessage.timing = { queueWaitMs: startedAt - receivedAt, executionMs: performance.now() - startedAt };
    parentPort!.postMessage(errorMessage);
  }
}

function enqueueResourceRequest(
  lane: string,
  request: Parameters<typeof dispatchStorageWorkerCall>[1],
  receivedAt: number,
): void {
  const previous = resourceLanes.get(lane) ?? Promise.resolve();
  const current = previous.then(() => executeRequest(request, receivedAt));
  resourceLanes.set(lane, current);
  void current.then(
    () => {
      if (resourceLanes.get(lane) === current) resourceLanes.delete(lane);
    },
    (error) => {
      if (resourceLanes.get(lane) === current) resourceLanes.delete(lane);
      scheduleFatalWorkerError(error);
    },
  );
}

parentPort.on("message", (rawRequest: unknown) => {
  if (isStorageWorkerShutdownRequest(rawRequest)) {
    const request = rawRequest;
    shuttingDown = true;
    tail = tail.then(async () => {
      await Promise.all([...resourceLanes.values()]);
      return Promise.resolve(closeHandlers?.()).then(() => {
        parentPort!.postMessage({
          type: "shutdown-complete",
          requestId: request.requestId,
          generationId: entryData.generationId,
        } satisfies StorageWorkerMessage);
        parentPort!.close();
      });
    }).catch((error) => {
      scheduleFatalWorkerError(error);
    });
    return;
  }
  if (!isStorageWorkerCallRequest(rawRequest)) {
    return;
  }
  const request = rawRequest;
  if (shuttingDown) {
    parentPort!.postMessage(serializeStorageWorkerError(
      request.context.requestId,
      entryData.generationId,
      new Error("Storage worker is shutting down."),
    ));
    return;
  }

  const receivedAt = performance.now();
  const lane = resourceLaneForRequest(request);
  if (lane) {
    enqueueResourceRequest(lane, request, receivedAt);
  } else {
    tail = tail.then(() => executeRequest(request, receivedAt)).catch((error) => {
      scheduleFatalWorkerError(error);
    });
  }
});
