import path from "node:path";
import { Buffer } from "node:buffer";

import {
  CodexTransportError,
  CodexWireWriteError,
  connectionFailure,
  requestNotSent,
  responseUnknown,
  type CodexConnectionFailureCode,
} from "./transport-error.js";
import { CODEX_TRANSPORT_LIMITS, validateCodexTransportLimits, type CodexTransportLimits } from "./transport-limits.js";
import { MAX_NODE_TIMER_DELAY_MS, isValidNodeTimerDelay } from "./timer-duration.js";
import type {
  CodexRequestId,
  CodexW3cTraceContext,
  CodexWireEnvelope,
  CodexWireError,
  CodexWireServerRequest,
} from "./wire-envelope.js";

export type CodexProtocolSessionState = "idle" | "initializing" | "ready" | "closing" | "closed" | "failed";

export type CodexClientInfo = Readonly<{
  name: string;
  version: string;
  title?: string;
}>;

export type CodexConnectionInfo = Readonly<{
  platformFamily: string;
  platformOs: string;
  userAgent: string;
}>;

export type CodexRequestOptions = Readonly<{
  timeoutMs?: number;
  signal?: AbortSignal;
}>;

export type CodexStartOptions = Readonly<{
  timeoutMs?: number;
  signal?: AbortSignal;
}>;

export type CodexProtocolAnomalyCode = "duplicate_or_late_response_id" | "unknown_response_id";

declare const CODEX_SERVER_REQUEST_IDENTITY: unique symbol;
export type CodexServerRequestIdentity = Readonly<{
  readonly [CODEX_SERVER_REQUEST_IDENTITY]: true;
}>;

export type CodexServerRequestResolution =
  | Readonly<{ kind: "current"; identity: CodexServerRequestIdentity }>
  | Readonly<{ kind: "duplicate" }>
  | Readonly<{ kind: "invalid" }>;

export type CodexProtocolEvent =
  | Readonly<{ kind: "notification"; method: string; params?: unknown }>
  | Readonly<{ kind: "serverRequest"; request: CodexServerRequest }>
  | Readonly<{ kind: "protocolAnomaly"; code: CodexProtocolAnomalyCode; responseIdType: "number" | "string" }>;

export type CodexClientWireMessage =
  | Readonly<{ id: number; method: string; params?: unknown }>
  | Readonly<{ method: string; params?: unknown }>
  | Readonly<{ id: CodexRequestId; result: unknown; jsonrpc?: "2.0" }>
  | Readonly<{ id: CodexRequestId; error: CodexWireError; jsonrpc?: "2.0" }>;

export interface CodexWireWriter {
  write(message: CodexClientWireMessage, onWriteStarted: () => void): Promise<void>;
  cancelBeforeSend?(message: CodexClientWireMessage): boolean;
}

export type CodexProtocolSessionOptions = Readonly<{
  clientInfo: CodexClientInfo;
  writer: CodexWireWriter;
  limits?: CodexTransportLimits;
  defaultRequestTimeoutMs?: number;
}>;

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
  removeAbortListener: (() => void) | undefined;
  cancelBeforeSend: () => boolean;
  writeStarted: boolean;
};

type EventWaiter = {
  resolve: (event: CodexProtocolEvent) => void;
  reject: (error: unknown) => void;
};

type SeenServerRequest = {
  readonly identity: CodexServerRequestIdentity;
  resolutionSeen: boolean;
};

type QueuedProtocolEvent = Readonly<{
  event: CodexProtocolEvent;
  wireBytes: number;
}>;

export class CodexServerRequest {
  readonly #identity = createServerRequestIdentity();
  #state: "pending" | "writing" | "settled" = "pending";
  #valid = true;
  params: unknown;
  trace: CodexW3cTraceContext | null | undefined;

  constructor(
    readonly method: string,
    params: unknown,
    trace: CodexW3cTraceContext | null | undefined,
    private readonly settle: (
      message: Readonly<{ result: unknown }> | Readonly<{ error: CodexWireError }>,
    ) => Promise<void>,
  ) {
    this.params = params;
    this.trace = trace;
  }

  get identity(): CodexServerRequestIdentity {
    return this.#identity;
  }

  respond(result: unknown): Promise<void> {
    return this.#use({ result });
  }

