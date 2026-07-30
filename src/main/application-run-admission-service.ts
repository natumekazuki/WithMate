import { types as nodeTypes } from "node:util";

import type {
  ApplicationAccessDecision,
  ApplicationCapacityExceededDetails,
  ApplicationDomainError,
  ApplicationOperationOptions,
  ApplicationOperationResponse,
} from "../shared/application-service-model.js";
import {
  APPLICATION_RUN_LIMITS,
  type ApplicationRunAccessValidator,
  type ApplicationRunAdmissionResult,
  type ApplicationRunExecutionOverrides,
  type ApplicationRunExecutionSettings,
  type ApplicationRunPhase,
  type ApplicationRunRetryRequest,
  type ApplicationRunSandboxSetting,
  type ApplicationRunStartRequest,
} from "../shared/application-run-model.js";
import { APPLICATION_RUN_PAYLOAD_LIMITS } from "../shared/application-run-payload-limits.js";
import {
  buildApplicationRunProviderRequest,
  type ApplicationRunProviderRequest,
} from "../shared/application-run-execution.js";
import {
  ALLOWED_ADDITIONAL_DIRECTORIES_LIMITS,
  normalizeAllowedAdditionalDirectories,
} from "../shared/allowed-additional-directories.js";
import {
  MESSAGE_CONTENT_LIMITS,
  snapshotMessageContentBlocks,
  type TextContentBlock,
} from "../shared/message-content.js";
import { resolveWorkspaceIdentity } from "../shared/workspace-path.js";
import type { PersistenceError } from "../shared/persistence-protocol.js";
import { isCanonicalUuid } from "../shared/persistence-runtime-protocol.js";
import type {
  RepositoryCommandError,
  RepositoryCommandResult,
  RepositoryJsonValue,
  RunExecutionSnapshot,
} from "../shared/repository-write-model.js";
import { PersistenceClientError, type PersistenceWorkerClient } from "./persistence-worker-client.js";
import type { RepositoryReadClient } from "./repository-read-client.js";
import { RepositoryWriteClient } from "./repository-write-client.js";

export type ApplicationRunAdmissionReadPort = Pick<
  RepositoryReadClient,
  "sessionGet" | "sessionDirectoriesChunk" | "runGet" | "runSnapshotChunk" | "messageContentChunk"
>;

export type { ApplicationRunProviderRequest } from "../shared/application-run-execution.js";

export type ApplicationRunAdmissionCommand =
  | Readonly<{
      operation: "start";
      sessionId: string;
      workspaceKey: string;
      idempotencyKey: string;
      contentBlocks: readonly TextContentBlock[];
      executionSnapshot: RunExecutionSnapshot;
      providerRequest: Readonly<{ [key: string]: RepositoryJsonValue }>;
    }>
  | Readonly<{
      operation: "retry";
      sessionId: string;
      workspaceKey: string;
      idempotencyKey: string;
      retryOfRunId: string;
      contentBlocks: readonly TextContentBlock[];
      executionSnapshot: RunExecutionSnapshot;
      providerRequest: Readonly<{ [key: string]: RepositoryJsonValue }>;
    }>;

export type ApplicationRunAdmissionRecord = Readonly<{
  sessionId: string;
  messageId: string;
  runId: string;
  retryOfRunId?: string;
  attemptId: string;
  bindingId: string;
  runPhase: ApplicationRunPhase;
  bindingState: "creating" | "active" | "invalidated" | "superseded";
  dispatchState: "pending" | "dispatching" | "accepted" | "rejected" | "ambiguous" | "aborted";
  admittedAt: number;
}>;

export interface ApplicationRunAdmissionPort {
  admit(
    command: ApplicationRunAdmissionCommand,
    options?: ApplicationOperationOptions,
  ): Promise<RepositoryCommandResult<ApplicationRunAdmissionRecord>>;
}

export interface ApplicationRunWorkHandoffPort {
  handoff(record: ApplicationRunAdmissionRecord): void;
}

export type ApplicationRunAdmissionServiceOptions<TAuthorizationContext> = Readonly<{
  reads: ApplicationRunAdmissionReadPort;
  admission: ApplicationRunAdmissionPort;
  handoff: ApplicationRunWorkHandoffPort;
  access: ApplicationRunAccessValidator<TAuthorizationContext>;
  snapshotAuthorization(value: unknown): TAuthorizationContext;
}>;

type WriteResponse = ApplicationOperationResponse<ApplicationRunAdmissionResult, "write">;
type WriteFailure = Extract<WriteResponse, Readonly<{ overallStatus: "failure" }>>;

type OperationControl = Readonly<{
  deadlineAt?: number;
  signal?: AbortSignal;
}>;

type OperationInterruption = "timeout" | "canceled";

type ControlledSettlement<TValue> =
  | Readonly<{ status: "fulfilled"; value: TValue }>
  | Readonly<{ status: "rejected"; error: unknown }>
  | Readonly<{ status: "interrupted"; interruption: OperationInterruption; started: boolean }>;

type SessionAdmissionContext = Readonly<{
  sessionId: string;
  providerId: string;
  workspaceKey: string;
  workspacePath: string;
  allowedAdditionalDirectories: readonly string[];
  lifecycleStatus: "active" | "archived" | "closed";
  activeRunId?: string;
}>;

type RetrySourceContext = Readonly<{
  retryOfRunId: string;
  initiatingMessageId: string;
  contentBlocks: readonly TextContentBlock[];
  executionSnapshot: RunExecutionSnapshot;
}>;

const unavailableAdmission: ApplicationRunAdmissionPort = {
  async admit() {
    throw new Error("Run admission is unavailable.");
  },
};

const unavailableHandoff: ApplicationRunWorkHandoffPort = {
  handoff() {
    // Slice wiring supplies the runtime owner. Until then an admitted Run remains a safe pending recovery candidate.
  },
};

export function defaultApplicationRunAdmissionPort(): ApplicationRunAdmissionPort {
  return unavailableAdmission;
}

