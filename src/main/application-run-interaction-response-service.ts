import { types as nodeTypes } from "node:util";

import { APPLICATION_RUN_PAYLOAD_LIMITS } from "../shared/application-run-payload-limits.js";
import type {
  ApplicationAccessDecision,
  ApplicationOperationOptions,
  ApplicationOperationResponse,
} from "../shared/application-service-model.js";
import {
  isApplicationRunRespondInteractionDomainErrorCode,
  type ApplicationRunAccessValidator,
  type ApplicationRunInteractionResponse,
  type ApplicationRunRespondInteractionRequest,
  type ApplicationRunRespondInteractionResult,
} from "../shared/application-run-model.js";
import type { PersistenceError } from "../shared/persistence-protocol.js";
import { isCanonicalUuid, isPlainObject } from "../shared/persistence-runtime-protocol.js";
import type {
  RunInteractionResponseReplayProbeRequest,
  RunInteractionResponseReplayProbeResult,
} from "../shared/repository-read-model.js";
import type {
  RepositoryCommandError,
  RepositoryCommandResult,
  RunInteractionResponseResult,
  RunInteractionSemanticAction,
} from "../shared/repository-write-model.js";
import { decodeApplicationRunExecutionSnapshot } from "./application-run-admission-service.js";
import { PersistenceClientError } from "./persistence-worker-client.js";
import type { ProviderDefinitionRegistry } from "./providers/provider-definition.js";
import { defaultProviderDefinitionRegistry } from "./providers/provider-registry.js";

export type ApplicationRunInteractionResponseOwnerInput = Readonly<{
  sessionId: string;
  runId: string;
  workspaceKey: string;
  idempotencyKey: string;
  providerId: string;
  definitionVersion: string;
  response: ApplicationRunInteractionResponse;
  semanticAction: RunInteractionSemanticAction;
  canonicalResponseJson: string;
}>;

export interface ApplicationRunInteractionResponseOwnerPort {
  respond(
    input: ApplicationRunInteractionResponseOwnerInput,
  ): Promise<RepositoryCommandResult<RunInteractionResponseResult>>;
}

export interface ApplicationRunInteractionResponseReplayPort {
  probe(input: RunInteractionResponseReplayProbeRequest): Promise<RunInteractionResponseReplayProbeResult>;
}

export interface ApplicationRunInteractionResponseReadPort {
  readSession(input: Readonly<{ sessionId: string }>, options?: ApplicationOperationOptions): Promise<unknown>;
  readRun(
    input: Readonly<{ sessionId: string; workspaceKey: string; runId: string }>,
    options?: ApplicationOperationOptions,
  ): Promise<unknown>;
  readSnapshotChunk(
    input: Readonly<{
      sessionId: string;
      workspaceKey: string;
      runId: string;
      offset: number;
      maxBytes: number;
    }>,
    options?: ApplicationOperationOptions,
  ): Promise<unknown>;
}

export type ApplicationRunInteractionResponseServiceOptions<TAuthorizationContext> = Readonly<{
  reads: ApplicationRunInteractionResponseReadPort;
  access: ApplicationRunAccessValidator<TAuthorizationContext>;
  snapshotAuthorization(value: unknown): TAuthorizationContext;
  owner: ApplicationRunInteractionResponseOwnerPort;
  replay?: ApplicationRunInteractionResponseReplayPort;
  providers?: ProviderDefinitionRegistry;
}>;

type WriteResponse = ApplicationOperationResponse<ApplicationRunRespondInteractionResult, "write">;
type WriteFailure = Extract<WriteResponse, Readonly<{ overallStatus: "failure" }>>;
type OperationInterruption = "timeout" | "canceled";
type OperationControl = Readonly<{ deadlineAt?: number; signal?: AbortSignal }>;
type ControlledSettlement<TValue> =
  | Readonly<{ status: "fulfilled"; value: TValue }>
  | Readonly<{ status: "rejected"; error: unknown }>
  | Readonly<{ status: "interrupted"; interruption: OperationInterruption; started: boolean }>;

type ResponseScope = Readonly<{
  sessionId: string;
  runId: string;
  workspaceKey: string;
  providerId: string;
  definitionVersion: string;
}>;

const unavailableOwner: ApplicationRunInteractionResponseOwnerPort = {
  async respond() {
    return {
      ok: false,
      error: {
        code: "lifecycle_conflict",
        message: "The live Run interaction owner is unavailable.",
        retryable: false,
      },
      replayed: false,
    };
  },
};