  respondError(error: CodexWireError): Promise<void> {
    if (!isWireError(error)) return Promise.reject(requestNotSent("invalid_request"));
    return this.#use({
      error: {
        code: error.code,
        message: error.message,
        ...(Object.prototype.hasOwnProperty.call(error, "data") ? { data: error.data } : {}),
      },
    });
  }

  releasePayload(): void {
    this.params = undefined;
    this.trace = undefined;
  }

  invalidate(): void {
    this.releasePayload();
    this.#valid = false;
    this.#state = "settled";
  }

  async #use(message: Readonly<{ result: unknown }> | Readonly<{ error: CodexWireError }>): Promise<void> {
    if (this.#state !== "pending" || !this.#valid) {
      throw requestNotSent("server_request_settled");
    }
    this.#state = "writing";
    try {
      await this.settle(message);
      this.#state = "settled";
    } catch (error) {
      this.#state = this.#valid && isRetryableServerResponseFailure(error) ? "pending" : "settled";
      throw error;
    }
  }
}

export class CodexProtocolSession {
  readonly #pending = new Map<number, PendingRequest>();
  readonly #retiredUnsentRequestIds = new Set<number>();
  readonly #events: QueuedProtocolEvent[] = [];
  readonly #serverRequests = new Map<CodexServerRequestIdentity, CodexServerRequest>();
  readonly #seenServerRequests = new Map<string, SeenServerRequest>();
  readonly #limits: CodexTransportLimits;
  readonly #defaultRequestTimeoutMs: number;
  readonly #clientInfo: CodexClientInfo;
  #writer: CodexWireWriter | undefined;
  #state: CodexProtocolSessionState = "idle";
  #nextRequestId = 1;
  #startPromise: Promise<CodexConnectionInfo> | undefined;
  #connectionInfo: CodexConnectionInfo | undefined;
  #eventWaiter: EventWaiter | undefined;
  #terminalError: CodexTransportError | undefined;
  #seenServerRequestIdBytes = 0;
  #queuedEventBytes = 0;

  constructor(options: CodexProtocolSessionOptions) {
    this.#limits = validateCodexTransportLimits(options.limits ?? CODEX_TRANSPORT_LIMITS);
    this.#defaultRequestTimeoutMs = validateTimeout(options.defaultRequestTimeoutMs ?? 30_000);
    this.#clientInfo = snapshotCodexClientInfo(options.clientInfo);
    this.#writer = options.writer;
  }

  get state(): CodexProtocolSessionState {
    return this.#state;
  }

  get connectionInfo(): CodexConnectionInfo | undefined {
    return this.#connectionInfo;
  }

  get pendingRequestCount(): number {
    return this.#pending.size;
  }

  get queuedEventCount(): number {
    return this.#events.length;
  }

  get queuedEventBytes(): number {
    return this.#queuedEventBytes;
  }

  get outstandingServerRequestCount(): number {
    return this.#serverRequests.size;
  }

  get seenServerRequestCount(): number {
    return this.#seenServerRequests.size;
  }

  get seenServerRequestIdBytes(): number {
    return this.#seenServerRequestIdBytes;
  }