export function defaultApplicationRunWorkHandoffPort(): ApplicationRunWorkHandoffPort {
  return unavailableHandoff;
}

export class RepositoryApplicationRunAdmissionPort implements ApplicationRunAdmissionPort {
  readonly #writes: RepositoryWriteClient;

  constructor(writes: RepositoryWriteClient) {
    this.#writes = writes;
  }

  admit(
    command: ApplicationRunAdmissionCommand,
    options?: ApplicationOperationOptions,
  ): Promise<RepositoryCommandResult<ApplicationRunAdmissionRecord>> {
    const dispatch = {
      providerRequest: command.providerRequest,
      providerIdempotencyKey: null,
    } as const;
    return command.operation === "start"
      ? this.#writes.admitNormalRun(
          {
            sessionId: command.sessionId,
            workspaceKey: command.workspaceKey,
            idempotencyKey: command.idempotencyKey,
            message: { contentBlocks: command.contentBlocks },
            run: { executionSnapshot: command.executionSnapshot },
            dispatch,
          },
          options,
        )
      : this.#writes.admitRetryRun(
          {
            sessionId: command.sessionId,
            workspaceKey: command.workspaceKey,
            idempotencyKey: command.idempotencyKey,
            retryOfRunId: command.retryOfRunId,
            run: { executionSnapshot: command.executionSnapshot },
            dispatch,
          },
          options,
        );
  }
}

export function createRepositoryApplicationRunAdmissionPort(
  worker: PersistenceWorkerClient,
): ApplicationRunAdmissionPort {
  return new RepositoryApplicationRunAdmissionPort(new RepositoryWriteClient(worker));
}

export class ApplicationRunAdmissionService<TAuthorizationContext> {
  readonly #reads: ApplicationRunAdmissionReadPort;
  readonly #admission: ApplicationRunAdmissionPort;
  readonly #handoff: ApplicationRunWorkHandoffPort;
  readonly #access: ApplicationRunAccessValidator<TAuthorizationContext>;
  readonly #snapshotAuthorization: (value: unknown) => TAuthorizationContext;

  constructor(options: ApplicationRunAdmissionServiceOptions<TAuthorizationContext>) {
    this.#reads = options.reads;
    this.#admission = options.admission;
    this.#handoff = options.handoff;
    this.#access = options.access;
    this.#snapshotAuthorization = options.snapshotAuthorization;
  }

  async start(
    request: ApplicationRunStartRequest<TAuthorizationContext>,
    options?: ApplicationOperationOptions,
  ): Promise<WriteResponse> {
    let input: ApplicationRunStartRequest<TAuthorizationContext>;
    let control: OperationControl;
    try {
      control = decodeOperationControl(options);
      input = decodeStartRequest(request, this.#snapshotAuthorization);
    } catch {
      return requestFailure();
    }
    const interrupted = getOperationInterruption(control);
    if (interrupted !== undefined) return operationFailureFor(interrupted);
    const denied = await this.#authorizeStart(input, control);
    if (denied !== undefined) return denied;
    const session = await this.#readSession(input.sessionId, control);
    if (!session.ok) return session.response;
    const executionSnapshot = buildStartExecutionSnapshot(session.value, input.execution);
    const command: ApplicationRunAdmissionCommand = {
      operation: "start",
      sessionId: session.value.sessionId,
      workspaceKey: session.value.workspaceKey,
      idempotencyKey: input.idempotencyKey,
      contentBlocks: input.contentBlocks,
      executionSnapshot,
      providerRequest: buildProviderRequest(input.contentBlocks, executionSnapshot),
    };
    return this.#admit(command, control);
  }

  async retry(
    request: ApplicationRunRetryRequest<TAuthorizationContext>,
    options?: ApplicationOperationOptions,
  ): Promise<WriteResponse> {
    let input: ApplicationRunRetryRequest<TAuthorizationContext>;
    let control: OperationControl;
    try {
      control = decodeOperationControl(options);
      input = decodeRetryRequest(request, this.#snapshotAuthorization);
    } catch {
      return requestFailure();
    }
    const interrupted = getOperationInterruption(control);
    if (interrupted !== undefined) return operationFailureFor(interrupted);
    const denied = await this.#authorizeRetry(input, control);
    if (denied !== undefined) return denied;
    const session = await this.#readSession(input.sessionId, control);
    if (!session.ok) return session.response;
    const source = await this.#readRetrySource(session.value, input.retryOfRunId, control);
    if (!source.ok) return source.response;
    let executionSnapshot: RunExecutionSnapshot;
    try {
      executionSnapshot = buildRetryExecutionSnapshot(
        session.value,
        source.value.executionSnapshot,
        input.executionOverrides,
      );
    } catch {
      return domainFailure(
        "reference_invalid",
        "Retry execution snapshot does not match the current Session scope.",
        false,
      );
    }
    const command: ApplicationRunAdmissionCommand = {
      operation: "retry",
      sessionId: session.value.sessionId,
      workspaceKey: session.value.workspaceKey,
      idempotencyKey: input.idempotencyKey,
      retryOfRunId: input.retryOfRunId,
      contentBlocks: source.value.contentBlocks,
      executionSnapshot,
      providerRequest: buildProviderRequest(source.value.contentBlocks, executionSnapshot),
    };
    return this.#admit(command, control);
  }

  async #authorizeStart(
    input: ApplicationRunStartRequest<TAuthorizationContext>,
    control: OperationControl,
  ): Promise<WriteFailure | undefined> {
    return this.#authorize(
      {
        operation: "start",
        access: "write",
        context: input.context,
        target: { kind: "session_run_start", sessionId: input.sessionId },
      },
      control,
    );
  }

