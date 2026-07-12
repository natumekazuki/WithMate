import { DatabaseSync } from "node:sqlite";

import {
  PERSISTENCE_PROTOCOL_VERSION,
  type MainToWorkerMessage,
  type PersistenceError,
  type PersistenceRequestMessage,
  type PersistenceResponseMessage,
  type WorkerToMainMessage,
} from "../shared/persistence-protocol.js";
import { decodeMainToWorkerMessage, isPlainObject } from "../shared/persistence-runtime-protocol.js";
import { BoundedSerialExecutor, PersistenceExecutorError } from "./request-executor.js";

export const MAX_PERSISTENCE_RESPONSE_BYTES = 256 * 1024;
export const MAX_PAYLOAD_CHUNK_BYTES = 256 * 1024;

export type PersistenceWorkerPostMessage = (
  message: WorkerToMainMessage,
  transferList?: readonly ArrayBuffer[],
) => void;

type OperationResult = Readonly<{
  result: unknown;
  transferList?: readonly ArrayBuffer[];
}>;

type OperationDefinition = Readonly<{
  requestClass: PersistenceRequestMessage["requestClass"];
  execute: (payload: Readonly<Record<string, unknown>>) => OperationResult;
}>;

export class PersistenceWorkerRuntime {
  readonly #executor: BoundedSerialExecutor;
  readonly #operations: ReadonlyMap<string, OperationDefinition>;
  #highestRequestSequence = 0;
  #state: "ready" | "closing" | "closed" = "ready";

  constructor(
    readonly generationId: string,
    readonly database: DatabaseSync,
    readonly databasePath: string,
    readonly postMessage: PersistenceWorkerPostMessage,
    maxQueueDepth = 128,
  ) {
    this.#executor = new BoundedSerialExecutor(maxQueueDepth);
    this.#operations = createOperationRegistry(database, databasePath);
  }

  handleMessage(rawMessage: unknown): void {
    const decoded = decodeMainToWorkerMessage(rawMessage);
    if (!decoded.ok || decoded.value.generationId !== this.generationId) {
      return;
    }
    const message = decoded.value;
    switch (message.kind) {
      case "request":
        this.#handleRequest(message);
        return;
      case "cancel":
        this.#executor.cancel(message.requestId);
        return;
      case "shutdown":
        void this.#shutdown(message.requestId);
    }
  }

  #handleRequest(message: PersistenceRequestMessage): void {
    if (this.#state !== "ready") {
      this.#postFailure(message.requestId, {
        code: "worker_closing",
        message: "Persistence worker is closing.",
        retryable: true,
        effect: "none",
      });
      return;
    }
    if (message.requestSequence <= this.#highestRequestSequence) {
      this.#postFailure(message.requestId, {
        code: "request_id_duplicate",
        message: "Request sequence was already used in this worker generation.",
        retryable: false,
        effect: "none",
      });
      return;
    }
    this.#highestRequestSequence = message.requestSequence;

    const operation = this.#operations.get(message.operation);
    if (operation === undefined || operation.requestClass !== message.requestClass) {
      this.#postFailure(message.requestId, {
        code: "operation_not_supported",
        message: "Persistence operation is not supported.",
        retryable: false,
        effect: "none",
      });
      return;
    }

    if (!isPlainObject(message.payload)) {
      return;
    }
    const payload = message.payload;
    void this.#executor
      .submit(message.requestId, message.requestClass, () => operation.execute(payload))
      .then(({ result, transferList }) => {
        const response: PersistenceResponseMessage = {
          protocolVersion: PERSISTENCE_PROTOCOL_VERSION,
          generationId: this.generationId,
          kind: "response",
          requestId: message.requestId,
          ok: true,
          result,
        };
        assertResponseWithinLimit(response, transferList);
        this.postMessage(response, transferList);
      })
      .catch((error: unknown) => this.#postOperationFailure(message, error));
  }

  async #shutdown(requestId: string): Promise<void> {
    if (this.#state !== "ready") {
      return;
    }
    this.#state = "closing";
    this.#executor.closeAdmission();
    await this.#executor.whenIdle();

    this.database.close();
    let checkpoint: "completed" | "failed";
    try {
      checkpointDatabase(this.databasePath, "TRUNCATE");
      checkpoint = "completed";
    } catch {
      checkpoint = "failed";
    }
    this.#state = "closed";
    this.postMessage({
      protocolVersion: PERSISTENCE_PROTOCOL_VERSION,
      generationId: this.generationId,
      kind: "closed",
      requestId,
      checkpoint,
    });
  }

  #postOperationFailure(message: PersistenceRequestMessage, error: unknown): void {
    const mutatingOperationMayHaveStarted =
      message.requestClass !== "read" && !(error instanceof PersistenceExecutorError);
    if (error instanceof PersistenceExecutorError) {
      this.#postFailure(message.requestId, {
        code: error.code,
        message: error.message,
        retryable: error.code === "queue_full" || error.code === "worker_closing",
        effect: "none",
      });
      return;
    }
    if (error instanceof PayloadChunkError) {
      this.#postFailure(message.requestId, {
        code: error.code,
        message: error.message,
        retryable: false,
        effect: "none",
      });
      return;
    }
    this.#postFailure(message.requestId, {
      code: error instanceof ResponseLimitError ? "response_too_large" : "operation_failed",
      message: error instanceof ResponseLimitError ? error.message : "Persistence operation failed.",
      retryable: false,
      effect: mutatingOperationMayHaveStarted ? "unknown" : "none",
    });
  }

  #postFailure(requestId: string, error: PersistenceError): void {
    this.postMessage({
      protocolVersion: PERSISTENCE_PROTOCOL_VERSION,
      generationId: this.generationId,
      kind: "response",
      requestId,
      ok: false,
      error,
    });
  }
}

