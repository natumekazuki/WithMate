import { parentPort, workerData } from "node:worker_threads";

import { PERSISTENCE_PROTOCOL_VERSION } from "../../src/shared/persistence-protocol.js";
import { decodeMainToWorkerMessage, isPlainObject } from "../../src/shared/persistence-runtime-protocol.js";

if (parentPort === null || !isPlainObject(workerData) || typeof workerData.generationId !== "string") {
  throw new Error("Invalid test worker setup.");
}

const port = parentPort;
const generationId = workerData.generationId;
port.postMessage({ protocolVersion: PERSISTENCE_PROTOCOL_VERSION, generationId, kind: "ready" });
port.on("message", (rawMessage: unknown) => {
  const decoded = decodeMainToWorkerMessage(rawMessage);
  if (!decoded.ok) {
    return;
  }
  const message = decoded.value;
  if (message.kind === "shutdown") {
    if (typeof workerData.databasePath === "string" && workerData.databasePath.includes("crash-on-shutdown")) {
      throw new Error("intentional shutdown crash");
    }
    if (typeof workerData.databasePath === "string" && workerData.databasePath.includes("wrong-closed")) {
      port.postMessage({
        protocolVersion: PERSISTENCE_PROTOCOL_VERSION,
        generationId,
        kind: "closed",
        requestId: "018f1f4e-7f0a-7000-8000-ffffffffffff",
        checkpoint: "completed",
      });
    }
    return;
  }
  if (message.kind !== "request") {
    return;
  }
  if (message.operation === "test.crash") {
    throw new Error("intentional test crash");
  }
  const delayMs =
    isPlainObject(message.payload) && typeof message.payload.delayMs === "number" ? message.payload.delayMs : 0;
  setTimeout(() => {
    port.postMessage({
      protocolVersion: PERSISTENCE_PROTOCOL_VERSION,
      generationId,
      kind: "response",
      requestId: message.requestId,
      ok: true,
      result: { operation: message.operation },
    });
  }, delayMs);
});