  async #authorizeRetry(
    input: ApplicationRunRetryRequest<TAuthorizationContext>,
    control: OperationControl,
  ): Promise<WriteFailure | undefined> {
    return this.#authorize(
      {
        operation: "retry",
        access: "write",
        context: input.context,
        target: {
          kind: "session_run_retry",
          sessionId: input.sessionId,
          retryOfRunId: input.retryOfRunId,
        },
      },
      control,
    );
  }

  async #authorize(
    input: Parameters<ApplicationRunAccessValidator<TAuthorizationContext>["authorize"]>[0],
    control: OperationControl,
  ): Promise<WriteFailure | undefined> {
    const settlement = await runControlled(control, () => this.#access.authorize(input));
    if (settlement.status === "interrupted") return operationFailureFor(settlement.interruption);
    if (settlement.status === "rejected") return prePersistenceApplicationFailure();
    try {
      const decision = projectAccessDecision(settlement.value);
      return decision.allowed ? undefined : accessFailure(decision.error);
    } catch {
      return prePersistenceApplicationFailure();
    }
  }

  async #readRepository<TValue>(
    control: OperationControl,
    read: (options: ApplicationOperationOptions) => Promise<TValue>,
  ): Promise<TValue> {
    const repositoryAbort = new AbortController();
    const settlement = await runControlled(
      control,
      () => read({ signal: repositoryAbort.signal }),
      () => repositoryAbort.abort(),
    );
    if (settlement.status === "fulfilled") return settlement.value;
    if (settlement.status === "rejected") throw settlement.error;
    throw new ApplicationRunOperationInterrupted(
      settlement.started
        ? persistenceInterruptionFailure(settlement.interruption, "none")
        : operationFailureFor(settlement.interruption),
    );
  }

  async #readSession(
    sessionId: string,
    control: OperationControl,
  ): Promise<Readonly<{ ok: true; value: SessionAdmissionContext }> | Readonly<{ ok: false; response: WriteFailure }>> {
    try {
      const projected = await this.#readRepository(control, (options) =>
        this.#reads.sessionGet({ sessionId }, options),
      );
      const outer = projectionRecord(projected);
      const session = projectionRecord(readDataProperty(outer, "session"));
      const execution = projectionRecord(readDataProperty(outer, "execution"));
      const projectedSessionId = boundedString(readDataProperty(session, "id"));
      if (projectedSessionId !== sessionId) throw new TypeError("Session identity mismatch.");
      const directoriesState = readDataProperty(session, "allowedAdditionalDirectoriesState");
      const directoriesByteLength = nonNegativeInteger(
        readDataProperty(session, "allowedAdditionalDirectoriesByteLength"),
      );
      const directoriesValue =
        directoriesState === "inline"
          ? snapshotStringArray(readDataProperty(session, "allowedAdditionalDirectories"))
          : directoriesState === "chunked"
            ? await this.#readJsonChunks(
                (offset, maxBytes, options) =>
                  this.#reads.sessionDirectoriesChunk({ sessionId, offset, maxBytes }, options),
                ALLOWED_ADDITIONAL_DIRECTORIES_LIMITS.maxJsonBytes,
                control,
                { sessionId },
                directoriesByteLength,
              )
            : undefined;
      const directories = snapshotStringArray(directoriesValue);
      const normalizedDirectories = normalizeAllowedAdditionalDirectories(directories);
      if (normalizedDirectories === undefined) throw new TypeError("Session directories are invalid.");
      const activeRunIdValue = optionalBoundedString(readOptionalDataProperty(execution, "activeRunId"));
      const lifecycleStatus = readDataProperty(session, "lifecycleStatus");
      if (lifecycleStatus !== "active" && lifecycleStatus !== "archived" && lifecycleStatus !== "closed") {
        throw new TypeError("Session lifecycle is invalid.");
      }
      const workspaceKey = boundedString(readDataProperty(session, "workspaceKey"));
      const workspace = workspaceIdentity(readDataProperty(session, "workspacePath"), workspaceKey);
      return {
        ok: true,
        value: {
          sessionId,
          providerId: boundedString(readDataProperty(session, "providerId")),
          workspaceKey: workspace.workspaceKey,
          workspacePath: workspace.workspacePath,
          allowedAdditionalDirectories: normalizedDirectories,
          lifecycleStatus,
          ...(activeRunIdValue === undefined ? {} : { activeRunId: activeRunIdValue }),
        },
      };
    } catch (error) {
      return { ok: false, response: mapReadFailure(error) };
    }
  }

  async #readRetrySource(
    session: SessionAdmissionContext,
    retryOfRunId: string,
    control: OperationControl,
  ): Promise<Readonly<{ ok: true; value: RetrySourceContext }> | Readonly<{ ok: false; response: WriteFailure }>> {
    try {
      const projected = await this.#readRepository(control, (options) =>
        this.#reads.runGet(
          { sessionId: session.sessionId, runId: retryOfRunId, workspaceKey: session.workspaceKey },
          options,
        ),
      );
      const outer = projectionRecord(projected);
      if (
        boundedString(readDataProperty(outer, "sessionId")) !== session.sessionId ||
        boundedString(readDataProperty(outer, "workspaceKey")) !== session.workspaceKey
      ) {
        throw new TypeError("Retry source scope mismatch.");
      }
      const run = projectionRecord(readDataProperty(outer, "run"));
      if (
        boundedString(readDataProperty(run, "id")) !== retryOfRunId ||
        boundedString(readDataProperty(run, "sessionId")) !== session.sessionId
      ) {
        throw new TypeError("Retry source identity mismatch.");
      }
      const phase = readDataProperty(run, "phase");
      if (phase !== "completed" && phase !== "failed" && phase !== "canceled" && phase !== "interrupted") {
        return {
          ok: false,
          response: domainFailure("lifecycle_conflict", "Retry source Run must be terminal.", false),
        };
      }
      const initiatingMessageId = boundedString(readDataProperty(run, "initiatingMessageId"));
      const contentJson = await this.#readJsonChunks(
        (offset, maxBytes, options) =>
          this.#reads.messageContentChunk(
            {
              sessionId: session.sessionId,
              messageId: initiatingMessageId,
              workspaceKey: session.workspaceKey,
              offset,
              maxBytes,
            },
            options,
          ),
        MESSAGE_CONTENT_LIMITS.maxJsonBytes,
        control,
        { sessionId: session.sessionId, messageId: initiatingMessageId },
      );
      const contentBlocks = snapshotMessageContentBlocks(contentJson);
      if (contentBlocks === undefined) throw new TypeError("Retry Message content is invalid.");
      const snapshotState = readDataProperty(run, "executionSnapshotState");
      const snapshotByteLength = nonNegativeInteger(readDataProperty(run, "executionSnapshotByteLength"));
      const snapshotValue =
        snapshotState === "inline"
          ? readDataProperty(run, "executionSnapshot")
          : snapshotState === "chunked"
            ? await this.#readJsonChunks(
                (offset, maxBytes, options) =>
                  this.#reads.runSnapshotChunk(
                    {
                      sessionId: session.sessionId,
                      runId: retryOfRunId,
                      workspaceKey: session.workspaceKey,
                      offset,
                      maxBytes,
                    },
                    options,
                  ),
                APPLICATION_RUN_PAYLOAD_LIMITS.executionSnapshotMaxJsonBytes,
                control,
                { sessionId: session.sessionId, runId: retryOfRunId },
                snapshotByteLength,
              )
            : undefined;
      return {
        ok: true,
        value: {
          retryOfRunId,
          initiatingMessageId,
          contentBlocks,
          executionSnapshot: decodeApplicationRunExecutionSnapshot(snapshotValue),
        },
      };
    } catch (error) {
      return { ok: false, response: mapReadFailure(error) };
    }
  }

  async #readJsonChunks(
    read: (offset: number, maxBytes: number, options: ApplicationOperationOptions) => Promise<unknown>,
    maxTotalBytes: number,
    control: OperationControl,
    expectedScope: Readonly<Record<string, string>>,
    expectedTotalBytes?: number,
  ): Promise<unknown> {
    const chunks: Uint8Array[] = [];
    let offset = 0;
    let totalBytes: number | undefined;
    while (totalBytes === undefined || offset < totalBytes) {
      const projected = projectionRecord(
        await this.#readRepository(control, (options) =>
          read(offset, Math.min(256 * 1024, maxTotalBytes - offset), options),
        ),
      );
      for (const [key, expectedValue] of Object.entries(expectedScope)) {
        if (boundedString(readDataProperty(projected, key)) !== expectedValue) {
          throw new TypeError("Chunk scope is invalid.");
        }
      }
      const chunkOffset = nonNegativeInteger(readDataProperty(projected, "offset"));
      const chunkTotal = nonNegativeInteger(readDataProperty(projected, "totalBytes"));
      const eof = readDataProperty(projected, "eof");
      const bytesValue = readDataProperty(projected, "bytes");
      if (
        chunkOffset !== offset ||
        chunkTotal > maxTotalBytes ||
        (expectedTotalBytes !== undefined && chunkTotal !== expectedTotalBytes) ||
        typeof eof !== "boolean"
      ) {
        throw new TypeError("Chunk projection is invalid.");
      }
      if (totalBytes !== undefined && totalBytes !== chunkTotal) throw new TypeError("Chunk total changed.");
      totalBytes = chunkTotal;
      const bytes = toUint8Array(bytesValue);
      if (bytes.byteLength === 0 && offset < totalBytes) throw new TypeError("Chunk did not advance.");
      if (offset + bytes.byteLength > totalBytes || eof !== (offset + bytes.byteLength === totalBytes)) {
        throw new TypeError("Chunk boundary is invalid.");
      }
      chunks.push(bytes);
      offset += bytes.byteLength;
      if (eof) break;
    }
    if (totalBytes === undefined || offset !== totalBytes) throw new TypeError("Chunk stream is incomplete.");
    const combined = new Uint8Array(totalBytes);
    let writeOffset = 0;
    for (const chunk of chunks) {
      combined.set(chunk, writeOffset);
      writeOffset += chunk.byteLength;
    }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(combined)) as unknown;
  }

  async #admit(command: ApplicationRunAdmissionCommand, control: OperationControl): Promise<WriteResponse> {
    const interruption = getOperationInterruption(control);
    if (interruption !== undefined) return operationFailureFor(interruption);
    const repositoryAbort = new AbortController();
    const settlement = await runControlled(
      control,
      () => this.#admission.admit(command, { signal: repositoryAbort.signal }),
      () => repositoryAbort.abort(),
      true,
    );
    if (settlement.status === "interrupted") {
      return settlement.started
        ? persistenceInterruptionFailure(settlement.interruption, "unknown")
        : operationFailureFor(settlement.interruption);
    }
    if (settlement.status === "rejected") return mapWriteFailure(settlement.error);
    try {
      const result = settlement.value;
      if (!result.ok) return domainFailureFromRepository(result.error);
      if (typeof result.replayed !== "boolean") {
        throw new TypeError("Run admission replay state is invalid.");
      }
      const record = projectAdmissionRecord(result.value, command);
      if (!result.replayed && record.runPhase !== "queued") {
        throw new TypeError("A fresh Run admission must remain queued.");
      }
      if (
        isSafePendingDispatchPhase(record.runPhase) &&
        record.dispatchState === "pending" &&
        (record.bindingState === "active" || (record.bindingState === "creating" && !result.replayed))
      ) {
        try {
          this.#handoff.handoff(record);
        } catch {
          // Admission is already durable. A failed in-memory handoff leaves the Run as a safe pending recovery candidate.
        }
      }
      return {
        overallStatus: "success",
        value: {
          sessionId: record.sessionId,
          runId: record.runId,
          ...(record.retryOfRunId === undefined ? {} : { retryOfRunId: record.retryOfRunId }),
          phase: record.runPhase,
        },
        persistence: { status: "committed", effect: "none", replayed: result.replayed },
      };
    } catch (error) {
      return persistenceApplicationFailure("unknown");
    }
  }
}

