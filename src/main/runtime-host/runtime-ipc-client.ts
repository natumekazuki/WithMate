import { randomUUID } from "node:crypto";

import {
  decodeRuntimeIpcEnvelope,
  deriveRuntimeRequestId,
  encodeRuntimeIpcEnvelope,
  RUNTIME_IPC_CLIENT_SCOPED_OPERATIONS,
  RUNTIME_IPC_PROTOCOL_VERSION,
  snapshotRuntimeOperationPayload,
  type RuntimeIpcEnvelope,
  type RuntimeIpcFailure,
  type RuntimeIpcOperation,
  type RuntimeIpcOperationPayload,
  type RuntimeIpcResponse,
} from "./runtime-ipc-contract.js";
import { RUNTIME_IPC_LIMITS, RuntimeIpcProtocolError } from "./runtime-ipc-common.js";
import {
  connectRuntimeEndpoint,
  RuntimeEndpointUnavailableError,
  type RuntimeEndpointConnection,
} from "./runtime-endpoint.js";
import { RuntimeIpcJsonlDecoder } from "./runtime-ipc-jsonl.js";
import { decodeRuntimeWireValue } from "./runtime-ipc-value.js";
import type { RuntimeOwnerIdentity } from "./runtime-owner-identity.js";

export type RuntimeIpcClientControl = Readonly<{ timeoutMs?: number; signal?: AbortSignal }>;

export class RuntimeIpcClientError extends Error {
  constructor(
    readonly code:
      | "connection_closed"
      | "handshake_rejected"
      | "protocol_failure"
      | "request_canceled"
      | "request_timeout"
      | "resource_exhausted",
    readonly execution: "not_started" | "started" | "unknown",
    readonly retryable: boolean,
  ) {
    super(runtimeClientErrorMessage(code));
    this.name = "RuntimeIpcClientError";
  }
}

export class RuntimeIpcRemoteError extends Error {
  constructor(readonly failure: RuntimeIpcFailure) {
    super(failure.message);
    this.name = "RuntimeIpcRemoteError";
  }
}

export type ConnectRuntimeIpcClientOptions = Readonly<{
  timeoutMs: number;
  signal?: AbortSignal;
  connect?: typeof connectRuntimeEndpoint;
}>;

type PendingRequest = {
  operation: RuntimeIpcOperation;
  requestId: string;
  requestSequence: number;
  state: "queued" | "sent" | "settled";
  resolve(value: unknown): void;
  reject(error: unknown): void;
  timer?: ReturnType<typeof setTimeout>;
  signal?: AbortSignal;
  onAbort?: () => void;
};

export class RuntimeIpcClient {
  readonly clientId: string;
  readonly hostGenerationId: string;
  readonly #connection: RuntimeEndpointConnection;
  readonly #decoder = new RuntimeIpcJsonlDecoder();
  readonly #readAbort = new AbortController();
  readonly #pending = new Map<string, PendingRequest>();
  readonly #retiredRequestIds = new Set<string>();
  #requestSequence = 0;
  #writeTail: Promise<void> = Promise.resolve();
  #readerTask: Promise<void>;
  #closePromise: Promise<void> | undefined;
  #closed = false;

  private constructor(connection: RuntimeEndpointConnection, clientId: string, hostGenerationId: string) {
    this.#connection = connection;
    this.clientId = clientId;
    this.hostGenerationId = hostGenerationId;
    this.#readerTask = this.#readResponses();
  }