const unavailableReplay: ApplicationRunInteractionResponseReplayPort = {
  async probe() {
    return { kind: "absent" };
  },
};

export function defaultApplicationRunInteractionResponseOwnerPort(): ApplicationRunInteractionResponseOwnerPort {
  return unavailableOwner;
}

export class ApplicationRunInteractionResponseService<TAuthorizationContext> {
  readonly #reads: ApplicationRunInteractionResponseReadPort;
  readonly #access: ApplicationRunAccessValidator<TAuthorizationContext>;
  readonly #snapshotAuthorization: (value: unknown) => TAuthorizationContext;
  readonly #owner: ApplicationRunInteractionResponseOwnerPort;
  readonly #replay: ApplicationRunInteractionResponseReplayPort;
  readonly #providers: ProviderDefinitionRegistry;

  constructor(options: ApplicationRunInteractionResponseServiceOptions<TAuthorizationContext>) {
    this.#reads = options.reads;
    this.#access = options.access;
    this.#snapshotAuthorization = options.snapshotAuthorization;
    this.#owner = options.owner;
    this.#replay = options.replay ?? unavailableReplay;
    this.#providers = options.providers ?? defaultProviderDefinitionRegistry;
  }

  async respondInteraction(
    request: ApplicationRunRespondInteractionRequest<TAuthorizationContext>,
    options?: ApplicationOperationOptions,
  ): Promise<WriteResponse> {
    let input: ApplicationRunRespondInteractionRequest<TAuthorizationContext>;
    let control: OperationControl;
    try {
      control = decodeOperationControl(options);
      input = decodeRequest(request, this.#snapshotAuthorization);
    } catch {
      return requestFailure();
    }
    const interrupted = getInterruption(control);
    if (interrupted !== undefined) return operationFailure(interrupted);

    const authorization = await runControlled(control, () =>
      this.#access.authorize({
        operation: "respond-interaction",
        access: "write",
        context: input.context,
        target: {
          kind: "run_interaction",
          sessionId: input.sessionId,
          runId: input.runId,
          interactionId: input.response.interactionId,
        },
      }),
    );
    if (authorization.status === "interrupted") return operationFailure(authorization.interruption);
    if (authorization.status === "rejected") return applicationFailure("none");
    let decision: ApplicationAccessDecision;
    try {
      decision = projectAccessDecision(authorization.value);
    } catch {
      return applicationFailure("none");
    }
    if (!decision.allowed) return accessFailure(decision.error);