export function buildStartExecutionSnapshot(
  session: SessionAdmissionContext,
  execution: ApplicationRunExecutionSettings,
): RunExecutionSnapshot {
  return Object.freeze({
    providerId: session.providerId,
    model: execution.model,
    modelSelection: "explicit",
    reasoning: Object.freeze({ effort: execution.reasoningEffort }),
    approval: Object.freeze({ policy: "never" }),
    sandbox: freezeSandbox(execution.sandbox),
    workspace: Object.freeze({
      key: session.workspaceKey,
      path: session.workspacePath,
      allowedAdditionalDirectories: Object.freeze([...session.allowedAdditionalDirectories]),
    }),
    character: null,
  });
}

export function buildRetryExecutionSnapshot(
  session: SessionAdmissionContext,
  source: RunExecutionSnapshot,
  overrides: ApplicationRunExecutionOverrides | undefined,
): RunExecutionSnapshot {
  const decoded = decodeApplicationRunExecutionSnapshot(source);
  const sourceWorkspace = projectionRecord(decoded.workspace);
  if (
    decoded.providerId !== session.providerId ||
    boundedString(readDataProperty(sourceWorkspace, "key")) !== session.workspaceKey ||
    workspacePath(readDataProperty(sourceWorkspace, "path")) !== session.workspacePath
  ) {
    throw new TypeError("Retry execution snapshot scope is stale.");
  }
  const reasoning = projectionRecord(decoded.reasoning);
  const sourceSandbox = decodeSandbox(decoded.sandbox);
  return Object.freeze({
    ...buildStartExecutionSnapshot(session, {
      model: overrides?.model ?? decoded.model,
      reasoningEffort: overrides?.reasoningEffort ?? boundedString(readDataProperty(reasoning, "effort")),
      sandbox: overrides?.sandbox ?? sourceSandbox,
    }),
    modelSelection: overrides?.model === undefined ? "inherited" : "explicit",
  });
}

