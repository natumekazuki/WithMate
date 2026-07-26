import { isCanonicalUuid } from "../../shared/persistence-runtime-protocol.js";
import { RUNTIME_IPC_LIMITS, RUNTIME_IPC_PROTOCOL_VERSION, RuntimeIpcProtocolError } from "./runtime-ipc-common.js";
import {
  decodeRuntimeIpcEnvelope,
  encodeRuntimeIpcEnvelope,
  RUNTIME_IPC_CLIENT_SCOPED_OPERATIONS,
  type RuntimeIpcCancel,
  type RuntimeIpcEnvelope,
  type RuntimeIpcFailure,
  type RuntimeIpcOperation,
  type RuntimeIpcRequest,
  type RuntimeIpcResponse,
} from "./runtime-ipc-contract.js";
import { RuntimeIpcJsonlDecoder } from "./runtime-ipc-jsonl.js";
import { dispatchRuntimeApplicationOperation } from "./runtime-application-dispatch.js";
import { snapshotRuntimeApplicationResponse } from "./runtime-application-response.js";
import {
  startRuntimeApplication,
  type OwnedRuntimeApplication,
  type RuntimeApplicationControl,
} from "../runtime-application.js";
import {
  createRuntimeEndpointListener,
  RuntimeEndpointUnavailableError,
  type RuntimeEndpointConnection,
  type RuntimeEndpointListener,
} from "./runtime-endpoint.js";
import { acquireRuntimeOwnerClaim, type RuntimeOwnerClaim } from "./runtime-owner-claim.js";
import {
  resolveRuntimeOwnerIdentity,
  type ResolveRuntimeOwnerIdentityOptions,
  type RuntimeOwnerIdentity,
} from "./runtime-owner-identity.js";

export class RuntimeHostAlreadyRunningError extends Error {
  constructor() {
    super("A runtime host already owns this application data root.");
    this.name = "RuntimeHostAlreadyRunningError";
  }
}

export type RuntimeHostShutdownResult = Readonly<{
  checkpoint: "completed" | "failed";
}>;

export type RuntimeHost = Readonly<{
  identity: RuntimeOwnerIdentity;
  generationId: string;
  closed: Promise<RuntimeHostShutdownResult>;
  close(control?: RuntimeApplicationControl): Promise<RuntimeHostShutdownResult>;
}>;

type AcquiredRuntimeOwnerClaim = Extract<RuntimeOwnerClaim, Readonly<{ status: "acquired" }>>;

export type RuntimeHostDependencies = Readonly<{
  resolveIdentity(options?: ResolveRuntimeOwnerIdentityOptions): Promise<RuntimeOwnerIdentity>;
  acquireClaim(identity: RuntimeOwnerIdentity): Promise<RuntimeOwnerClaim>;
  createListener(identity: RuntimeOwnerIdentity, claim: AcquiredRuntimeOwnerClaim): Promise<RuntimeEndpointListener>;
  startApplication(
    identity: RuntimeOwnerIdentity,
    control?: RuntimeApplicationControl,
  ): Promise<OwnedRuntimeApplication>;
}>;

export type StartRuntimeHostOptions = ResolveRuntimeOwnerIdentityOptions &
  RuntimeApplicationControl &
  Readonly<{
    dependencies?: RuntimeHostDependencies;
    handshakeTimeoutMs?: number;
    partialLineTimeoutMs?: number;
  }>;

const defaultDependencies: RuntimeHostDependencies = {
  resolveIdentity: resolveRuntimeOwnerIdentity,
  acquireClaim: acquireRuntimeOwnerClaim,
  createListener: createRuntimeEndpointListener,
  startApplication: startRuntimeApplication,
};