    const scope = await this.#readScope(input, control);
    if (scope.overallStatus === "failure") return scope;
    let canonical: ReturnType<ProviderDefinitionRegistry["canonicalizeInteractionResponseShape"]>;
    let canonicalResponseJson: string;
    try {
      canonical = this.#providers.canonicalizeInteractionResponseShape(
        scope.value.providerId,
        scope.value.definitionVersion,
        input.response,
      );
      canonicalResponseJson = JSON.stringify(canonical.response);
    } catch {
      return requestFailure();
    }

    const replay = await runControlled(control, () =>
      this.#replay.probe({
        sessionId: input.sessionId,
        runId: input.runId,
        idempotencyKey: input.idempotencyKey,
        interactionKind: canonical.response.kind,
        interactionId: canonical.response.interactionId,
        canonicalResponseJson,
      }),
    );
    if (replay.status === "interrupted") return operationFailure(replay.interruption);
    if (replay.status === "rejected") {
      return replay.error instanceof PersistenceClientError
        ? persistenceFailure(replay.error.persistenceError, replay.error.persistenceError.effect)
        : applicationFailure("none");
    }
    if (replay.value.kind === "failure") return repositoryFailure(replay.value.error, false);
    if (replay.value.kind === "replay") return success(projectResult(replay.value.value), true);

    const interruptedBeforeOwner = getInterruption(control);
    if (interruptedBeforeOwner !== undefined) return operationFailure(interruptedBeforeOwner);
    const owner = await runControlled(
      control,
      () =>
        this.#owner.respond({
          ...scope.value,
          idempotencyKey: input.idempotencyKey,
          response: canonical.response,
          semanticAction: canonical.semanticAction,
          canonicalResponseJson,
        }),
      undefined,
      true,
    );
    if (owner.status === "interrupted") return persistenceInterruptionFailure(owner.interruption);
    if (owner.status === "rejected") {
      return owner.error instanceof PersistenceClientError
        ? persistenceFailure(owner.error.persistenceError, owner.error.persistenceError.effect)
        : applicationFailure("unknown");
    }
    return owner.value.ok
      ? success(projectResult(owner.value.value), owner.value.replayed)
      : repositoryFailure(owner.value.error, true);
  }

  async #readScope(
    input: ApplicationRunRespondInteractionRequest<TAuthorizationContext>,
    control: OperationControl,
  ): Promise<Readonly<{ overallStatus: "success"; value: ResponseScope }> | WriteFailure> {
    const session = await runControlled(control, () => this.#reads.readSession({ sessionId: input.sessionId }));
    if (session.status === "interrupted") return operationFailure(session.interruption);
    if (session.status === "rejected") return mapReadFailure(session.error);
    try {
      const projected = allowRecord(session.value);
      const projectedSession = allowRecord(readDataProperty(projected, "session"));
      const sessionId = boundedIdentifierValue(readDataProperty(projectedSession, "id"));
      const workspaceKey = boundedIdentifierValue(readDataProperty(projectedSession, "workspaceKey"));
      if (sessionId !== input.sessionId) throw new TypeError("Session scope mismatch.");
      const runProjection = await runControlled(control, () =>
        this.#reads.readRun({ sessionId, workspaceKey, runId: input.runId }),
      );
      if (runProjection.status === "interrupted") return operationFailure(runProjection.interruption);
      if (runProjection.status === "rejected") return mapReadFailure(runProjection.error);
      const outer = allowRecord(runProjection.value);
      if (
        readDataProperty(outer, "sessionId") !== sessionId ||
        readDataProperty(outer, "workspaceKey") !== workspaceKey
      ) {
        throw new TypeError("Run scope mismatch.");
      }
      const run = allowRecord(readDataProperty(outer, "run"));
      if (
        boundedIdentifierValue(readDataProperty(run, "id")) !== input.runId ||
        boundedIdentifierValue(readDataProperty(run, "sessionId")) !== sessionId
      ) {
        throw new TypeError("Run identity mismatch.");
      }
      const snapshotState = readDataProperty(run, "executionSnapshotState");
      const snapshotByteLength = nonNegativeInteger(readDataProperty(run, "executionSnapshotByteLength"));
      const snapshotValue =
        snapshotState === "inline"
          ? readDataProperty(run, "executionSnapshot")
          : snapshotState === "chunked"
            ? await readJsonChunks(
                this.#reads,
                { sessionId, workspaceKey, runId: input.runId },
                snapshotByteLength,
                control,
              )
            : undefined;
      const snapshot = decodeApplicationRunExecutionSnapshot(snapshotValue, null);
      return {
        overallStatus: "success",
        value: {
          sessionId,
          runId: input.runId,
          workspaceKey,
          providerId: snapshot.providerId,
          definitionVersion: snapshot.definitionVersion,
        },
      };
    } catch (error) {
      return error instanceof PersistenceClientError ? mapReadFailure(error) : applicationFailure("none");
    }
  }
}

async function readJsonChunks(
  reads: ApplicationRunInteractionResponseReadPort,
  scope: Readonly<{ sessionId: string; workspaceKey: string; runId: string }>,
  expectedBytes: number,
  control: OperationControl,
): Promise<unknown> {
  if (expectedBytes > APPLICATION_RUN_PAYLOAD_LIMITS.executionSnapshotMaxJsonBytes) {
    throw new RangeError("Run execution snapshot is too large.");
  }
  const chunks: Uint8Array[] = [];
  let offset = 0;
  while (offset < expectedBytes) {
    const settlement = await runControlled(control, () =>
      reads.readSnapshotChunk({
        ...scope,
        offset,
        maxBytes: Math.min(256 * 1024, expectedBytes - offset),
      }),
    );
    if (settlement.status === "interrupted") throw interruptionError(settlement.interruption);
    if (settlement.status === "rejected") throw settlement.error;
    const projected = allowRecord(settlement.value);
    if (
      readDataProperty(projected, "sessionId") !== scope.sessionId ||
      readDataProperty(projected, "runId") !== scope.runId ||
      readDataProperty(projected, "workspaceKey") !== scope.workspaceKey ||
      nonNegativeInteger(readDataProperty(projected, "offset")) !== offset ||
      nonNegativeInteger(readDataProperty(projected, "totalBytes")) !== expectedBytes
    ) {
      throw new TypeError("Run execution snapshot chunk scope is invalid.");
    }
    const chunk = readDataProperty(projected, "chunk");
    if (!(chunk instanceof Uint8Array) || chunk.byteLength < 1 || offset + chunk.byteLength > expectedBytes) {
      throw new TypeError("Run execution snapshot chunk is invalid.");
    }
    chunks.push(chunk);
    offset += chunk.byteLength;
  }
  const bytes = new Uint8Array(expectedBytes);
  let position = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, position);
    position += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}

