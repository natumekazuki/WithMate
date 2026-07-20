import { DatabaseSync } from "node:sqlite";

import {
  MAX_PERSISTENCE_RESPONSE_BYTES,
  PERSISTENCE_PROTOCOL_VERSION,
  type MainToWorkerMessage,
  type PersistenceError,
  type PersistenceRequestMessage,
  type PersistenceResponseMessage,
  type WorkerToMainMessage,
} from "../shared/persistence-protocol.js";
import { decodeMainToWorkerMessage, isPlainObject } from "../shared/persistence-runtime-protocol.js";
import { REPOSITORY_CHUNK_LIMITS, REPOSITORY_READ_OPERATIONS } from "../shared/repository-read-model.js";
import { BoundedSerialExecutor, PersistenceExecutorError } from "./request-executor.js";
import { createRepositoryReadOperations, RepositoryReadError } from "./repository-read-model.js";
import { createRepositoryWriteOperations, type RepositoryWriteCapacityOptions } from "./repository-write-model.js";

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
  execute: (payload: Readonly<Record<string, unknown>>, context: OperationExecutionContext) => OperationResult;
}>;

type OperationExecutionContext = Readonly<{
  generationId: string;
  requestId: string;
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
      .submit(message.requestId, message.requestClass, () =>
        operation.execute(payload, { generationId: this.generationId, requestId: message.requestId }),
      )
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
        execute: (payload, context) => readPayloadChunk(database, payload, context),
      },
    ],
    [
      REPOSITORY_READ_OPERATIONS.messageContentChunk,
      {
        requestClass: "read",
        execute: (payload, context) => readMessageContentChunk(database, payload, context),
      },
    ],
    [
      REPOSITORY_READ_OPERATIONS.sessionDirectoriesChunk,
      {
        requestClass: "read",
        execute: (payload, context) => readSessionDirectoriesChunk(database, payload, context),
      },
    ],
    [
      REPOSITORY_READ_OPERATIONS.runSnapshotChunk,
      {
        requestClass: "read",
        execute: (payload, context) => readRunSnapshotChunk(database, payload, context),
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

function readPayloadChunk(
  database: DatabaseSync,
  payload: Readonly<Record<string, unknown>>,
  context: OperationExecutionContext,
): OperationResult {
  const request = readChunkRequest(payload, ["sessionId", "runId", "outputItemId", "workspaceKey"], "Payload");
  const { sessionId, runId, outputItemId, workspaceKey } = request.scope;
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
    .get(request.offset, request.maxBytes, outputItemId, runId, sessionId, workspaceKey) as
    Readonly<{ byte_length: number; chunk: Uint8Array }> | undefined;
  return chunkResult(row, request, { sessionId, runId, outputItemId }, context, "Payload");
}

function readMessageContentChunk(
  database: DatabaseSync,
  payload: Readonly<Record<string, unknown>>,
  context: OperationExecutionContext,
): OperationResult {
  const request = readChunkRequest(payload, ["sessionId", "messageId", "workspaceKey"], "Message content");
  const { sessionId, messageId, workspaceKey } = request.scope;
  const row = database
    .prepare(
      `
    SELECT length(CAST(m.content_blocks_json AS BLOB)) AS byte_length,
           substr(CAST(m.content_blocks_json AS BLOB), ? + 1, ?) AS chunk
    FROM messages m JOIN sessions s ON s.id = m.session_id
    WHERE m.id = ? AND m.session_id = ? AND s.workspace_key = ?
  `,
    )
    .get(request.offset, request.maxBytes, messageId, sessionId, workspaceKey) as
    Readonly<{ byte_length: number; chunk: Uint8Array }> | undefined;
  if (row === undefined) {
    throw new RepositoryReadError("not_found", "Repository resource was not found.");
  }
  return chunkResult(row, request, { sessionId, messageId }, context, "Message");
}

function readSessionDirectoriesChunk(
  database: DatabaseSync,
  payload: Readonly<Record<string, unknown>>,
  context: OperationExecutionContext,
): OperationResult {
  const request = readChunkRequest(payload, ["sessionId"], "Session directories");
  const { sessionId } = request.scope;
  const row = database
    .prepare(
      `
    SELECT length(CAST(allowed_additional_directories_json AS BLOB)) AS byte_length,
           substr(CAST(allowed_additional_directories_json AS BLOB), ? + 1, ?) AS chunk
    FROM sessions WHERE id = ?
  `,
    )
    .get(request.offset, request.maxBytes, sessionId) as
    Readonly<{ byte_length: number; chunk: Uint8Array }> | undefined;
  if (row === undefined) {
    throw new RepositoryReadError("not_found", "Repository resource was not found.");
  }
  return chunkResult(row, request, { sessionId }, context, "Session directories");
}

function readRunSnapshotChunk(
  database: DatabaseSync,
  payload: Readonly<Record<string, unknown>>,
  context: OperationExecutionContext,
): OperationResult {
  const request = readChunkRequest(payload, ["sessionId", "runId", "workspaceKey"], "Run snapshot");
  const { sessionId, runId, workspaceKey } = request.scope;
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
  return chunkResult(row, request, { sessionId, runId }, context, "Run snapshot");
}

function readChunkRequest<const TScopeKey extends string>(
  payload: Readonly<Record<string, unknown>>,
  scopeKeys: readonly TScopeKey[],
  label: string,
): ChunkRequest<TScopeKey> {
  const expectedKeys = [...scopeKeys, "offset", "maxBytes"].sort();
  if (Object.keys(payload).sort().join(",") !== expectedKeys.join(",")) {
    throw new PayloadChunkError("payload_chunk_invalid", `${label} chunk request is invalid.`);
  }
  if (scopeKeys.some((key) => !isChunkScopeString(payload[key]))) {
    throw new PayloadChunkError("payload_chunk_invalid", `${label} chunk request scope is invalid.`);
  }
  const offset = payload.offset;
  const maxBytes = payload.maxBytes;
  if (
    !Number.isSafeInteger(offset) ||
    (offset as number) < 0 ||
    !Number.isSafeInteger(maxBytes) ||
    (maxBytes as number) < 1
  ) {
    throw new PayloadChunkError("payload_chunk_invalid", `${label} chunk request is invalid.`);
  }
  if ((maxBytes as number) > REPOSITORY_CHUNK_LIMITS.maxRequestedBytes) {
    throw new PayloadChunkError("payload_chunk_too_large", `${label} chunk exceeds the maximum size.`);
  }
  return {
    scope: Object.fromEntries(scopeKeys.map((key) => [key, payload[key] as string])) as Record<TScopeKey, string>,
    offset: offset as number,
    maxBytes: maxBytes as number,
  };
}

function isChunkScopeString(value: unknown): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= REPOSITORY_CHUNK_LIMITS.maxScopeStringLength;
}

function chunkResult(
  row: Readonly<{ byte_length: number; chunk: Uint8Array }> | undefined,
  request: Readonly<{ offset: number }>,
  scope: Readonly<Record<string, string>>,
  context: OperationExecutionContext,
  label: string,
): OperationResult {
  if (
    row === undefined ||
    !Number.isSafeInteger(row.byte_length) ||
    row.byte_length < 0 ||
    !(row.chunk instanceof Uint8Array)
  ) {
    throw new PayloadChunkError("payload_chunk_invalid", `${label} does not exist.`);
  }
  const requestedChunk = Uint8Array.from(row.chunk);
  const transferBudget = chunkTransferBudget(context, scope, request.offset, row.byte_length);
  if (transferBudget < 1) throw new ResponseLimitError("Persistence chunk metadata exceeds the response limit.");
  const returnedChunk =
    requestedChunk.byteLength <= transferBudget ? requestedChunk : requestedChunk.slice(0, transferBudget);
  const bytes = returnedChunk.buffer;
  return {
    result: {
      ...scope,
      offset: request.offset,
      totalBytes: row.byte_length,
      eof: request.offset + returnedChunk.byteLength >= row.byte_length,
      bytes,
    },
    transferList: [bytes],
  };
}

function chunkTransferBudget(
  context: OperationExecutionContext,
  scope: Readonly<Record<string, string>>,
  offset: number,
  totalBytes: number,
): number {
  const response = {
    protocolVersion: PERSISTENCE_PROTOCOL_VERSION,
    generationId: context.generationId,
    kind: "response",
    requestId: context.requestId,
    ok: true,
    result: { ...scope, offset, totalBytes, eof: false, bytes: null },
  };
  return MAX_PERSISTENCE_RESPONSE_BYTES - serializedResponseBytes(response);
}

function assertResponseWithinLimit(result: unknown, transferList: readonly ArrayBuffer[] | undefined): void {
  const transferredBytes = transferList?.reduce((total, buffer) => total + buffer.byteLength, 0) ?? 0;
  const jsonBytes = serializedResponseBytes(result);
  if (transferredBytes + jsonBytes > MAX_PERSISTENCE_RESPONSE_BYTES) {
    throw new ResponseLimitError("Persistence response exceeds the maximum size.");
  }
}

function serializedResponseBytes(result: unknown): number {
  return Buffer.byteLength(
    JSON.stringify(result, (_key, value: unknown) => (value instanceof ArrayBuffer ? null : value)),
  );
}

type ChunkRequest<TScopeKey extends string> = Readonly<{
  scope: Readonly<Record<TScopeKey, string>>;
  offset: number;
  maxBytes: number;
}>;

class ResponseLimitError extends Error {}

class PayloadChunkError extends Error {
  constructor(
    readonly code: "payload_chunk_invalid" | "payload_chunk_too_large",
    message: string,
  ) {
    super(message);
  }
}
