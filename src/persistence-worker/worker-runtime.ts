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
import { REPOSITORY_READ_OPERATIONS } from "../shared/repository-read-model.js";
import { BoundedSerialExecutor, PersistenceExecutorError } from "./request-executor.js";
import { createRepositoryReadOperations, RepositoryReadError } from "./repository-read-model.js";
import { createRepositoryWriteOperations, type RepositoryWriteCapacityOptions } from "./repository-write-model.js";

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
    writeCapacity: RepositoryWriteCapacityOptions = {
      maxConcurrentRuns: 4,
      maxConcurrentRunsPerProvider: 4,
    },
  ) {
    this.#executor = new BoundedSerialExecutor(maxQueueDepth);
    this.#operations = createOperationRegistry(database, databasePath, writeCapacity);
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
    if (error instanceof RepositoryReadError) {
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
  writeCapacity: RepositoryWriteCapacityOptions,
): ReadonlyMap<string, OperationDefinition> {
  const operations = new Map<string, OperationDefinition>([
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
      REPOSITORY_READ_OPERATIONS.payloadChunk,
      {
        requestClass: "read",
        execute: (payload) => readPayloadChunk(database, payload),
      },
    ],
    [
      REPOSITORY_READ_OPERATIONS.messageContentChunk,
      {
        requestClass: "read",
        execute: (payload) => readMessageContentChunk(database, payload),
      },
    ],
    [
      REPOSITORY_READ_OPERATIONS.sessionDirectoriesChunk,
      {
        requestClass: "read",
        execute: (payload) => readSessionDirectoriesChunk(database, payload),
      },
    ],
    [
      REPOSITORY_READ_OPERATIONS.runSnapshotChunk,
      {
        requestClass: "read",
        execute: (payload) => readRunSnapshotChunk(database, payload),
      },
    ],
  ]);
  for (const [name, definition] of createRepositoryReadOperations(database)) {
    operations.set(name, definition);
  }
  for (const [name, definition] of createRepositoryWriteOperations(database, { ...writeCapacity, databasePath })) {
    operations.set(name, definition);
  }
  return operations;
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
  const { sessionId, runId, outputItemId, workspaceKey, offset, maxBytes } = payload;
  if (
    Object.keys(payload).sort().join(",") !== "maxBytes,offset,outputItemId,runId,sessionId,workspaceKey" ||
    typeof sessionId !== "string" ||
    sessionId.length === 0 ||
    typeof runId !== "string" ||
    runId.length === 0 ||
    typeof outputItemId !== "string" ||
    outputItemId.length === 0 ||
    typeof workspaceKey !== "string" ||
    workspaceKey.length === 0 ||
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
    .prepare(
      `
      SELECT p.byte_length, substr(p.content, ? + 1, ?) AS chunk
      FROM run_output_payloads p
      JOIN run_output_items o ON o.id = p.output_item_id
      JOIN runs r ON r.id = o.run_id
      JOIN sessions s ON s.id = r.session_id
      WHERE p.output_item_id = ? AND o.run_id = ? AND r.session_id = ? AND s.workspace_key = ?
    `,
    )
    .get(offset as number, maxBytes as number, outputItemId, runId, sessionId, workspaceKey) as
    Readonly<{ byte_length: number; chunk: Uint8Array }> | undefined;
  if (row === undefined) {
    throw new PayloadChunkError("payload_chunk_invalid", "Payload does not exist.");
  }
  const chunk = Uint8Array.from(row.chunk);
  const bytes = chunk.buffer;
  return {
    result: {
      sessionId,
      runId,
      outputItemId,
      offset,
      totalBytes: row.byte_length,
      eof: (offset as number) + chunk.byteLength >= row.byte_length,
      bytes,
    },
    transferList: [bytes],
  };
}

function readMessageContentChunk(database: DatabaseSync, payload: Readonly<Record<string, unknown>>): OperationResult {
  const { sessionId, messageId, workspaceKey, offset, maxBytes } = payload;
  if (
    Object.keys(payload).sort().join(",") !== "maxBytes,messageId,offset,sessionId,workspaceKey" ||
    typeof sessionId !== "string" ||
    sessionId.length === 0 ||
    typeof messageId !== "string" ||
    messageId.length === 0 ||
    typeof workspaceKey !== "string" ||
    workspaceKey.length === 0 ||
    !Number.isSafeInteger(offset) ||
    (offset as number) < 0 ||
    !Number.isSafeInteger(maxBytes) ||
    (maxBytes as number) < 1
  ) {
    throw new PayloadChunkError("payload_chunk_invalid", "Message content chunk request is invalid.");
  }
  if ((maxBytes as number) > MAX_PAYLOAD_CHUNK_BYTES) {
    throw new PayloadChunkError("payload_chunk_too_large", "Message content chunk exceeds the maximum size.");
  }
  const row = database
    .prepare(
      `
    SELECT length(CAST(m.content_blocks_json AS BLOB)) AS byte_length,
           substr(CAST(m.content_blocks_json AS BLOB), ? + 1, ?) AS chunk
    FROM messages m JOIN sessions s ON s.id = m.session_id
    WHERE m.id = ? AND m.session_id = ? AND s.workspace_key = ?
  `,
    )
    .get(offset as number, maxBytes as number, messageId, sessionId, workspaceKey) as
    Readonly<{ byte_length: number; chunk: Uint8Array }> | undefined;
  if (row === undefined) {
    throw new PayloadChunkError("payload_chunk_invalid", "Message does not exist.");
  }
  const bytes = Uint8Array.from(row.chunk).buffer;
  return {
    result: {
      sessionId,
      messageId,
      offset,
      totalBytes: row.byte_length,
      eof: (offset as number) + bytes.byteLength >= row.byte_length,
      bytes,
    },
    transferList: [bytes],
  };
}

function readSessionDirectoriesChunk(
  database: DatabaseSync,
  payload: Readonly<Record<string, unknown>>,
): OperationResult {
  const request = readJsonChunkRequest(payload, ["sessionId", "workspaceKey"]);
  const sessionId = request.scope.sessionId!;
  const workspaceKey = request.scope.workspaceKey!;
  const row = database
    .prepare(
      `
    SELECT length(CAST(allowed_additional_directories_json AS BLOB)) AS byte_length,
           substr(CAST(allowed_additional_directories_json AS BLOB), ? + 1, ?) AS chunk
    FROM sessions WHERE id = ? AND workspace_key = ?
  `,
    )
    .get(request.offset, request.maxBytes, sessionId, workspaceKey) as
    Readonly<{ byte_length: number; chunk: Uint8Array }> | undefined;
  return jsonChunkResult(row, request, { sessionId });
}

function readRunSnapshotChunk(database: DatabaseSync, payload: Readonly<Record<string, unknown>>): OperationResult {
  const request = readJsonChunkRequest(payload, ["sessionId", "runId", "workspaceKey"]);
  const runId = request.scope.runId;
  if (typeof runId !== "string" || runId.length === 0) {
    throw new PayloadChunkError("payload_chunk_invalid", "Run snapshot chunk request is invalid.");
  }
  const sessionId = request.scope.sessionId!;
  const workspaceKey = request.scope.workspaceKey!;
  const row = database
    .prepare(
      `
    SELECT length(CAST(r.execution_snapshot_json AS BLOB)) AS byte_length,
           substr(CAST(r.execution_snapshot_json AS BLOB), ? + 1, ?) AS chunk
    FROM runs r JOIN sessions s ON s.id = r.session_id
    WHERE r.id = ? AND r.session_id = ? AND s.workspace_key = ?
  `,
    )
    .get(request.offset, request.maxBytes, runId, sessionId, workspaceKey) as
    Readonly<{ byte_length: number; chunk: Uint8Array }> | undefined;
  return jsonChunkResult(row, request, { sessionId, runId });
}

function readJsonChunkRequest(payload: Readonly<Record<string, unknown>>, scopeKeys: readonly string[]) {
  const expectedKeys = [...scopeKeys, "offset", "maxBytes"].sort();
  if (Object.keys(payload).sort().join(",") !== expectedKeys.join(",")) {
    throw new PayloadChunkError("payload_chunk_invalid", "JSON chunk request is invalid.");
  }
  if (scopeKeys.some((key) => typeof payload[key] !== "string" || (payload[key] as string).length === 0)) {
    throw new PayloadChunkError("payload_chunk_invalid", "JSON chunk request scope is invalid.");
  }
  const sessionId = payload.sessionId;
  const workspaceKey = payload.workspaceKey;
  const offset = payload.offset;
  const maxBytes = payload.maxBytes;
  if (
    typeof sessionId !== "string" ||
    sessionId.length === 0 ||
    typeof workspaceKey !== "string" ||
    workspaceKey.length === 0 ||
    !Number.isSafeInteger(offset) ||
    (offset as number) < 0 ||
    !Number.isSafeInteger(maxBytes) ||
    (maxBytes as number) < 1
  ) {
    throw new PayloadChunkError("payload_chunk_invalid", "JSON chunk request is invalid.");
  }
  if ((maxBytes as number) > MAX_PAYLOAD_CHUNK_BYTES) {
    throw new PayloadChunkError("payload_chunk_too_large", "JSON chunk exceeds the maximum size.");
  }
  return {
    scope: Object.fromEntries(scopeKeys.map((key) => [key, payload[key]])) as Record<string, string>,
    offset: offset as number,
    maxBytes: maxBytes as number,
  };
}

function jsonChunkResult(
  row: Readonly<{ byte_length: number; chunk: Uint8Array }> | undefined,
  request: Readonly<{ offset: number }>,
  scope: Readonly<Record<string, string>>,
): OperationResult {
  if (row === undefined) {
    throw new PayloadChunkError("payload_chunk_invalid", "JSON document does not exist.");
  }
  const bytes = Uint8Array.from(row.chunk).buffer;
  return {
    result: {
      ...scope,
      offset: request.offset,
      totalBytes: row.byte_length,
      eof: request.offset + bytes.byteLength >= row.byte_length,
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