function decodeRequest<TAuthorizationContext>(
  value: unknown,
  snapshotAuthorization: (value: unknown) => TAuthorizationContext,
): ApplicationRunRespondInteractionRequest<TAuthorizationContext> {
  assertProxyFree(value);
  const request = exactRecord(value, ["context", "sessionId", "runId", "idempotencyKey", "response"]);
  const context = exactRecord(readDataProperty(request, "context"), ["authorization"]);
  const sessionId = boundedIdentifierValue(readDataProperty(request, "sessionId"));
  const runId = boundedIdentifierValue(readDataProperty(request, "runId"));
  const idempotencyKey = readDataProperty(request, "idempotencyKey");
  if (!isCanonicalUuid(idempotencyKey)) throw new TypeError("Idempotency key is invalid.");
  const response = snapshotJson(readDataProperty(request, "response"), 0);
  if (!isPlainObject(response)) throw new TypeError("Interaction response is invalid.");
  return {
    context: { authorization: snapshotAuthorization(readDataProperty(context, "authorization")) },
    sessionId,
    runId,
    idempotencyKey,
    response: response as ApplicationRunInteractionResponse,
  };
}

function decodeOperationControl(value: unknown): OperationControl {
  if (value === undefined) return {};
  const options = exactRecord(value, ["timeoutMs", "signal"]);
  const timeoutMs = readOptionalDataProperty(options, "timeoutMs");
  const signal = readOptionalDataProperty(options, "signal");
  if (timeoutMs !== undefined && (!Number.isSafeInteger(timeoutMs) || (timeoutMs as number) < 1)) {
    throw new TypeError("Operation timeout is invalid.");
  }
  if (signal !== undefined && !(signal instanceof AbortSignal)) throw new TypeError("Operation signal is invalid.");
  return {
    ...(timeoutMs === undefined ? {} : { deadlineAt: Date.now() + (timeoutMs as number) }),
    ...(signal === undefined ? {} : { signal: signal as AbortSignal }),
  };
}

function snapshotJson(value: unknown, depth: number): unknown {
  if (depth > 32) throw new TypeError("Interaction response is too deeply nested.");
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new TypeError("Interaction response number is invalid.");
    return value;
  }
  if (Array.isArray(value)) {
    if (nodeTypes.isProxy(value) || Object.getPrototypeOf(value) !== Array.prototype) {
      throw new TypeError("Interaction response array is invalid.");
    }
    const output: unknown[] = [];
    for (let index = 0; index < value.length; index += 1) {
      if (!Object.hasOwn(value, index)) throw new TypeError("Interaction response array is sparse.");
      output.push(snapshotJson(readDataProperty(value, String(index)), depth + 1));
    }
    return Object.freeze(output);
  }
  const record = inspectRecord(value);
  const output: Record<string, unknown> = {};
  for (const key of Reflect.ownKeys(record)) {
    if (typeof key !== "string") throw new TypeError("Interaction response key is invalid.");
    Object.defineProperty(output, key, {
      value: snapshotJson(readDataProperty(record, key), depth + 1),
      enumerable: true,
      configurable: false,
      writable: false,
    });
  }
  return Object.freeze(output);
}