  static async connect(
    identity: RuntimeOwnerIdentity,
    options: ConnectRuntimeIpcClientOptions,
  ): Promise<RuntimeIpcClient> {
    const timeoutMs = positiveTimeout(options.timeoutMs);
    const deadlineAt = Date.now() + timeoutMs;
    const connect = options.connect ?? connectRuntimeEndpoint;
    const connection = await connect(identity, {
      timeoutMs: remainingTimeout(deadlineAt),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    try {
      const clientId = randomUUID();
      await runControlled(
        connection.write(
          Buffer.from(
            encodeRuntimeIpcEnvelope({
              protocolVersion: RUNTIME_IPC_PROTOCOL_VERSION,
              kind: "handshake_request",
              clientId,
            }),
          ),
        ),
        deadlineAt,
        options.signal,
        "handshake",
      );
      const response = await readHandshake(connection, deadlineAt, options.signal);
      if (response.kind === "handshake_rejection") {
        throw new RuntimeIpcClientError(
          "handshake_rejected",
          "not_started",
          response.error.code === "resource_exhausted",
        );
      }
      if (
        response.kind !== "handshake_response" ||
        response.clientId !== clientId ||
        response.protocolVersion !== RUNTIME_IPC_PROTOCOL_VERSION
      ) {
        throw new RuntimeIpcClientError("protocol_failure", "not_started", false);
      }
      return new RuntimeIpcClient(connection, clientId, response.hostGenerationId);
    } catch (error) {
      await connection.close().catch(() => undefined);
      throw normalizeHandshakeFailure(error);
    }
  }

  request(
    operation: RuntimeIpcOperation,
    payload: RuntimeIpcOperationPayload,
    control: RuntimeIpcClientControl = {},
  ): Promise<unknown> {
    if (this.#closed) {
      return Promise.reject(new RuntimeIpcClientError("connection_closed", "not_started", true));
    }
    if (this.#pending.size >= RUNTIME_IPC_LIMITS.maxInFlightPerConnection) {
      return Promise.reject(new RuntimeIpcClientError("resource_exhausted", "not_started", true));
    }
    if (control.signal?.aborted) {
      return Promise.reject(new RuntimeIpcClientError("request_canceled", "not_started", false));
    }
    const timeoutMs = control.timeoutMs === undefined ? undefined : positiveTimeout(control.timeoutMs);
    const requestSequence = this.#requestSequence + 1;
    const requestId = deriveRuntimeRequestId(this.clientId, requestSequence);
    const envelope: RuntimeIpcEnvelope = {
      protocolVersion: RUNTIME_IPC_PROTOCOL_VERSION,
      kind: "request",
      hostGenerationId: this.hostGenerationId,
      clientId: this.clientId,
      requestId,
      requestSequence,
      operation,
      payload: snapshotRuntimeOperationPayload(operation, payload),
    };
    const bytes = Buffer.from(encodeRuntimeIpcEnvelope(envelope));
    this.#requestSequence = requestSequence;

    return new Promise<unknown>((resolve, reject) => {
      const pending: PendingRequest = {
        operation,
        requestId,
        requestSequence,
        state: "queued",
        resolve,
        reject,
        ...(control.signal === undefined ? {} : { signal: control.signal }),
      };
      const interrupt = (code: "request_canceled" | "request_timeout") => this.#interrupt(pending, code);
      if (timeoutMs !== undefined) {
        pending.timer = setTimeout(() => interrupt("request_timeout"), timeoutMs);
        pending.timer.unref();
      }
      if (control.signal !== undefined) {
        pending.onAbort = () => interrupt("request_canceled");
        control.signal.addEventListener("abort", pending.onAbort, { once: true });
      }
      this.#pending.set(requestId, pending);
      const write = this.#writeTail.then(async () => {
        if (pending.state !== "queued") return;
        pending.state = "sent";
        await this.#connection.write(bytes, this.#readAbort.signal);
      });
      this.#writeTail = write.catch(() => undefined);
      void write.catch((error: unknown) => this.#failConnection(error));
    });
  }

  close(): Promise<void> {
    this.#closePromise ??= this.#close();
    return this.#closePromise;
  }

  async #close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#readAbort.abort();
    this.#rejectAll(new RuntimeIpcClientError("connection_closed", "unknown", false));
    let closeError: unknown;
    try {
      await this.#connection.close();
    } catch (error) {
      closeError = error;
    }
    await this.#readerTask.catch(() => undefined);
    if (closeError !== undefined) throw closeError;
  }

  async #readResponses(): Promise<void> {
    try {
      while (!this.#closed) {
        const chunk = await this.#connection.read(this.#readAbort.signal);
        if (chunk === null) {
          this.#decoder.finish();
          throw new RuntimeIpcClientError("connection_closed", "unknown", false);
        }
        const envelopes: RuntimeIpcEnvelope[] = [];
        this.#decoder.push(chunk, (envelope) => envelopes.push(envelope));
        for (const envelope of envelopes) this.#acceptResponse(envelope);
      }
    } catch (error) {
      if (!this.#closed) this.#failConnection(error);
    }
  }

  #acceptResponse(envelope: RuntimeIpcEnvelope): void {
    if (
      envelope.kind !== "response" ||
      envelope.hostGenerationId !== this.hostGenerationId ||
      envelope.clientId !== this.clientId
    ) {
      this.#failConnection(new RuntimeIpcClientError("protocol_failure", "unknown", false));
      return;
    }
    const pending = this.#pending.get(envelope.requestId);
    if (pending === undefined) {
      if (this.#retiredRequestIds.has(envelope.requestId)) return;
      this.#failConnection(new RuntimeIpcClientError("protocol_failure", "unknown", false));
      return;
    }
    if (
      pending.requestSequence !== envelope.requestSequence ||
      pending.operation !== envelope.operation ||
      pending.state !== "sent"
    ) {
      this.#failConnection(new RuntimeIpcClientError("protocol_failure", "unknown", false));
      return;
    }
    this.#settle(pending);
    if (envelope.outcome === "failure") {
      pending.reject(new RuntimeIpcRemoteError(envelope.error));
      return;
    }
    try {
      pending.resolve(decodeRuntimeWireValue(envelope.value));
    } catch (error) {
      pending.reject(error);
      this.#failConnection(error);
    }
  }