export async function startRuntimeHost(options: StartRuntimeHostOptions = {}): Promise<RuntimeHost> {
  const dependencies = options.dependencies ?? defaultDependencies;
  const applicationTimeoutMs =
    options.timeoutMs === undefined ? undefined : positiveTimeout(options.timeoutMs, options.timeoutMs);
  const timeouts = {
    handshakeTimeoutMs: positiveTimeout(options.handshakeTimeoutMs, RUNTIME_IPC_LIMITS.handshakeTimeoutMs),
    partialLineTimeoutMs: positiveTimeout(options.partialLineTimeoutMs, RUNTIME_IPC_LIMITS.partialLineTimeoutMs),
  };
  const identity = await dependencies.resolveIdentity(
    options.applicationDataRoot === undefined ? {} : { applicationDataRoot: options.applicationDataRoot },
  );
  const claim = await dependencies.acquireClaim(identity);
  if (claim.status === "busy") throw new RuntimeHostAlreadyRunningError();

  let listener: RuntimeEndpointListener | undefined;
  let application: OwnedRuntimeApplication | undefined;
  try {
    listener = await dependencies.createListener(identity, claim);
    application = await dependencies.startApplication(identity, {
      ...(applicationTimeoutMs === undefined ? {} : { timeoutMs: applicationTimeoutMs }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
  } catch (error) {
    const cleanupErrors: unknown[] = [];
    if (application !== undefined) {
      try {
        await application.shutdown();
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
    }
    if (listener !== undefined) {
      try {
        await listener.close();
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
    }
    try {
      await claim.release();
    } catch (cleanupError) {
      cleanupErrors.push(cleanupError);
    }
    if (cleanupErrors.length > 0) {
      throw new AggregateError([error, ...cleanupErrors], "Runtime host startup and cleanup both failed.");
    }
    throw error;
  }

  return createStartedRuntimeHost(identity, claim, listener, application, timeouts);
}

function createStartedRuntimeHost(
  identity: RuntimeOwnerIdentity,
  claim: AcquiredRuntimeOwnerClaim,
  listener: RuntimeEndpointListener,
  application: OwnedRuntimeApplication,
  timeouts: Readonly<{ handshakeTimeoutMs: number; partialLineTimeoutMs: number }>,
): RuntimeHost {
  const acceptController = new AbortController();
  const connections = new Set<RuntimeEndpointConnection>();
  const connectionTasks = new Set<Promise<void>>();
  const activeRequests = new Set<ActiveRequest>();
  const responseBudget = new HostResponseBudget();
  let stopping = false;
  let finalizationPromise: Promise<RuntimeHostShutdownResult> | undefined;
  let resolveClosed!: (result: RuntimeHostShutdownResult) => void;
  let rejectClosed!: (error: unknown) => void;
  const closed = new Promise<RuntimeHostShutdownResult>((resolve, reject) => {
    resolveClosed = resolve;
    rejectClosed = reject;
  });
  void closed.catch(() => undefined);
  const beginClose = () => {
    if (finalizationPromise === undefined) {
      stopping = true;
      acceptController.abort();
      for (const active of activeRequests) {
        if (RUNTIME_IPC_CLIENT_SCOPED_OPERATIONS.has(active.operation)) active.controller.abort();
      }
      finalizationPromise = finalizeHostOwnership();
      void finalizationPromise.then(resolveClosed, rejectClosed);
    }
    return finalizationPromise;
  };

  const acceptTask = acceptConnections().catch((error: unknown) => {
    if (!stopping && !isAbort(error) && !(error instanceof RuntimeEndpointUnavailableError)) {
      stopping = true;
      acceptController.abort();
      queueMicrotask(() => {
        void beginClose().catch(() => undefined);
      });
    }
  });
  void application.fatalError
    .then(
      () => beginClose(),
      () => beginClose(),
    )
    .catch(() => undefined);

  return {
    identity,
    generationId: claim.generationId,
    closed,
    close(control = {}) {
      return closeHost(control);
    },
  };

  async function acceptConnections(): Promise<void> {
    while (!stopping) {
      const connection = await listener.accept(acceptController.signal);
      if (stopping) {
        await connection.close();
        return;
      }
      connections.add(connection);
      const task = serveConnection(connection)
        .catch(() => undefined)
        .finally(() => {
          connections.delete(connection);
          connectionTasks.delete(task);
        });
      connectionTasks.add(task);
    }
  }

  async function serveConnection(connection: RuntimeEndpointConnection): Promise<void> {
    if (connection.peerPrincipalId !== identity.principalId) {
      await connection.close();
      return;
    }
    const decoder = new RuntimeIpcJsonlDecoder<unknown>(
      RUNTIME_IPC_LIMITS.maxLineBytes,
      RUNTIME_IPC_LIMITS.maxBufferedBytes,
      (value) => value,
    );
    const writer = new RuntimeConnectionWriter(connection, responseBudget);
    const requests = new Map<string, ActiveRequest>();
    const settledRequestIds = new Set<string>();
    let clientId: string | undefined;
    let lastRequestSequence = 0;
    let requestCount = 0;
    let handshakeComplete = false;
    const connectedAt = Date.now();
    let partialLineStartedAt: number | undefined;

    try {
      while (!stopping) {
        const timeoutMs = !handshakeComplete
          ? Math.max(1, timeouts.handshakeTimeoutMs - (Date.now() - connectedAt))
          : decoder.hasPartialLine
            ? Math.max(1, timeouts.partialLineTimeoutMs - (Date.now() - (partialLineStartedAt ?? Date.now())))
            : undefined;
        const chunk = await readWithOptionalDeadline(connection, timeoutMs);
        if (chunk === null) {
          decoder.finish();
          break;
        }
        const frames: unknown[] = [];
        decoder.push(chunk, (frame) => frames.push(frame));
        if (decoder.hasPartialLine) partialLineStartedAt ??= Date.now();
        else partialLineStartedAt = undefined;
        for (const frame of frames) {
          if (!handshakeComplete) {
            const result = await acceptHandshake(frame, connection, writer);
            if (result === undefined) return;
            clientId = result;
            handshakeComplete = true;
            continue;
          }
          let envelope: RuntimeIpcEnvelope;
          try {
            envelope = decodeRuntimeIpcEnvelope(frame);
          } catch {
            return;
          }
          if (envelope.kind === "request") {
            if (stopping) {
              await writer.send(failureResponse(envelope, "runtime_unavailable", claim.generationId));
              return;
            }
            if (
              envelope.hostGenerationId !== claim.generationId ||
              envelope.clientId !== clientId ||
              envelope.requestSequence <= lastRequestSequence ||
              settledRequestIds.has(envelope.requestId) ||
              requests.has(envelope.requestId)
            ) {
              await writer.send(failureResponse(envelope, "request_rejected", claim.generationId));
              return;
            }
            lastRequestSequence = envelope.requestSequence;
            requestCount += 1;
            if (requestCount > RUNTIME_IPC_LIMITS.maxRequestsPerConnection) {
              await writer.send(failureResponse(envelope, "resource_exhausted", claim.generationId));
              return;
            }
            if (
              requests.size >= RUNTIME_IPC_LIMITS.maxInFlightPerConnection ||
              activeRequests.size >= RUNTIME_IPC_LIMITS.maxInFlightHost
            ) {
              settledRequestIds.add(envelope.requestId);
              await writer.send(failureResponse(envelope, "resource_exhausted", claim.generationId));
              continue;
            }
            const active = startApplicationRequest(envelope, writer, requests, settledRequestIds);
            requests.set(envelope.requestId, active);
            activeRequests.add(active);
            continue;
          }
          if (envelope.kind === "cancel") {
            if (
              envelope.hostGenerationId !== claim.generationId ||
              envelope.clientId !== clientId ||
              envelope.requestSequence > lastRequestSequence
            ) {
              return;
            }
            cancelClientScopedRequest(envelope, requests);
            continue;
          }
          return;
        }
      }
    } catch (error) {
      if (!(error instanceof RuntimeIpcProtocolError) && !isAbort(error)) {
        // Connection failures are isolated from the host and other clients.
      }
    } finally {
      writer.close();
      for (const active of requests.values()) {
        if (RUNTIME_IPC_CLIENT_SCOPED_OPERATIONS.has(active.operation)) active.controller.abort();
      }
      await connection.close().catch(() => undefined);
    }

    function startApplicationRequest(
      request: RuntimeIpcRequest,
      responseWriter: RuntimeConnectionWriter,
      connectionRequests: Map<string, ActiveRequest>,
      settledIds: Set<string>,
    ): ActiveRequest {
      const controller = new AbortController();
      const applicationResult = dispatchRuntimeApplicationOperation(
        application,
        request.operation,
        request.payload,
        controller.signal,
      );
      const active: ActiveRequest = {
        operation: request.operation,
        controller,
        applicationSettled: applicationResult.then(
          () => undefined,
          () => undefined,
        ),
      };
      void applicationResult
        .then((response) =>
          responseWriter.send({
            protocolVersion: RUNTIME_IPC_PROTOCOL_VERSION,
            kind: "response",
            hostGenerationId: claim.generationId,
            clientId: request.clientId,
            requestId: request.requestId,
            requestSequence: request.requestSequence,
            operation: request.operation,
            outcome: "success",
            value: snapshotRuntimeApplicationResponse(request.operation, request.payload, response),
          }),
        )
        .catch(() => responseWriter.send(failureResponse(request, "operation_failed", claim.generationId)))
        .catch(() => undefined)
        .finally(() => {
          connectionRequests.delete(request.requestId);
          settledIds.add(request.requestId);
          activeRequests.delete(active);
        });
      return active;
    }
  }

  async function acceptHandshake(
    value: unknown,
    connection: RuntimeEndpointConnection,
    writer: RuntimeConnectionWriter,
  ): Promise<string | undefined> {
    const attempt = snapshotHandshakeAttempt(value);
    if (attempt === undefined) return undefined;
    if (attempt.protocolVersion !== RUNTIME_IPC_PROTOCOL_VERSION) {
      await writer.send({
        protocolVersion: RUNTIME_IPC_PROTOCOL_VERSION,
        kind: "handshake_rejection",
        clientId: attempt.clientId,
        error: {
          code: "version_mismatch",
          message: "Runtime IPC protocol version is unsupported.",
          retryable: false,
        },
      });
      return undefined;
    }
    if (connection.peerPrincipalId !== identity.principalId) {
      await writer.send({
        protocolVersion: RUNTIME_IPC_PROTOCOL_VERSION,
        kind: "handshake_rejection",
        clientId: attempt.clientId,
        error: {
          code: "authorization_failed",
          message: "Runtime endpoint authorization failed.",
          retryable: false,
        },
      });
      return undefined;
    }
    await writer.send({
      protocolVersion: RUNTIME_IPC_PROTOCOL_VERSION,
      kind: "handshake_response",
      clientId: attempt.clientId,
      hostGenerationId: claim.generationId,
    });
    return attempt.clientId;
  }

  async function closeHost(control: RuntimeApplicationControl = {}): Promise<RuntimeHostShutdownResult> {
    const deadlineAt = Date.now() + positiveTimeout(control.timeoutMs, 10_000);
    const finalization = beginClose();
    try {
      return await runUntilShutdownBoundary(finalization, deadlineAt, control.signal);
    } catch (error) {
      throw new AggregateError([error], "Runtime host shutdown was incomplete.");
    }
  }

  async function finalizeHostOwnership(): Promise<RuntimeHostShutdownResult> {
    const errors: unknown[] = [];
    await acceptTask;
    await Promise.allSettled([...activeRequests].map((active) => active.applicationSettled));
    let shutdownResult: RuntimeHostShutdownResult = { checkpoint: "failed" };
    try {
      shutdownResult = await application.shutdown();
    } catch (error) {
      errors.push(error);
    }
    try {
      await listener.close();
    } catch (error) {
      errors.push(error);
    }
    await Promise.allSettled([...connectionTasks]);
    try {
      await claim.release();
    } catch (error) {
      errors.push(error);
    }
    if (errors.length > 0) throw new AggregateError(errors, "Runtime host shutdown was incomplete.");
    return shutdownResult;
  }
}

async function runUntilShutdownBoundary(
  operation: Promise<RuntimeHostShutdownResult>,
  deadlineAt: number,
  signal: AbortSignal | undefined,
): Promise<RuntimeHostShutdownResult> {
  if (signal?.aborted) throw runtimeShutdownCanceled();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const boundary = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error("Runtime host shutdown timed out.")),
      Math.max(1, deadlineAt - Date.now()),
    );
    timer.unref();
    if (signal !== undefined) {
      onAbort = () => reject(runtimeShutdownCanceled());
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) onAbort();
    }
  });
  try {
    return await Promise.race([operation, boundary]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (onAbort !== undefined) signal?.removeEventListener("abort", onAbort);
  }
}

function runtimeShutdownCanceled(): Error {
  const error = new Error("Runtime host shutdown was canceled.");
  error.name = "AbortError";
  return error;
}

type ActiveRequest = {
  operation: RuntimeIpcOperation;
  controller: AbortController;
  applicationSettled: Promise<void>;
};

class HostResponseBudget {
  #count = 0;
  #bytes = 0;

  reserve(bytes: number): (() => void) | undefined {
    if (
      this.#count >= RUNTIME_IPC_LIMITS.maxQueuedResponsesHost ||
      this.#bytes + bytes > RUNTIME_IPC_LIMITS.maxQueuedResponseBytesHost
    ) {
      return undefined;
    }
    this.#count += 1;
    this.#bytes += bytes;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#count -= 1;
      this.#bytes -= bytes;
    };
  }
}