export function buildProviderRequest(
  contentBlocks: readonly TextContentBlock[],
  executionSnapshot: RunExecutionSnapshot,
): ApplicationRunProviderRequest {
  return buildApplicationRunProviderRequest(contentBlocks, executionSnapshot);
}

function decodeStartRequest<TAuthorizationContext>(
  value: unknown,
  snapshotAuthorization: (value: unknown) => TAuthorizationContext,
): ApplicationRunStartRequest<TAuthorizationContext> {
  assertProxyFree(value);
  const request = exactRecord(value, ["context", "sessionId", "idempotencyKey", "contentBlocks", "execution"]);
  const contentBlocks = snapshotMessageContentBlocks(readDataProperty(request, "contentBlocks"));
  if (contentBlocks === undefined) throw new TypeError("Message content is invalid.");
  return {
    context: decodeContext(readDataProperty(request, "context"), snapshotAuthorization),
    sessionId: boundedString(readDataProperty(request, "sessionId")),
    idempotencyKey: canonicalIdempotencyKey(readDataProperty(request, "idempotencyKey")),
    contentBlocks,
    execution: decodeExecutionSettings(readDataProperty(request, "execution")),
  };
}

function decodeRetryRequest<TAuthorizationContext>(
  value: unknown,
  snapshotAuthorization: (value: unknown) => TAuthorizationContext,
): ApplicationRunRetryRequest<TAuthorizationContext> {
  assertProxyFree(value);
  const request = exactRecord(value, ["context", "sessionId", "retryOfRunId", "idempotencyKey", "executionOverrides"]);
  const overridesValue = readOptionalDataProperty(request, "executionOverrides");
  return {
    context: decodeContext(readDataProperty(request, "context"), snapshotAuthorization),
    sessionId: boundedString(readDataProperty(request, "sessionId")),
    retryOfRunId: boundedString(readDataProperty(request, "retryOfRunId")),
    idempotencyKey: canonicalIdempotencyKey(readDataProperty(request, "idempotencyKey")),
    ...(overridesValue === undefined ? {} : { executionOverrides: decodeExecutionOverrides(overridesValue) }),
  };
}

function decodeContext<TAuthorizationContext>(
  value: unknown,
  snapshotAuthorization: (value: unknown) => TAuthorizationContext,
) {
  const context = exactRecord(value, ["authorization"]);
  return { authorization: snapshotAuthorization(readDataProperty(context, "authorization")) } as const;
}

function decodeExecutionSettings(value: unknown): ApplicationRunExecutionSettings {
  const execution = exactRecord(value, ["model", "reasoningEffort", "sandbox"]);
  return {
    model: executionString(readDataProperty(execution, "model")),
    reasoningEffort: executionString(readDataProperty(execution, "reasoningEffort")),
    sandbox: decodeSandbox(readDataProperty(execution, "sandbox")),
  };
}

function decodeExecutionOverrides(value: unknown): ApplicationRunExecutionOverrides {
  const overrides = exactRecord(value, ["model", "reasoningEffort", "sandbox"]);
  const model = readOptionalDataProperty(overrides, "model");
  const reasoningEffort = readOptionalDataProperty(overrides, "reasoningEffort");
  const sandbox = readOptionalDataProperty(overrides, "sandbox");
  return {
    ...(model === undefined ? {} : { model: executionString(model) }),
    ...(reasoningEffort === undefined ? {} : { reasoningEffort: executionString(reasoningEffort) }),
    ...(sandbox === undefined ? {} : { sandbox: decodeSandbox(sandbox) }),
  };
}