function projectResult(value: unknown): ApplicationRunRespondInteractionResult {
  const result = allowRecord(value);
  const base = {
    sessionId: boundedIdentifierValue(readDataProperty(result, "sessionId")),
    runId: boundedIdentifierValue(readDataProperty(result, "runId")),
    interactionId: boundedIdentifierValue(readDataProperty(result, "interactionId")),
    admittedAt: nonNegativeInteger(readDataProperty(result, "admittedAt")),
  };
  const effectCertainty = readDataProperty(result, "effectCertainty");
  const writeAttemptedAt = readDataProperty(result, "writeAttemptedAt");
  const settledAt = readDataProperty(result, "settledAt");
  const resolutionCode = readDataProperty(result, "resolutionCode");
  switch (effectCertainty) {
    case "admitted":
      if (writeAttemptedAt !== null || settledAt !== null || resolutionCode !== null) break;
      assertInteractionResponseTimestampOrder(base.admittedAt, writeAttemptedAt, settledAt);
      return { ...base, effectCertainty, writeAttemptedAt, settledAt, resolutionCode };
    case "write_attempted": {
      if (settledAt !== null || resolutionCode !== null) break;
      const projectedWriteAttemptedAt = nonNegativeInteger(writeAttemptedAt);
      assertInteractionResponseTimestampOrder(base.admittedAt, projectedWriteAttemptedAt, settledAt);
      return {
        ...base,
        effectCertainty,
        writeAttemptedAt: projectedWriteAttemptedAt,
        settledAt,
        resolutionCode,
      };
    }
    case "resolved": {
      if (resolutionCode !== "provider_resolved") break;
      const projectedWriteAttemptedAt = nonNegativeInteger(writeAttemptedAt);
      const projectedSettledAt = nonNegativeInteger(settledAt);
      assertInteractionResponseTimestampOrder(base.admittedAt, projectedWriteAttemptedAt, projectedSettledAt);
      return {
        ...base,
        effectCertainty,
        writeAttemptedAt: projectedWriteAttemptedAt,
        settledAt: projectedSettledAt,
        resolutionCode,
      };
    }
    case "ambiguous": {
      if (resolutionCode !== "transport_unknown" && resolutionCode !== "process_unknown") break;
      const projectedWriteAttemptedAt = nonNegativeInteger(writeAttemptedAt);
      const projectedSettledAt = nonNegativeInteger(settledAt);
      assertInteractionResponseTimestampOrder(base.admittedAt, projectedWriteAttemptedAt, projectedSettledAt);
      return {
        ...base,
        effectCertainty,
        writeAttemptedAt: projectedWriteAttemptedAt,
        settledAt: projectedSettledAt,
        resolutionCode,
      };
    }
    case "not_sent": {
      if (writeAttemptedAt !== null && (!Number.isSafeInteger(writeAttemptedAt) || (writeAttemptedAt as number) < 0)) {
        break;
      }
      if (writeAttemptedAt === null) {
        if (resolutionCode !== "owner_lost_before_write" && resolutionCode !== "adapter_rejected") break;
        const projectedSettledAt = nonNegativeInteger(settledAt);
        assertInteractionResponseTimestampOrder(base.admittedAt, writeAttemptedAt, projectedSettledAt);
        return {
          ...base,
          effectCertainty,
          writeAttemptedAt,
          settledAt: projectedSettledAt,
          resolutionCode,
        };
      }
      if (resolutionCode !== "transport_not_sent" && resolutionCode !== "adapter_rejected") {
        break;
      }
      const projectedSettledAt = nonNegativeInteger(settledAt);
      assertInteractionResponseTimestampOrder(base.admittedAt, writeAttemptedAt as number, projectedSettledAt);
      return {
        ...base,
        effectCertainty,
        writeAttemptedAt: writeAttemptedAt as number,
        settledAt: projectedSettledAt,
        resolutionCode,
      };
    }
  }
  throw new TypeError("Interaction response result is invalid.");
}

function assertInteractionResponseTimestampOrder(
  admittedAt: number,
  writeAttemptedAt: number | null,
  settledAt: number | null,
): void {
  if (
    (writeAttemptedAt !== null && writeAttemptedAt < admittedAt) ||
    (settledAt !== null && settledAt < admittedAt) ||
    (writeAttemptedAt !== null && settledAt !== null && settledAt < writeAttemptedAt)
  ) {
    throw new TypeError("Interaction response result is invalid.");
  }
}