function createOperationRegistry(
  database: DatabaseSync,
  databasePath: string,
): ReadonlyMap<string, OperationDefinition> {
  return new Map<string, OperationDefinition>([
    [
      "runtime.ping",
      {
        requestClass: "read",
        execute: () => ({ result: { ready: true } }),
      },
    ],
    [
      "database.checkpoint",
      {
        requestClass: "maintenance",
        execute: () => {
          checkpointDatabase(databasePath, "PASSIVE");
          return { result: { completed: true } };
        },
      },
    ],
    [
      "payload.read_chunk",
      {
        requestClass: "read",
        execute: (payload) => readPayloadChunk(database, payload),
      },
    ],
  ]);
}

function checkpointDatabase(databasePath: string, mode: "PASSIVE" | "TRUNCATE"): void {
  const maintenance = new DatabaseSync(databasePath);
  try {
    maintenance.exec(`
      PRAGMA foreign_keys = ON;
      PRAGMA secure_delete = FAST;
      PRAGMA busy_timeout = 5000;
      PRAGMA wal_autocheckpoint = 256;
      PRAGMA journal_size_limit = 67108864;
    `);
    const row = maintenance.prepare(`PRAGMA wal_checkpoint(${mode})`).get() as unknown as
      Readonly<{ busy: number }> | undefined;
    if (row === undefined || row.busy !== 0) {
      throw new Error("SQLite checkpoint did not complete.");
    }
  } finally {
    maintenance.close();
  }
}

function readPayloadChunk(database: DatabaseSync, payload: Readonly<Record<string, unknown>>): OperationResult {
  const { payloadId, offset, maxBytes } = payload;
  if (
    typeof payloadId !== "string" ||
    payloadId.length === 0 ||
    !Number.isSafeInteger(offset) ||
    (offset as number) < 0 ||
    !Number.isSafeInteger(maxBytes) ||
    (maxBytes as number) < 1
  ) {
    throw new PayloadChunkError("payload_chunk_invalid", "Payload chunk request is invalid.");
  }
  if ((maxBytes as number) > MAX_PAYLOAD_CHUNK_BYTES) {
    throw new PayloadChunkError("payload_chunk_too_large", "Payload chunk exceeds the maximum size.");
  }

  const row = database
    .prepare("SELECT byte_length, substr(content, ? + 1, ?) AS chunk FROM run_output_payloads WHERE output_item_id = ?")
    .get(offset as number, maxBytes as number, payloadId) as
    Readonly<{ byte_length: number; chunk: Uint8Array }> | undefined;
  if (row === undefined) {
    throw new PayloadChunkError("payload_chunk_invalid", "Payload does not exist.");
  }
  const chunk = Uint8Array.from(row.chunk);
  const bytes = chunk.buffer;
  return {
    result: {
      payloadId,
      offset,
      totalBytes: row.byte_length,
      eof: (offset as number) + chunk.byteLength >= row.byte_length,
      bytes,
    },
    transferList: [bytes],
  };
}

function assertResponseWithinLimit(result: unknown, transferList: readonly ArrayBuffer[] | undefined): void {
  const transferredBytes = transferList?.reduce((total, buffer) => total + buffer.byteLength, 0) ?? 0;
  const jsonBytes = Buffer.byteLength(
    JSON.stringify(result, (_key, value: unknown) => (value instanceof ArrayBuffer ? null : value)),
  );
  if (transferredBytes + jsonBytes > MAX_PERSISTENCE_RESPONSE_BYTES) {
    throw new ResponseLimitError("Persistence response exceeds the maximum size.");
  }
}

class ResponseLimitError extends Error {}

class PayloadChunkError extends Error {
  constructor(
    readonly code: "payload_chunk_invalid" | "payload_chunk_too_large",
    message: string,
  ) {
    super(message);
  }
}