export function decodeApplicationRunExecutionSnapshot(value: unknown): RunExecutionSnapshot {
  const snapshot = exactRecord(value, [
    "providerId",
    "model",
    "modelSelection",
    "reasoning",
    "approval",
    "sandbox",
    "workspace",
    "character",
  ]);
  const reasoning = exactRecord(readDataProperty(snapshot, "reasoning"), ["effort"]);
  const approval = exactRecord(readDataProperty(snapshot, "approval"), ["policy"]);
  const workspace = exactRecord(readDataProperty(snapshot, "workspace"), [
    "key",
    "path",
    "allowedAdditionalDirectories",
  ]);
  if (readDataProperty(approval, "policy") !== "never" || readDataProperty(snapshot, "character") !== null) {
    throw new TypeError("Execution snapshot policy is invalid.");
  }
  const modelSelection = readDataProperty(snapshot, "modelSelection");
  if (modelSelection !== "explicit" && modelSelection !== "inherited") {
    throw new TypeError("Execution snapshot model selection is invalid.");
  }
  const workspaceKey = boundedString(readDataProperty(workspace, "key"));
  const resolvedWorkspace = workspaceIdentity(readDataProperty(workspace, "path"), workspaceKey);
  return Object.freeze({
    providerId: boundedString(readDataProperty(snapshot, "providerId")),
    model: executionString(readDataProperty(snapshot, "model")),
    modelSelection,
    reasoning: Object.freeze({ effort: executionString(readDataProperty(reasoning, "effort")) }),
    approval: Object.freeze({ policy: "never" }),
    sandbox: freezeSandbox(decodeSandbox(readDataProperty(snapshot, "sandbox"))),
    workspace: Object.freeze({
      key: resolvedWorkspace.workspaceKey,
      path: resolvedWorkspace.workspacePath,
      allowedAdditionalDirectories: Object.freeze(
        snapshotStringArray(readDataProperty(workspace, "allowedAdditionalDirectories")),
      ),
    }),
    character: null,
  });
}

function decodeSandbox(value: unknown): ApplicationRunSandboxSetting {
  const sandbox = exactRecord(value, ["mode", "networkAccess"]);
  const mode = readDataProperty(sandbox, "mode");
  const networkAccess = readOptionalDataProperty(sandbox, "networkAccess");
  if (mode === "danger-full-access" && networkAccess === undefined) return { mode };
  if ((mode === "read-only" || mode === "workspace-write") && typeof networkAccess === "boolean") {
    return { mode, networkAccess };
  }
  throw new TypeError("Sandbox setting is invalid.");
}

function freezeSandbox(value: ApplicationRunSandboxSetting): RepositoryJsonValue {
  return value.mode === "danger-full-access"
    ? Object.freeze({ mode: value.mode })
    : Object.freeze({ mode: value.mode, networkAccess: value.networkAccess });
}

function isSafePendingDispatchPhase(value: ApplicationRunPhase): boolean {
  return value === "queued" || value === "starting";
}

function isRunPhase(value: unknown): value is ApplicationRunPhase {
  return (
    value === "queued" ||
    value === "starting" ||
    value === "active" ||
    value === "canceling" ||
    value === "finalizing" ||
    value === "completed" ||
    value === "failed" ||
    value === "canceled" ||
    value === "interrupted"
  );
}

function projectAdmissionRecord(
  value: unknown,
  command: ApplicationRunAdmissionCommand,
): ApplicationRunAdmissionRecord {
  const record = projectionRecord(value);
  const sessionId = boundedString(readDataProperty(record, "sessionId"));
  if (sessionId !== command.sessionId) throw new TypeError("Admission Session mismatch.");
  const retryOfRunId = optionalBoundedString(readOptionalDataProperty(record, "retryOfRunId"));
  if (
    (command.operation === "start" && retryOfRunId !== undefined) ||
    (command.operation === "retry" && retryOfRunId !== command.retryOfRunId)
  ) {
    throw new TypeError("Admission retry relation mismatch.");
  }
  const bindingState = readDataProperty(record, "bindingState");
  if (
    bindingState !== "creating" &&
    bindingState !== "active" &&
    bindingState !== "invalidated" &&
    bindingState !== "superseded"
  ) {
    throw new TypeError("Binding state is invalid.");
  }
  const dispatchState = readDataProperty(record, "dispatchState");
  if (
    dispatchState !== "pending" &&
    dispatchState !== "dispatching" &&
    dispatchState !== "accepted" &&
    dispatchState !== "rejected" &&
    dispatchState !== "ambiguous" &&
    dispatchState !== "aborted"
  ) {
    throw new TypeError("Dispatch state is invalid.");
  }
  const runPhase = readDataProperty(record, "runPhase");
  if (!isRunPhase(runPhase)) throw new TypeError("Run phase is invalid.");
  return {
    sessionId,
    messageId: boundedString(readDataProperty(record, "messageId")),
    runId: boundedString(readDataProperty(record, "runId")),
    ...(retryOfRunId === undefined ? {} : { retryOfRunId }),
    attemptId: boundedString(readDataProperty(record, "attemptId")),
    bindingId: boundedString(readDataProperty(record, "bindingId")),
    runPhase,
    bindingState,
    dispatchState,
    admittedAt: nonNegativeInteger(readDataProperty(record, "admittedAt")),
  };
}

function decodeOperationControl(value: unknown): OperationControl {
  if (value === undefined) return {};
  const options = exactRecord(value, ["timeoutMs", "signal"]);
  const timeoutMs = readOptionalDataProperty(options, "timeoutMs");
  const signal = readOptionalDataProperty(options, "signal");
  if (
    (timeoutMs !== undefined && (!Number.isSafeInteger(timeoutMs) || (timeoutMs as number) < 1)) ||
    (signal !== undefined && !(signal instanceof AbortSignal))
  ) {
    throw new TypeError("Operation options are invalid.");
  }
  return {
    ...(timeoutMs === undefined ? {} : { deadlineAt: Date.now() + (timeoutMs as number) }),
    ...(signal === undefined ? {} : { signal }),
  };
}