function projectAccessDecision(value: unknown): ApplicationAccessDecision {
  const decision = allowRecord(value);
  if (readDataProperty(decision, "allowed") === true) return { allowed: true };
  if (readDataProperty(decision, "allowed") !== false) throw new TypeError("Access decision is invalid.");
  const error = allowRecord(readDataProperty(decision, "error"));
  const code = readDataProperty(error, "code");
  const message = readDataProperty(error, "message");
  const retryable = readDataProperty(error, "retryable");
  if (
    (code !== "workspace_invalid" &&
      code !== "workspace_unavailable" &&
      code !== "authorization_invalid" &&
      code !== "forbidden") ||
    typeof message !== "string" ||
    message.length < 1 ||
    message.length > 4_096 ||
    typeof retryable !== "boolean"
  ) {
    throw new TypeError("Access decision is invalid.");
  }
  return { allowed: false, error: { code, message, retryable } };
}

function success(value: ApplicationRunRespondInteractionResult, replayed: boolean): WriteResponse {
  return {
    overallStatus: "success",
    value,
    persistence: { status: "committed", effect: "none", replayed },
  };
}

function repositoryFailure(error: RepositoryCommandError, attempted: boolean): WriteFailure {
  if (!isApplicationRunRespondInteractionDomainErrorCode(error.code)) return applicationFailure("none");
  return {
    overallStatus: "failure",
    error: { kind: "domain", code: error.code, message: error.message, retryable: error.retryable },
    persistence: attempted ? { status: "rejected", effect: "none" } : { status: "not_attempted", effect: "none" },
  };
}

function requestFailure(): WriteFailure {
  return {
    overallStatus: "failure",
    error: {
      kind: "request",
      code: "request_invalid",
      message: "Application operation request is invalid.",
      retryable: false,
    },
    persistence: { status: "not_attempted", effect: "none" },
  };
}

function accessFailure(error: Extract<ApplicationAccessDecision, { allowed: false }>["error"]): WriteFailure {
  return {
    overallStatus: "failure",
    error: { kind: "access", ...error },
    persistence: { status: "not_attempted", effect: "none" },
  };
}

function operationFailure(interruption: OperationInterruption): WriteFailure {
  return {
    overallStatus: "failure",
    error:
      interruption === "timeout"
        ? {
            kind: "operation",
            code: "operation_timeout",
            message: "Application operation timed out.",
            retryable: true,
          }
        : {
            kind: "operation",
            code: "operation_canceled",
            message: "Application operation was canceled.",
            retryable: false,
          },
    persistence: { status: "not_attempted", effect: "none" },
  };
}

function persistenceInterruptionFailure(interruption: OperationInterruption): WriteFailure {
  return {
    overallStatus: "failure",
    error: {
      kind: "persistence",
      code: interruption === "timeout" ? "persistence_timeout" : "persistence_canceled",
      message: interruption === "timeout" ? "Application operation timed out." : "Application operation was canceled.",
      retryable: interruption === "timeout",
      effect: "unknown",
    },
    persistence: { status: "failed", effect: "unknown", reconciliation: "exact_request_required" },
  };
}

function mapReadFailure(error: unknown): WriteFailure {
  return error instanceof PersistenceClientError
    ? persistenceFailure(error.persistenceError, error.persistenceError.effect)
    : applicationFailure("none");
}

function persistenceFailure(error: PersistenceError, effect: "none" | "unknown"): WriteFailure {
  const code = mapPersistenceErrorCode(error.code);
  return effect === "unknown"
    ? {
        overallStatus: "failure",
        error: { kind: "persistence", code, message: error.message, retryable: error.retryable, effect },
        persistence: { status: "failed", effect, reconciliation: "exact_request_required" },
      }
    : {
        overallStatus: "failure",
        error: { kind: "persistence", code, message: error.message, retryable: error.retryable, effect },
        persistence: { status: "failed", effect },
      };
}

function applicationFailure(effect: "none" | "unknown"): WriteFailure {
  return effect === "unknown"
    ? {
        overallStatus: "failure",
        error: {
          kind: "application",
          code: "internal_error",
          message: "Application Service could not complete the operation.",
          retryable: false,
        },
        persistence: { status: "failed", effect, reconciliation: "exact_request_required" },
      }
    : {
        overallStatus: "failure",
        error: {
          kind: "application",
          code: "internal_error",
          message: "Application Service could not complete the operation.",
          retryable: false,
        },
        persistence: { status: "not_attempted", effect },
      };
}