  start(options: CodexStartOptions = {}): Promise<CodexConnectionInfo> {
    if (this.#startPromise !== undefined) return this.#startPromise;
    if (this.#state !== "idle") return Promise.reject(requestNotSent("not_ready"));
    this.#state = "initializing";
    this.#startPromise = this.#performHandshake(options);
    return this.#startPromise;
  }

  request<TResult>(method: string, params?: unknown, options: CodexRequestOptions = {}): Promise<TResult> {
    if (this.#state !== "ready") {
      return Promise.reject(requestNotSent(this.#state === "closing" ? "closing" : "not_ready"));
    }
    return this.#request<TResult>(method, params, options);
  }

  accept(envelope: CodexWireEnvelope, wireBytes: number = encodedEnvelopeBytes(envelope)): void {
    if (this.#state === "failed" || this.#state === "closed" || this.#state === "closing") return;
    if (!Number.isSafeInteger(wireBytes) || wireBytes < 1 || wireBytes > this.#limits.maxLineBytes) {
      this.#failConnection(connectionFailure("protocol_failed"));
      return;
    }
    switch (envelope.kind) {
      case "response":
      case "errorResponse":
        this.#acceptResponse(envelope, wireBytes);
        return;
      case "notification":
        this.#enqueueEvent(
          {
            kind: "notification",
            method: envelope.method,
            ...(Object.prototype.hasOwnProperty.call(envelope, "params") ? { params: envelope.params } : {}),
          },
          wireBytes,
        );
        return;
      case "serverRequest":
        this.#acceptServerRequest(envelope, wireBytes);
    }
  }

  nextEvent(): Promise<CodexProtocolEvent> {
    const queued = this.#events.shift();
    if (queued !== undefined) {
      this.#queuedEventBytes -= queued.wireBytes;
      return Promise.resolve(queued.event);
    }
    if (this.#terminalError !== undefined) return Promise.reject(this.#terminalError);
    if (this.#eventWaiter !== undefined) return Promise.reject(requestNotSent("event_waiter_exists"));
    return new Promise<CodexProtocolEvent>((resolve, reject) => {
      this.#eventWaiter = { resolve, reject };
    });
  }

  observeServerRequestResolution(requestId: unknown): CodexServerRequestResolution {
    if (!isRequestId(requestId)) return Object.freeze({ kind: "invalid" });
    const seen = this.#seenServerRequests.get(requestKey(requestId));
    if (seen === undefined) return Object.freeze({ kind: "invalid" });
    if (seen.resolutionSeen) return Object.freeze({ kind: "duplicate" });
    seen.resolutionSeen = true;
    return Object.freeze({ kind: "current", identity: seen.identity });
  }

  fail(code: CodexConnectionFailureCode): void {
    this.#failConnection(connectionFailure(code));
  }

  prepareClose(): void {
    if (this.#state === "closing" || this.#state === "closed" || this.#state === "failed") return;
    this.#state = "closing";
    this.#terminalError = requestNotSent("closing");
    for (const request of this.#serverRequests.values()) request.invalidate();
    this.#serverRequests.clear();
    this.#seenServerRequests.clear();
    this.#retiredUnsentRequestIds.clear();
    this.#seenServerRequestIdBytes = 0;
    const waiter = this.#eventWaiter;
    this.#eventWaiter = undefined;
    waiter?.reject(this.#terminalError);
  }

  beginClose(): void {
    if (this.#state === "closed" || this.#state === "failed") return;
    this.prepareClose();
    this.#rejectPendingForConnectionLoss();
  }

  completeClose(): void {
    if (this.#state !== "closing") return;
    this.#state = "closed";
    this.#terminalError = requestNotSent("not_ready");
  }

  releaseTransportResources(): void {
    this.#writer = undefined;
    if (this.#state === "closing" || this.#state === "closed") this.discardQueuedEvents();
  }

  discardQueuedEvents(): void {
    this.#events.length = 0;
    this.#queuedEventBytes = 0;
  }

  async #performHandshake(options: CodexStartOptions): Promise<CodexConnectionInfo> {
    const timeoutMs = validateRequestTimeout(options.timeoutMs ?? this.#defaultRequestTimeoutMs);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    try {
      if (timeoutMs instanceof CodexTransportError) throw timeoutMs;
      if (options.signal?.aborted) throw requestNotSent("aborted");
      const deadline = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(responseUnknown("timeout")), timeoutMs);
        timer.unref?.();
        if (options.signal !== undefined) {
          onAbort = () => reject(responseUnknown("aborted"));
          options.signal.addEventListener("abort", onAbort, { once: true });
        }
      });
      return await Promise.race([this.#performHandshakeSequence(timeoutMs, options.signal), deadline]);
    } catch (error) {
      const failure = normalizeHandshakeFailure(error);
      if (this.#state !== "closing") this.#failConnection(failure);
      throw failure;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      if (onAbort !== undefined) options.signal?.removeEventListener("abort", onAbort);
    }
  }

  async #performHandshakeSequence(timeoutMs: number, signal: AbortSignal | undefined): Promise<CodexConnectionInfo> {
    const result = await this.#request<unknown>(
      "initialize",
      {
        clientInfo: this.#clientInfo,
        capabilities: {
          experimentalApi: true,
          mcpServerOpenaiFormElicitation: true,
        },
      },
      { timeoutMs, ...(signal === undefined ? {} : { signal }) },
    );
    const connectionInfo = decodeConnectionInfo(result);
    if (this.#state !== "initializing") throw this.#terminalError ?? connectionFailure("handshake_write_failed");
    try {
      await this.#write({ method: "initialized", params: {} });
    } catch {
      throw connectionFailure("handshake_write_failed");
    }
    if (this.#state !== "initializing") throw this.#terminalError ?? connectionFailure("handshake_write_failed");
    this.#connectionInfo = connectionInfo;
    this.#state = "ready";
    return connectionInfo;
  }

  #request<TResult>(method: string, params: unknown, options: CodexRequestOptions): Promise<TResult> {
    if (typeof method !== "string" || method.length === 0) return Promise.reject(requestNotSent("invalid_request"));
    const timeoutMs = validateRequestTimeout(options.timeoutMs ?? this.#defaultRequestTimeoutMs);
    if (timeoutMs instanceof CodexTransportError) return Promise.reject(timeoutMs);
    if (options.signal?.aborted) return Promise.reject(requestNotSent("aborted"));
    if (this.#pending.size >= this.#limits.maxPendingRequests) {
      return Promise.reject(requestNotSent("pending_limit"));
    }
    if (!Number.isSafeInteger(this.#nextRequestId)) return Promise.reject(requestNotSent("invalid_request"));

    const requestId = this.#nextRequestId;
    this.#nextRequestId += 1;
    const message: CodexClientWireMessage = {
      id: requestId,
      method,
      ...(params === undefined ? {} : { params }),
    };

    return new Promise<TResult>((resolve, reject) => {
      const pending: PendingRequest = {
        resolve: resolve as (value: unknown) => void,
        reject,
        timer: setTimeout(() => this.#expirePending(requestId, "timeout"), timeoutMs),
        removeAbortListener: undefined,
        cancelBeforeSend: () => this.#writer?.cancelBeforeSend?.(message) ?? false,
        writeStarted: false,
      };
      pending.timer.unref?.();
      if (options.signal !== undefined) {
        const onAbort = () => this.#expirePending(requestId, "aborted");
        options.signal.addEventListener("abort", onAbort, { once: true });
        pending.removeAbortListener = () => options.signal?.removeEventListener("abort", onAbort);
      }
      this.#pending.set(requestId, pending);
      try {
        void this.#write(message, () => {
          const current = this.#pending.get(requestId);
          if (current !== undefined) current.writeStarted = true;
        }).catch((error: unknown) => this.#handleRequestWriteFailure(requestId, error));
      } catch (error) {
        this.#handleRequestWriteFailure(requestId, error);
      }
    });
  }

  #acceptResponse(
    envelope: Extract<CodexWireEnvelope, { kind: "response" | "errorResponse" }>,
    wireBytes: number,
  ): void {
    const requestId = envelope.id;
    const pending = typeof requestId === "number" ? this.#pending.get(requestId) : undefined;
    if (pending === undefined) {
      if (typeof requestId === "number" && this.#retiredUnsentRequestIds.has(requestId)) {
        this.#failConnection(connectionFailure("protocol_failed"));
        return;
      }
      this.#enqueueEvent(
        {
          kind: "protocolAnomaly",
          code:
            typeof requestId === "number" && requestId >= 1 && requestId < this.#nextRequestId
              ? "duplicate_or_late_response_id"
              : "unknown_response_id",
          responseIdType: typeof requestId === "number" ? "number" : "string",
        },
        wireBytes,
      );
      return;
    }
    if (!pending.writeStarted) {
      this.#failConnection(connectionFailure("protocol_failed"));
      return;
    }

    this.#pending.delete(requestId as number);
    cleanupPending(pending);
    if (envelope.kind === "response") {
      pending.resolve(envelope.result);
    } else {
      pending.reject(new CodexTransportError({ kind: "remote_error", code: envelope.error.code }));
    }
  }

  #acceptServerRequest(envelope: CodexWireServerRequest, wireBytes: number): void {
    const key = requestKey(envelope.id);
    if (this.#seenServerRequests.has(key)) {
      this.#failConnection(connectionFailure("duplicate_server_request"));
      return;
    }
    const requestIdBytes = serverRequestIdBytes(envelope.id);
    if (
      this.#seenServerRequests.size >= this.#limits.maxPendingRequests ||
      this.#seenServerRequestIdBytes + requestIdBytes > this.#limits.maxOutstandingServerRequestIdBytes
    ) {
      this.#failConnection(connectionFailure("server_request_limit"));
      return;
    }

    const requestId = envelope.id;
    const jsonrpc = envelope.jsonrpc;
    let request: CodexServerRequest;
    request = new CodexServerRequest(envelope.method, envelope.params, envelope.trace, async (response) => {
      if (this.#serverRequests.get(request.identity) !== request) throw requestNotSent("server_request_settled");
      if (this.#state === "failed" || this.#state === "closed" || this.#state === "closing") {
        throw requestNotSent(this.#state === "closing" ? "closing" : "not_ready");
      }
      const message: CodexClientWireMessage =
        "result" in response
          ? {
              id: requestId,
              result: response.result,
              ...(jsonrpc === undefined ? {} : { jsonrpc }),
            }
          : {
              id: requestId,
              error: response.error,
              ...(jsonrpc === undefined ? {} : { jsonrpc }),
            };
      try {
        await this.#write(message);
      } catch (error) {
        const failure = mapWriteFailure(error);
        if (isUnknownWriteFailure(failure)) this.#failConnection(connectionFailure("stdin_failed"));
        throw failure;
      }
      this.#serverRequests.delete(request.identity);
    });
    this.#seenServerRequests.set(key, { identity: request.identity, resolutionSeen: false });
    this.#seenServerRequestIdBytes += requestIdBytes;
    this.#serverRequests.set(request.identity, request);
    this.#enqueueEvent({ kind: "serverRequest", request }, wireBytes);
  }

  #enqueueEvent(event: CodexProtocolEvent, wireBytes: number): void {
    if (this.#state === "failed" || this.#state === "closed") return;
    const waiter = this.#eventWaiter;
    if (waiter !== undefined) {
      this.#eventWaiter = undefined;
      waiter.resolve(event);
      return;
    }
    if (
      this.#events.length >= this.#limits.maxQueuedEvents ||
      this.#queuedEventBytes + wireBytes > this.#limits.maxQueuedEventBytes
    ) {
      this.#failConnection(connectionFailure("event_queue_overflow"));
      return;
    }
    this.#events.push({ event, wireBytes });
    this.#queuedEventBytes += wireBytes;
  }

  #write(message: CodexClientWireMessage, onWriteStarted: () => void = () => undefined): Promise<void> {
    const writer = this.#writer;
    return writer === undefined
      ? Promise.reject(new CodexWireWriteError({ outcome: "not_sent", code: "stream_unavailable" }))
      : writer.write(message, onWriteStarted);
  }

  #rejectPending(requestId: number, error: CodexTransportError): void {
    const pending = this.#pending.get(requestId);
    if (pending === undefined) return;
    this.#pending.delete(requestId);
    cleanupPending(pending);
    pending.reject(error);
  }

  #expirePending(requestId: number, code: "timeout" | "aborted"): void {
    const pending = this.#pending.get(requestId);
    if (pending === undefined) return;
    if (pending.cancelBeforeSend()) {
      this.#rejectPending(requestId, requestNotSent(code));
      this.#retireUnsentRequestId(requestId);
      return;
    }
    this.#rejectPending(requestId, responseUnknown(code));
  }

  #handleRequestWriteFailure(requestId: number, error: unknown): void {
    const failure = mapWriteFailure(error);
    this.#rejectPending(requestId, failure);
    if (this.#state === "closing" || this.#state === "closed") return;
    if (failure.failure.kind === "request_not_sent") this.#retireUnsentRequestId(requestId);
    if (isUnknownWriteFailure(failure)) this.#failConnection(connectionFailure("stdin_failed"));
  }

  #retireUnsentRequestId(requestId: number): void {
    if (this.#state === "failed" || this.#state === "closed" || this.#state === "closing") return;
    if (this.#retiredUnsentRequestIds.has(requestId)) return;
    if (this.#retiredUnsentRequestIds.size >= this.#limits.maxRetiredUnsentRequestIds) {
      this.#failConnection(connectionFailure("protocol_failed"));
      return;
    }
    this.#retiredUnsentRequestIds.add(requestId);
  }

  #rejectPendingForConnectionLoss(): void {
    for (const [requestId, pending] of [...this.#pending]) {
      const error =
        !pending.writeStarted && pending.cancelBeforeSend()
          ? requestNotSent("write_rejected")
          : responseUnknown("connection_lost");
      this.#rejectPending(requestId, error);
    }
  }

  #failConnection(error: CodexTransportError): void {
    if (this.#state === "failed" || this.#state === "closed") return;
    this.#state = "failed";
    this.#terminalError = error;
    this.#rejectPendingForConnectionLoss();
    this.#retiredUnsentRequestIds.clear();
    for (const request of this.#serverRequests.values()) request.invalidate();
    this.#serverRequests.clear();
    this.#seenServerRequests.clear();
    this.#seenServerRequestIdBytes = 0;
    const waiter = this.#eventWaiter;
    this.#eventWaiter = undefined;
    waiter?.reject(error);
  }
}

function encodedEnvelopeBytes(envelope: CodexWireEnvelope): number {
  try {
    const encoded = JSON.stringify(envelope);
    return typeof encoded === "string" ? Buffer.byteLength(encoded, "utf8") : Number.NaN;
  } catch {
    return Number.NaN;
  }
}

function decodeConnectionInfo(value: unknown): CodexConnectionInfo {
  if (
    !isPlainObject(value) ||
    typeof value.codexHome !== "string" ||
    !path.isAbsolute(value.codexHome) ||
    !isNonEmptyString(value.platformFamily) ||
    !isNonEmptyString(value.platformOs) ||
    !isNonEmptyString(value.userAgent)
  ) {
    throw connectionFailure("handshake_invalid");
  }
  return {
    platformFamily: value.platformFamily,
    platformOs: value.platformOs,
    userAgent: value.userAgent,
  };
}

function normalizeHandshakeFailure(error: unknown): CodexTransportError {
  if (error instanceof CodexTransportError) return error;
  if (error instanceof CodexWireWriteError) return connectionFailure("handshake_write_failed");
  return connectionFailure("handshake_invalid");
}

function mapWriteFailure(error: unknown): CodexTransportError {
  if (error instanceof CodexWireWriteError) {
    return error.failure.outcome === "not_sent" ? requestNotSent("write_rejected") : responseUnknown("write_failed");
  }
  return responseUnknown("write_failed");
}

function isUnknownWriteFailure(error: CodexTransportError): boolean {
  return error.failure.kind === "response_unknown" && error.failure.code === "write_failed";
}

function isRetryableServerResponseFailure(error: unknown): boolean {
  return (
    error instanceof CodexTransportError &&
    error.failure.kind === "request_not_sent" &&
    error.failure.code === "write_rejected"
  );
}

function cleanupPending(pending: PendingRequest): void {
  clearTimeout(pending.timer);
  pending.removeAbortListener?.();
}

function validateRequestTimeout(value: number): number | CodexTransportError {
  return isValidNodeTimerDelay(value) ? value : requestNotSent("invalid_request");
}

function validateTimeout(value: number): number {
  if (!isValidNodeTimerDelay(value)) {
    throw new RangeError(`timeout must be between 1 and ${MAX_NODE_TIMER_DELAY_MS}`);
  }
  return value;
}

export function snapshotCodexClientInfo(value: CodexClientInfo): CodexClientInfo {
  if (!isPlainObject(value) || !isNonEmptyString(value.name) || !isNonEmptyString(value.version)) {
    throw new TypeError("Codex clientInfo name and version are required.");
  }
  if (value.title !== undefined && !isNonEmptyString(value.title)) {
    throw new TypeError("Codex clientInfo title must be non-empty when provided.");
  }
  return Object.freeze({
    name: value.name,
    version: value.version,
    ...(value.title === undefined ? {} : { title: value.title }),
  });
}

function isWireError(value: unknown): value is CodexWireError {
  return (
    isPlainObject(value) &&
    Object.keys(value).every((key) => key === "code" || key === "message" || key === "data") &&
    Number.isSafeInteger(value.code) &&
    typeof value.message === "string"
  );
}

function requestKey(id: CodexRequestId): string {
  return `${typeof id}:${String(id)}`;
}

function serverRequestIdBytes(id: CodexRequestId): number {
  return Buffer.byteLength(String(id), "utf8");
}

function isRequestId(value: unknown): value is CodexRequestId {
  return typeof value === "string" || (typeof value === "number" && Number.isSafeInteger(value));
}

function createServerRequestIdentity(): CodexServerRequestIdentity {
  return Object.freeze(Object.create(null)) as CodexServerRequestIdentity;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}