async function runControlled<TValue>(
  control: OperationControl,
  start: () => Promise<TValue>,
  interruptStartedWork?: () => void,
  fulfilledWorkOwnsResult: boolean = false,
): Promise<ControlledSettlement<TValue>> {
  const beforeStart = getOperationInterruption(control);
  if (beforeStart !== undefined) return { status: "interrupted", interruption: beforeStart, started: false };
  let work: Promise<TValue>;
  try {
    work = Promise.resolve(start());
  } catch (error) {
    const interruption = getOperationInterruption(control);
    if (interruption === undefined) return { status: "rejected", error };
    try {
      interruptStartedWork?.();
    } catch {
      // The operation result is owned by the deadline/cancellation, not an adapter abort hook.
    }
    return { status: "interrupted", interruption, started: true };
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
    const interrupt = (interruption: OperationInterruption) => {
      if (settled) return;
      try {
        interruptStartedWork?.();
      } catch {
        // The operation result is owned by the deadline/cancellation, not an adapter abort hook.
      }
      finish({ status: "interrupted", interruption, started: true });
    };
    const onAbort = () => interrupt("canceled");
    work.then(
      (value) => {
        if (fulfilledWorkOwnsResult) {
          finish({ status: "fulfilled", value });
          return;
        }
        const interruption = getOperationInterruption(control);
        if (interruption === undefined) finish({ status: "fulfilled", value });
        else interrupt(interruption);
      },
      (error: unknown) => {
        const interruption = getOperationInterruption(control);
        if (interruption === undefined) finish({ status: "rejected", error });
        else interrupt(interruption);
      },
    );
    const remaining = getRemainingTimeout(control);
    if (remaining !== undefined) timer = setTimeout(() => interrupt("timeout"), remaining);
    control.signal?.addEventListener("abort", onAbort, { once: true });
    if (control.signal?.aborted) onAbort();
  });
}

function getOperationInterruption(control: OperationControl): OperationInterruption | undefined {
  if (control.signal?.aborted) return "canceled";
  if (control.deadlineAt !== undefined && control.deadlineAt <= Date.now()) return "timeout";
  return undefined;
}

function getRemainingTimeout(control: OperationControl): number | undefined {
  return control.deadlineAt === undefined ? undefined : Math.max(0, control.deadlineAt - Date.now());
}

function operationFailureFor(interruption: OperationInterruption): WriteFailure {
  return operationFailure(interruption === "timeout" ? "operation_timeout" : "operation_canceled");
}

function projectAccessDecision(value: unknown): ApplicationAccessDecision {
  const decision = projectionRecord(value);
  const allowed = readDataProperty(decision, "allowed");
  if (allowed === true) return { allowed: true };
  if (allowed !== false) throw new TypeError("Access decision is invalid.");
  const error = projectionRecord(readDataProperty(decision, "error"));
  const code = readDataProperty(error, "code");
  if (
    code !== "workspace_invalid" &&
    code !== "workspace_unavailable" &&
    code !== "authorization_invalid" &&
    code !== "forbidden"
  ) {
    throw new TypeError("Access error is invalid.");
  }
  const message = boundedString(readDataProperty(error, "message"), 4_096);
  const retryable = readDataProperty(error, "retryable");
  if (typeof retryable !== "boolean") throw new TypeError("Access error is invalid.");
  return { allowed: false, error: { code, message, retryable } };
}

function domainFailureFromRepository(error: RepositoryCommandError): WriteFailure {
  if (error.code === "capacity_exceeded") {
    return {
      overallStatus: "failure",
      error: {
        kind: "domain",
        code: error.code,
        message: error.message,
        retryable: true,
        details: projectCapacityExceededDetails(error.details),
      },
      persistence: { status: "rejected", effect: "none" },
    };
  }
  return domainFailure(error.code, error.message, error.retryable);
}

function projectCapacityExceededDetails(
  details: Extract<RepositoryCommandError, Readonly<{ code: "capacity_exceeded" }>>["details"],
): ApplicationCapacityExceededDetails {
  if (details.scope === "application" || details.scope === "provider") {
    return { scope: details.scope, current: details.current, limit: details.limit };
  }
  throw new TypeError("Run admission capacity scope is invalid.");
}

function domainFailure(
  code: Exclude<
    ApplicationDomainError["code"],
    "capacity_exceeded" | "payload_unavailable" | "payload_format_unsupported"
  >,
  message: string,
  retryable: boolean,
): WriteFailure {
  return {
    overallStatus: "failure",
    error: { kind: "domain", code, message, retryable },
    persistence: { status: "rejected", effect: "none" },
  };
}

function mapReadFailure(error: unknown): WriteFailure {
  if (error instanceof ApplicationRunOperationInterrupted) return error.response;
  if (error instanceof PersistenceClientError) {
    const persistenceError = error.persistenceError;
    if (
      persistenceError.code === "not_found" ||
      persistenceError.code === "request_invalid" ||
      persistenceError.code === "cursor_invalid"
    ) {
      return domainFailure(persistenceError.code, persistenceError.message, persistenceError.retryable);
    }
    return persistenceFailure(persistenceError, "none");
  }
  return persistenceApplicationFailure("none");
}

function mapWriteFailure(error: unknown): WriteFailure {
  if (error instanceof PersistenceClientError) {
    return persistenceFailure(error.persistenceError, error.persistenceError.effect);
  }
  return persistenceApplicationFailure("unknown");
}