function mapPersistenceErrorCode(code: PersistenceError["code"]) {
  switch (code) {
    case "worker_not_ready":
    case "worker_closing":
    case "worker_crashed":
    case "worker_start_failed":
    case "worker_shutdown_forced":
    case "database_unavailable":
      return "persistence_unavailable" as const;
    case "queue_full":
    case "database_busy":
      return "persistence_busy" as const;
    case "request_timeout":
      return "persistence_timeout" as const;
    case "request_canceled":
      return "persistence_canceled" as const;
    case "response_too_large":
      return "persistence_response_too_large" as const;
    case "database_schema_verification_failed":
    case "database_integrity_check_failed":
      return "persistence_integrity_failed" as const;
    case "database_path_invalid":
    case "database_identity_mismatch":
    case "database_schema_unknown":
    case "database_schema_too_new":
    case "database_schema_too_old":
    case "database_pragma_mismatch":
    case "database_wal_unavailable":
    case "database_bootstrap_failed":
    case "schema_artifact_invalid":
      return "persistence_configuration_invalid" as const;
    default:
      return "persistence_operation_failed" as const;
  }
}

function exactRecord(value: unknown, allowedKeys: readonly string[]): Readonly<Record<string, unknown>> {
  const record = inspectRecord(value);
  const allowed = new Set(allowedKeys);
  for (const key of Reflect.ownKeys(record)) {
    if (typeof key !== "string" || !allowed.has(key)) throw new TypeError("Record keys are invalid.");
  }
  return record;
}

function inspectRecord(value: unknown): Readonly<Record<string, unknown>> {
  if (!isPlainObject(value) || nodeTypes.isProxy(value)) throw new TypeError("Record is invalid.");
  return value;
}

function allowRecord(value: unknown): Readonly<Record<string, unknown>> {
  if (!isPlainObject(value) || nodeTypes.isProxy(value)) throw new TypeError("Projection is invalid.");
  return value;
}

function readDataProperty(value: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
    throw new TypeError("Data property is invalid.");
  }
  return descriptor.value;
}

function readOptionalDataProperty(value: object, key: string): unknown {
  return Object.hasOwn(value, key) ? readDataProperty(value, key) : undefined;
}

function assertProxyFree(value: unknown): void {
  if (typeof value === "object" && value !== null && nodeTypes.isProxy(value)) {
    throw new TypeError("Proxy input is invalid.");
  }
}

function boundedIdentifierValue(value: unknown): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 1_024 || value.includes("\0")) {
    throw new TypeError("Identifier is invalid.");
  }
  return value;
}

function nonNegativeInteger(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new TypeError("Integer is invalid.");
  return value as number;
}

async function runControlled<TValue>(
  control: OperationControl,
  start: () => Promise<TValue>,
  onInterrupt?: () => void,
  started = false,
): Promise<ControlledSettlement<TValue>> {
  const interruption = getInterruption(control);
  if (interruption !== undefined) return { status: "interrupted", interruption, started: false };
  let operation: Promise<TValue>;
  try {
    operation = Promise.resolve(start());
  } catch (error) {
    return { status: "rejected", error };
  }
  return new Promise((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (value: ControlledSettlement<TValue>) => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      control.signal?.removeEventListener("abort", onAbort);
      resolve(value);
    };
    const interrupt = (kind: OperationInterruption) => {
      if (settled) return;
      try {
        onInterrupt?.();
      } finally {
        finish({ status: "interrupted", interruption: kind, started });
      }
    };
    const onAbort = () => interrupt("canceled");
    operation.then(
      (value) => finish({ status: "fulfilled", value }),
      (error: unknown) => finish({ status: "rejected", error }),
    );
    const remaining = remainingTimeout(control);
    if (remaining !== undefined) timer = setTimeout(() => interrupt("timeout"), remaining);
    control.signal?.addEventListener("abort", onAbort, { once: true });
    if (control.signal?.aborted) onAbort();
  });
}

function getInterruption(control: OperationControl): OperationInterruption | undefined {
  if (control.signal?.aborted) return "canceled";
  if (control.deadlineAt !== undefined && control.deadlineAt <= Date.now()) return "timeout";
  return undefined;
}

function remainingTimeout(control: OperationControl): number | undefined {
  return control.deadlineAt === undefined ? undefined : Math.max(0, control.deadlineAt - Date.now());
}

function interruptionError(interruption: OperationInterruption): Error {
  const error = new Error(`Application operation was ${interruption}.`);
  error.name = interruption === "canceled" ? "AbortError" : "TimeoutError";
  return error;
}