class RuntimeConnectionWriter {
  #tail: Promise<void> = Promise.resolve();
  #abort = new AbortController();
  #queuedCount = 0;
  #queuedBytes = 0;
  #closed = false;

  constructor(
    readonly connection: RuntimeEndpointConnection,
    readonly hostBudget: HostResponseBudget,
  ) {}

  send(envelope: RuntimeIpcEnvelope): Promise<void> {
    if (this.#closed) return Promise.reject(new RuntimeEndpointUnavailableError("closed"));
    const bytes = Buffer.from(encodeRuntimeIpcEnvelope(envelope), "utf8");
    if (
      this.#queuedCount >= RUNTIME_IPC_LIMITS.maxQueuedResponsesPerConnection ||
      this.#queuedBytes + bytes.byteLength > RUNTIME_IPC_LIMITS.maxQueuedResponseBytesPerConnection
    ) {
      this.close();
      return Promise.reject(new RuntimeEndpointUnavailableError("closed"));
    }
    const releaseHost = this.hostBudget.reserve(bytes.byteLength);
    if (releaseHost === undefined) {
      this.close();
      return Promise.reject(new RuntimeEndpointUnavailableError("closed"));
    }
    this.#queuedCount += 1;
    this.#queuedBytes += bytes.byteLength;
    const write = this.#tail.then(() => this.connection.write(bytes, this.#abort.signal));
    this.#tail = write.catch(() => undefined);
    return write.finally(() => {
      this.#queuedCount -= 1;
      this.#queuedBytes -= bytes.byteLength;
      releaseHost();
    });
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#abort.abort();
    void this.connection.close().catch(() => undefined);
  }
}

function cancelClientScopedRequest(cancel: RuntimeIpcCancel, requests: ReadonlyMap<string, ActiveRequest>): void {
  const active = requests.get(cancel.requestId);
  if (
    active !== undefined &&
    RUNTIME_IPC_CLIENT_SCOPED_OPERATIONS.has(active.operation) &&
    cancel.requestSequence > 0
  ) {
    active.controller.abort();
  }
}

function failureResponse(
  request: RuntimeIpcRequest,
  code: "operation_failed" | "request_rejected" | "resource_exhausted" | "runtime_unavailable",
  generationId: string,
): RuntimeIpcResponse {
  return {
    protocolVersion: RUNTIME_IPC_PROTOCOL_VERSION,
    kind: "response",
    hostGenerationId: generationId,
    clientId: request.clientId,
    requestId: request.requestId,
    requestSequence: request.requestSequence,
    operation: request.operation,
    outcome: "failure",
    error: publicFailure(code),
  };
}

function publicFailure(
  code: "operation_failed" | "request_rejected" | "resource_exhausted" | "runtime_unavailable",
): RuntimeIpcFailure {
  switch (code) {
    case "operation_failed":
      return {
        code,
        message: "Runtime Application operation failed.",
        retryable: false,
        execution: "started",
      };
    case "request_rejected":
      return {
        code,
        message: "Runtime IPC request was rejected.",
        retryable: false,
        execution: "not_started",
      };
    case "resource_exhausted":
      return {
        code,
        message: "Runtime IPC resource limit was reached.",
        retryable: true,
        execution: "not_started",
      };
    case "runtime_unavailable":
      return {
        code,
        message: "Runtime host is stopping.",
        retryable: true,
        execution: "not_started",
      };
  }
}

function snapshotHandshakeAttempt(value: unknown): Readonly<{ protocolVersion: string; clientId: string }> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Object.keys(value);
  if (
    keys.length !== 3 ||
    !keys.includes("protocolVersion") ||
    !keys.includes("kind") ||
    !keys.includes("clientId") ||
    Reflect.ownKeys(value).length !== keys.length ||
    keys.some((key) => {
      const descriptor = descriptors[key];
      return descriptor === undefined || !descriptor.enumerable || !("value" in descriptor);
    })
  ) {
    return undefined;
  }
  const protocolVersion = descriptors.protocolVersion?.value as unknown;
  const kind = descriptors.kind?.value as unknown;
  const clientId = descriptors.clientId?.value as unknown;
  if (
    typeof protocolVersion !== "string" ||
    protocolVersion.length === 0 ||
    protocolVersion.length > 128 ||
    kind !== "handshake_request" ||
    !isCanonicalUuid(clientId)
  ) {
    return undefined;
  }
  return { protocolVersion, clientId };
}

async function readWithOptionalDeadline(
  connection: RuntimeEndpointConnection,
  timeoutMs: number | undefined,
): Promise<Uint8Array | null> {
  if (timeoutMs === undefined) return await connection.read();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref();
  try {
    return await connection.read(controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

function positiveTimeout(value: number | undefined, defaultValue: number): number {
  const selected = value ?? defaultValue;
  if (!Number.isSafeInteger(selected) || selected < 1) throw new RangeError("Runtime host timeout is invalid.");
  return selected;
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}