function persistenceFailure(error: PersistenceError, effect: "none" | "unknown"): WriteFailure {
  const mappedCode = mapPersistenceErrorCode(error.code);
  return effect === "unknown"
    ? {
        overallStatus: "failure",
        error: {
          kind: "persistence",
          code: mappedCode,
          message: error.message,
          retryable: error.retryable,
          effect,
        },
        persistence: { status: "failed", effect, reconciliation: "exact_request_required" },
      }
    : {
        overallStatus: "failure",
        error: {
          kind: "persistence",
          code: mappedCode,
          message: error.message,
          retryable: error.retryable,
          effect,
        },
        persistence: { status: "failed", effect },
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
    case "database_schema_verification_failed":
    case "database_integrity_check_failed":
      return "persistence_integrity_failed" as const;
    case "response_too_large":
      return "persistence_response_too_large" as const;
    default:
      return "persistence_operation_failed" as const;
  }
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

function operationFailure(code: "operation_timeout" | "operation_canceled"): WriteFailure {
  return {
    overallStatus: "failure",
    error:
      code === "operation_timeout"
        ? {
            kind: "operation",
            code,
            message: "Application operation timed out.",
            retryable: true,
          }
        : {
            kind: "operation",
            code,
            message: "Application operation was canceled.",
            retryable: false,
          },
    persistence: { status: "not_attempted", effect: "none" },
  };
}

function persistenceInterruptionFailure(interruption: OperationInterruption, effect: "none" | "unknown"): WriteFailure {
  const code = interruption === "timeout" ? "persistence_timeout" : "persistence_canceled";
  const message =
    interruption === "timeout" ? "Application operation timed out." : "Application operation was canceled.";
  return effect === "unknown"
    ? {
        overallStatus: "failure",
        error: {
          kind: "persistence",
          code,
          message,
          retryable: interruption === "timeout",
          effect,
        },
        persistence: { status: "failed", effect, reconciliation: "exact_request_required" },
      }
    : {
        overallStatus: "failure",
        error: {
          kind: "persistence",
          code,
          message,
          retryable: interruption === "timeout",
          effect,
        },
        persistence: { status: "failed", effect },
      };
}

function prePersistenceApplicationFailure(): WriteFailure {
  return {
    overallStatus: "failure",
    error: {
      kind: "application",
      code: "internal_error",
      message: "Application Service could not complete the operation.",
      retryable: false,
    },
    persistence: { status: "not_attempted", effect: "none" },
  };
}

function persistenceApplicationFailure(effect: "none" | "unknown"): WriteFailure {
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
    : persistenceFailure(
        {
          code: "internal_error",
          message: "Application Service could not complete the operation.",
          retryable: false,
          effect,
        },
        effect,
      );
}

function exactRecord(value: unknown, allowedKeys: readonly string[]): Readonly<Record<string, unknown>> {
  if (!isPlainRecord(value)) throw new TypeError("Record is invalid.");
  const allowed = new Set(allowedKeys);
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== "string" || !allowed.has(key))) throw new TypeError("Record keys are invalid.");
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
      throw new TypeError("Record property is invalid.");
    }
  }
  return value;
}

function projectionRecord(value: unknown): Readonly<Record<string, unknown>> {
  if (!isPlainRecord(value)) throw new TypeError("Projection is invalid.");
  return value;
}

function readDataProperty(record: Readonly<Record<string, unknown>>, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  if (descriptor === undefined || !("value" in descriptor)) throw new TypeError("Property is invalid.");
  return descriptor.value;
}

function readOptionalDataProperty(record: Readonly<Record<string, unknown>>, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  if (descriptor === undefined) return undefined;
  if (!("value" in descriptor)) throw new TypeError("Property is invalid.");
  return descriptor.value;
}

function isPlainRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value) || nodeTypes.isProxy(value)) return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

function snapshotStringArray(value: unknown): readonly string[] {
  if (!Array.isArray(value) || nodeTypes.isProxy(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    throw new TypeError("String array is invalid.");
  }
  const keys = Reflect.ownKeys(value);
  if (
    keys.some(
      (key) =>
        typeof key !== "string" ||
        (key !== "length" &&
          (!isCanonicalArrayIndex(key) || Number(key) >= value.length || !Object.hasOwn(value, key))),
    )
  ) {
    throw new TypeError("String array is invalid.");
  }
  const result: string[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (
      descriptor === undefined ||
      !descriptor.enumerable ||
      !("value" in descriptor) ||
      typeof descriptor.value !== "string"
    ) {
      throw new TypeError("String array is invalid.");
    }
    result.push(descriptor.value);
  }
  return Object.freeze(result);
}

function assertProxyFree(value: unknown): void {
  const seen = new WeakSet<object>();
  let objectCount = 0;
  const visit = (candidate: unknown): void => {
    if (typeof candidate !== "object" || candidate === null) return;
    if (nodeTypes.isProxy(candidate)) throw new TypeError("Proxy-backed request values are invalid.");
    if (seen.has(candidate)) return;
    seen.add(candidate);
    objectCount += 1;
    if (objectCount > 50_000) throw new TypeError("Request object graph is too large.");
    for (const key of Reflect.ownKeys(candidate)) {
      const descriptor = Object.getOwnPropertyDescriptor(candidate, key);
      if (descriptor !== undefined && "value" in descriptor) visit(descriptor.value);
    }
  };
  visit(value);
}

function isCanonicalArrayIndex(value: string): boolean {
  if (value === "") return false;
  const index = Number(value);
  return Number.isSafeInteger(index) && index >= 0 && String(index) === value;
}

function toUint8Array(value: unknown): Uint8Array {
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  throw new TypeError("Chunk bytes are invalid.");
}

function boundedString(value: unknown, maxLength: number = APPLICATION_RUN_LIMITS.maxIdentifierLength): string {
  if (typeof value !== "string" || value.length < 1 || value.length > maxLength) {
    throw new TypeError("String is invalid.");
  }
  return value;
}

function optionalBoundedString(value: unknown): string | undefined {
  return value === undefined ? undefined : boundedString(value);
}

function executionString(value: unknown): string {
  return boundedString(value, APPLICATION_RUN_LIMITS.maxExecutionSettingLength);
}

function workspacePath(value: unknown): string {
  if (typeof value !== "string") throw new TypeError("Workspace path is invalid.");
  const resolved = resolveWorkspaceIdentity(value);
  if (resolved === undefined || resolved.workspacePath !== value) throw new TypeError("Workspace path is invalid.");
  return resolved.workspacePath;
}

function workspaceIdentity(
  value: unknown,
  expectedWorkspaceKey: string,
): Readonly<{ workspacePath: string; workspaceKey: string }> {
  if (typeof value !== "string") throw new TypeError("Workspace path is invalid.");
  const resolved = resolveWorkspaceIdentity(value);
  if (resolved === undefined || resolved.workspacePath !== value || resolved.workspaceKey !== expectedWorkspaceKey) {
    throw new TypeError("Workspace identity is invalid.");
  }
  return Object.freeze(resolved);
}

function canonicalIdempotencyKey(value: unknown): string {
  if (!isCanonicalUuid(value)) throw new TypeError("Idempotency key is invalid.");
  return value;
}

function nonNegativeInteger(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new TypeError("Integer is invalid.");
  }
  return value;
}

class ApplicationRunOperationInterrupted extends Error {
  readonly response: WriteFailure;

  constructor(response: WriteFailure) {
    super("Application Run operation was interrupted.");
    this.response = response;
  }
}