  #interrupt(pending: PendingRequest, code: "request_canceled" | "request_timeout"): void {
    if (pending.state === "settled") return;
    const sent = pending.state === "sent";
    this.#settle(pending);
    pending.reject(new RuntimeIpcClientError(code, sent ? "started" : "not_started", code === "request_timeout"));
    if (sent && RUNTIME_IPC_CLIENT_SCOPED_OPERATIONS.has(pending.operation)) {
      const cancel: RuntimeIpcEnvelope = {
        protocolVersion: RUNTIME_IPC_PROTOCOL_VERSION,
        kind: "cancel",
        hostGenerationId: this.hostGenerationId,
        clientId: this.clientId,
        requestId: pending.requestId,
        requestSequence: pending.requestSequence,
      };
      const write = this.#writeTail.then(() =>
        this.#connection.write(Buffer.from(encodeRuntimeIpcEnvelope(cancel)), this.#readAbort.signal),
      );
      this.#writeTail = write.catch(() => undefined);
      void write.catch((error: unknown) => this.#failConnection(error));
    }
  }

  #settle(pending: PendingRequest): void {
    if (pending.state === "settled") return;
    pending.state = "settled";
    this.#pending.delete(pending.requestId);
    this.#retiredRequestIds.add(pending.requestId);
    if (pending.timer !== undefined) clearTimeout(pending.timer);
    if (pending.onAbort !== undefined) pending.signal?.removeEventListener("abort", pending.onAbort);
  }

  #failConnection(error: unknown): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#readAbort.abort();
    const failure =
      error instanceof RuntimeIpcClientError
        ? error
        : new RuntimeIpcClientError(
            error instanceof RuntimeIpcProtocolError ? "protocol_failure" : "connection_closed",
            "unknown",
            false,
          );
    this.#rejectAll(failure);
    void this.#connection.close().catch(() => undefined);
  }

  #rejectAll(error: RuntimeIpcClientError): void {
    for (const pending of [...this.#pending.values()]) {
      const execution = pending.state === "queued" ? "not_started" : error.execution;
      this.#settle(pending);
      pending.reject(new RuntimeIpcClientError(error.code, execution, error.retryable));
    }
  }
}

async function readHandshake(
  connection: RuntimeEndpointConnection,
  deadlineAt: number,
  signal: AbortSignal | undefined,
): Promise<RuntimeIpcEnvelope> {
  const decoder = new RuntimeIpcJsonlDecoder();
  while (true) {
    const chunk = await runControlled(connection.read(signal), deadlineAt, signal, "handshake");
    if (chunk === null) throw new RuntimeIpcClientError("connection_closed", "not_started", true);
    const envelopes: RuntimeIpcEnvelope[] = [];
    decoder.push(chunk, (envelope) => envelopes.push(envelope));
    if (envelopes.length !== 0) {
      if (envelopes.length !== 1 || decoder.hasPartialLine) {
        throw new RuntimeIpcClientError("protocol_failure", "not_started", false);
      }
      return envelopes[0] as RuntimeIpcEnvelope;
    }
  }
}

async function runControlled<TValue>(
  operation: Promise<TValue>,
  deadlineAt: number,
  signal: AbortSignal | undefined,
  stage: "handshake",
): Promise<TValue> {
  if (signal?.aborted) throw new RuntimeIpcClientError("request_canceled", "not_started", false);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const interrupted = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new RuntimeIpcClientError("request_timeout", "not_started", true)),
      remainingTimeout(deadlineAt),
    );
    timer.unref();
    if (signal !== undefined) {
      onAbort = () => reject(new RuntimeIpcClientError("request_canceled", "not_started", false));
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) onAbort();
    }
  });
  try {
    return await Promise.race([operation, interrupted]);
  } catch (error) {
    if (stage === "handshake" && error instanceof RuntimeEndpointUnavailableError) throw error;
    throw error;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (onAbort !== undefined) signal?.removeEventListener("abort", onAbort);
  }
}

function normalizeHandshakeFailure(error: unknown): unknown {
  if (error instanceof RuntimeIpcClientError || error instanceof RuntimeEndpointUnavailableError) return error;
  if (error instanceof RuntimeIpcProtocolError) {
    return new RuntimeIpcClientError("protocol_failure", "not_started", false);
  }
  return new RuntimeIpcClientError("connection_closed", "not_started", true);
}

function positiveTimeout(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new RangeError("Runtime IPC client timeout is invalid.");
  return value;
}

function remainingTimeout(deadlineAt: number): number {
  return Math.max(1, deadlineAt - Date.now());
}

function runtimeClientErrorMessage(code: RuntimeIpcClientError["code"]): string {
  switch (code) {
    case "connection_closed":
      return "Runtime IPC connection closed.";
    case "handshake_rejected":
      return "Runtime IPC handshake was rejected.";
    case "protocol_failure":
      return "Runtime IPC protocol validation failed.";
    case "request_canceled":
      return "Runtime IPC request was canceled.";
    case "request_timeout":
      return "Runtime IPC request timed out.";
    case "resource_exhausted":
      return "Runtime IPC client resource limit was reached.";
  }
}
