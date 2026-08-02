import { randomUUID } from "node:crypto";

import { resolveWorkspaceIdentity } from "../../../shared/workspace-path.js";
import {
  CODEX_ADAPTER_LIMITS,
  CODEX_ADAPTER_SCHEMA_BASELINE,
  type CodexAdapterCapabilityPreflightInput,
  type CodexAdapterCapabilityPreflightResult,
  type CodexAdapterConnectionFailureCode,
  type CodexAdapterInterruptAcknowledgement,
  type CodexAdapterInteractionHandle,
  type CodexAdapterInteractionResponse,
  type CodexAdapterInteractionResponseReservation,
  type CodexAdapterInteractionResponseReserveResult,
  type CodexAdapterInteractionResponseResult,
  type CodexAdapterDiagnostic,
  type CodexAdapterEvent,
  type CodexAdapterModel,
  type CodexAdapterModelCatalog,
  type CodexAdapterMutationResult,
  type CodexAdapterMutationNotSentCode,
  type CodexAdapterNotSentCode,
  type CodexAdapterOptions,
  type CodexAdapterReadResult,
  type CodexAdapterReadThreadSnapshot,
  type CodexAdapterRequestOptions,
  type CodexAdapterSandboxPolicy,
  type CodexAdapterServerRequestPort,
  type CodexAdapterSteerAcknowledgement,
  type CodexAdapterThreadSnapshot,
  type CodexAdapterTransportEvent,
  type CodexAdapterTransportPort,
  type CodexAdapterTurnSnapshot,
  type CodexInterruptTurnInput,
  type CodexListModelsInput,
  type CodexReadThreadInput,
  type CodexResumeThreadInput,
  type CodexStartThreadInput,
  type CodexStartTurnInput,
  type CodexSteerTurnInput,
} from "./codex-adapter-contract.js";
import { CodexAdapterInteractionManager } from "./codex-adapter-interactions.js";
import {
  decodeModelListResponse,
  decodeThreadReadResponse,
  decodeThreadResumeResponse,
  decodeThreadStartResponse,
  decodeTurnInterruptResponse,
  decodeTurnStartResponse,
  decodeTurnSteerResponse,
  classifyCodexNotification,
  snapshotAdapterOptions,
  snapshotAdapterRequestOptions,
  snapshotInterruptTurnInput,
  snapshotListModelsInput,
  snapshotReadThreadInput,
  snapshotResumeThreadInput,
  snapshotStartThreadInput,
  snapshotStartTurnInput,
  snapshotSteerTurnInput,
  toAdapterThreadStatus,
  toAdapterTurnStatus,
  type CodexValidatedNotification,
  type CodexValidatedThreadOperationResponse,
  type CodexValidatedTokenUsage,
} from "./codex-adapter-validation.js";
import { CodexAdapterItemMapper, type CodexItemMapperResult } from "./codex-adapter-items.js";
import {
  CodexAdapterLifecycle,
  type CodexLifecycleResult,
  type CodexThreadLifecycleIdentity,
} from "./codex-adapter-lifecycle.js";
import type {
  CodexConnectionFailureCode,
  CodexRequestNotSentCode,
  CodexResponseUnknownCode,
  CodexTransportFailure,
} from "./transport-error.js";
import { CodexTransportError } from "./transport-error.js";

const DEFAULT_MODEL_PAGE_SIZE = 100;
const REQUEST_NOT_SENT_CODES: ReadonlySet<unknown> = new Set([
  "not_ready",
  "closing",
  "timeout",
  "aborted",
  "pending_limit",
  "invalid_request",
  "write_rejected",
  "server_request_settled",
  "event_waiter_exists",
]);
const RESPONSE_UNKNOWN_CODES: ReadonlySet<unknown> = new Set(["timeout", "aborted", "connection_lost", "write_failed"]);
const CONNECTION_FAILURE_CODES: ReadonlySet<unknown> = new Set([
  "handshake_invalid",
  "handshake_write_failed",
  "event_queue_overflow",
  "server_request_limit",
  "duplicate_server_request",
  "spawn_failed",
  "process_exited",
  "stdin_failed",
  "stdout_failed",
  "stderr_failed",
  "protocol_failed",
  "close_failed",
]);

type PendingThreadMutation = {
  readonly kind: "start" | "resume";
  readonly threadId?: string;
  readonly prospective: boolean;
  sideEffectObserved: boolean;
  observedThreadId: string | undefined;
  observedCorrelationUnresolved: boolean;
  observedThreadConflict: boolean;
};

type ModelCapabilityFailure =
  | Exclude<CodexAdapterReadResult<CodexAdapterModelCatalog>, Readonly<{ kind: "accepted" }>>
  | Readonly<{
      kind: "connection_failure";
      effect: "none";
      code: CodexAdapterConnectionFailureCode;
    }>;

type ModelCapabilityValidation =
  | Readonly<{ kind: "valid" }>
  | Readonly<{ kind: "invalid" }>
  | Readonly<{
      kind: "unavailable";
      failure: ModelCapabilityFailure;
    }>;

type PendingTurnMutation = {
  readonly model: string;
  readonly previousModel: string;
  observedTurnId: string | undefined;
};

type ThreadContext = Readonly<{
  cliVersion: string;
  model: string;
  workspacePath: string;
  provisionalModelOwner?: PendingTurnMutation;
}>;

type PendingInterruptMutation = {
  readonly turnId: string;
  terminalStatus: "completed" | "failed" | "interrupted" | undefined;
  settled: boolean;
};

type PendingSteerMutation = {
  readonly threadId: string;
  readonly turnId: string;
  sideEffectObserved: boolean;
  observedTupleConflict: boolean;
  settled: boolean;
};

type ThreadMutationProjection = Readonly<{
  snapshot: CodexAdapterThreadSnapshot;
  identity: CodexThreadLifecycleIdentity;
  workspacePath: string;
  activeTurn: CodexAdapterTurnSnapshot | undefined;
}>;

export class CodexAdapter {
  readonly #transport: CodexAdapterTransportPort;
  readonly #cliVersion: string;
  readonly #lifecycle = new CodexAdapterLifecycle();
  readonly #items = new CodexAdapterItemMapper();
  readonly #interactions = new CodexAdapterInteractionManager();
  readonly #threadContexts = new Map<string, ThreadContext>();
  readonly #pendingThreadMutations = new Set<PendingThreadMutation>();
  readonly #pendingResumeThreads = new Map<string, PendingThreadMutation>();
  readonly #pendingTurnModels = new Map<string, PendingTurnMutation>();
  readonly #pendingInterrupts = new Map<string, PendingInterruptMutation>();
  readonly #pendingSteers = new Map<string, PendingSteerMutation>();
  readonly #ambiguousTurnThreads = new Set<string>();
  readonly #turnTokenUsage = new Map<string, Map<string, CodexValidatedTokenUsage>>();
  readonly #eventQueue: Array<Readonly<{ event: CodexAdapterEvent; textBytes: number }>> = [];
  #queuedTextBytes = 0;
  #diagnosticCount = 0;
  #diagnosticBytes = 0;
  #pendingProspectiveThreadCount = 0;
  #terminalConnectionFailureCode: CodexAdapterConnectionFailureCode | undefined;
  #pendingConnectionFailureCode: Extract<CodexAdapterEvent, { kind: "connection_failure" }>["code"] | undefined;
  #eventWaiter:
    | Readonly<{
        resolve: (event: CodexAdapterEvent) => void;
        reject: (error: Error) => void;
      }>
    | undefined;
  #state: "open" | "failed" | "closing" | "closed" = "open";
  #transportClosePromise: Promise<void> | undefined;
  #closePromise: Promise<void> | undefined;
  #modelsByRequestName: Map<string, CodexAdapterModel> | undefined;
  #modelCatalogLoadPromise: Promise<CodexAdapterReadResult<CodexAdapterModelCatalog>> | undefined;

  constructor(transport: CodexAdapterTransportPort, options: CodexAdapterOptions) {
    const snapshot = snapshotAdapterOptions(options);
    if (!snapshot.ok) throw new TypeError("Codex Adapter options are invalid.");
    this.#transport = transport;
    this.#cliVersion = snapshot.value.cliVersion;
    void this.#pumpEvents();
  }

  async listModels(
    input: CodexListModelsInput = {},
    requestOptions?: CodexAdapterRequestOptions,
  ): Promise<CodexAdapterReadResult<CodexAdapterModelCatalog>> {
    const snapshots = snapshotOperationInputs(snapshotListModelsInput(input), requestOptions);
    if (!snapshots.ok) return snapshots.result;
    if (!this.#isOperational()) return notSent("capability_unavailable");

    const models: CodexAdapterModel[] = [];
    const modelIds = new Set<string>();
    const requestModels = new Set<string>();
    const seenCursors = new Set<string>();
    const limit = snapshots.input.pageSize ?? DEFAULT_MODEL_PAGE_SIZE;
    let cursor: string | undefined;
    let pageCount = 0;
    let catalogBytes = 0;

    for (;;) {
      if (pageCount >= CODEX_ADAPTER_LIMITS.maxModelPages) return invalidReadResponse();
      pageCount += 1;
      const response = await this.#requestRead(
        "model/list",
        {
          ...(cursor === undefined ? {} : { cursor }),
          limit,
          includeHidden: true,
        },
        snapshots.requestOptions,
      );
      if (response.kind !== "accepted") return response;
      const decoded = decodeModelListResponse(response.value);
      if (!decoded.ok) return invalidReadResponse();
      if (catalogBytes + decoded.value.byteLength > CODEX_ADAPTER_LIMITS.maxModelCatalogBytes) {
        return invalidReadResponse();
      }
      catalogBytes += decoded.value.byteLength;
      if (models.length + decoded.value.models.length > CODEX_ADAPTER_LIMITS.maxModels) {
        return invalidReadResponse();
      }
      for (const model of decoded.value.models) {
        if (modelIds.has(model.id) || requestModels.has(model.requestModel)) return invalidReadResponse();
        modelIds.add(model.id);
        requestModels.add(model.requestModel);
        models.push(model);
      }
      const nextCursor = decoded.value.nextCursor;
      if (nextCursor === null) break;
      if (nextCursor.length === 0 || seenCursors.has(nextCursor)) return invalidReadResponse();
      seenCursors.add(nextCursor);
      cursor = nextCursor;
    }

    const catalog = Object.freeze({
      cliVersion: this.#cliVersion,
      schemaBaseline: CODEX_ADAPTER_SCHEMA_BASELINE.cliVersion,
      models: Object.freeze(models),
    });
    if (this.#isOperational()) {
      this.#modelsByRequestName = new Map(models.map((model) => [model.requestModel, model]));
    }
    return Object.freeze({
      kind: "accepted",
      effect: "none",
      value: catalog,
    });
  }

  async preflightCapability(
    input: CodexAdapterCapabilityPreflightInput,
    requestOptions?: CodexAdapterRequestOptions,
  ): Promise<CodexAdapterCapabilityPreflightResult> {
    const capability = snapshotCapabilityPreflightInput(input);
    if (!capability.ok) return Object.freeze({ kind: "unsupported", effect: "none" });
    const options = snapshotAdapterRequestOptions(requestOptions);
    if (!options.ok) return Object.freeze({ kind: "unsupported", effect: "none" });
    const validation = await this.#validateModelCapability(
      capability.value.model,
      capability.value.reasoningEffort,
      options.value,
      capability.value.requiredModality,
      capability.value.modelSelection === "explicit",
    );
    if (validation.kind === "valid") return Object.freeze({ kind: "supported", effect: "none" });
    if (validation.kind === "invalid") return Object.freeze({ kind: "unsupported", effect: "none" });
    return Object.freeze({ kind: "unavailable", effect: "none", failure: validation.failure });
  }

  async startThread(
    input: CodexStartThreadInput,
    requestOptions?: CodexAdapterRequestOptions,
  ): Promise<CodexAdapterMutationResult<CodexAdapterThreadSnapshot>> {
    const snapshots = snapshotOperationInputs(snapshotStartThreadInput(input), requestOptions);
    if (!snapshots.ok) return snapshots.result;
    const workspaceIdentity = resolveWorkspaceIdentity(snapshots.input.workspacePath);
    if (workspaceIdentity === undefined) return notSentMutation("invalid_input");
    if (!this.#isOperational()) return this.#unavailableMutationResult();
    const modelCapability = await this.#validateModelCapability(
      snapshots.input.model,
      snapshots.input.reasoningEffort,
      snapshots.requestOptions,
      "text",
      snapshots.input.modelSelection === "explicit",
    );
    if (modelCapability.kind !== "valid") return modelCapabilityMutationFailure(modelCapability);
    if (!this.#isOperational()) return this.#unavailableMutationResult();
    const pendingThread = this.#reserveThreadMutation("start");
    if (pendingThread === undefined) return notSentMutation("capability_unavailable");
    const result = await this.#requestThreadMutation(
      "thread/start",
      {
        model: snapshots.input.model,
        cwd: workspaceIdentity.workspacePath,
        approvalPolicy: snapshots.input.approvalPolicy,
        sandbox: snapshots.input.sandboxMode,
        ephemeral: snapshots.input.persistence === "ephemeral",
      },
      snapshots.requestOptions,
      decodeThreadStartResponse,
      {
        model: snapshots.input.model,
        workspaceKey: workspaceIdentity.workspaceKey,
        approvalPolicy: snapshots.input.approvalPolicy,
        sandboxMode: snapshots.input.sandboxMode,
        ephemeral: snapshots.input.persistence === "ephemeral",
      },
    );
    if (result.kind !== "accepted") {
      if (pendingThread.sideEffectObserved && result.kind === "rejected") {
        return ambiguousInvalidResponse();
      }
      if (result.kind !== "ambiguous") this.#releasePendingThreadMutation(pendingThread);
      return result;
    }
    if (
      pendingThread.observedThreadConflict ||
      (!pendingThread.observedCorrelationUnresolved &&
        pendingThread.observedThreadId !== undefined &&
        pendingThread.observedThreadId !== result.value.snapshot.threadId)
    ) {
      return ambiguousInvalidResponse();
    }
    const effectiveModelCapability = await this.#validateModelCapability(
      result.value.snapshot.model,
      result.value.snapshot.reasoningEffort ?? undefined,
      snapshots.requestOptions,
      "text",
      snapshots.input.modelSelection === "explicit",
    );
    if (effectiveModelCapability.kind !== "valid") return ambiguousInvalidResponse();
    const acceptedSnapshot = this.#acceptThreadSnapshot(
      result.value.snapshot,
      result.value.identity,
      result.value.activeTurn,
      result.value.workspacePath,
    );
    if (acceptedSnapshot === undefined) return ambiguousInvalidResponse();
    this.#releasePendingThreadMutation(pendingThread);
    return Object.freeze({ kind: "accepted", effect: "present", value: acceptedSnapshot });
  }

  async resumeThread(
    input: CodexResumeThreadInput,
    requestOptions?: CodexAdapterRequestOptions,
  ): Promise<CodexAdapterMutationResult<CodexAdapterThreadSnapshot>> {
    const snapshots = snapshotOperationInputs(snapshotResumeThreadInput(input), requestOptions);
    if (!snapshots.ok) return snapshots.result;
    const workspaceIdentity =
      snapshots.input.workspacePath === undefined ? undefined : resolveWorkspaceIdentity(snapshots.input.workspacePath);
    if (snapshots.input.workspacePath !== undefined && workspaceIdentity === undefined) {
      return notSentMutation("invalid_input");
    }
    if (!this.#isOperational()) return this.#unavailableMutationResult();
    if (this.#ambiguousTurnThreads.has(snapshots.input.threadId)) {
      return notSentMutation("capability_unavailable");
    }
    if (snapshots.input.reasoningEffort !== undefined && snapshots.input.model === undefined) {
      return notSentMutation("invalid_input");
    }
    if (snapshots.input.modelSelection !== undefined && snapshots.input.model === undefined) {
      return notSentMutation("invalid_input");
    }
    if (snapshots.input.model !== undefined) {
      const modelCapability = await this.#validateModelCapability(
        snapshots.input.model,
        snapshots.input.reasoningEffort,
        snapshots.requestOptions,
        "text",
        snapshots.input.modelSelection !== "inherited",
      );
      if (modelCapability.kind !== "valid") return modelCapabilityMutationFailure(modelCapability);
    }
    if (!this.#isOperational()) return this.#unavailableMutationResult();
    if (this.#ambiguousTurnThreads.has(snapshots.input.threadId)) return notSentMutation("capability_unavailable");
    const pendingThread = this.#reserveThreadMutation("resume", snapshots.input.threadId);
    if (pendingThread === undefined) return notSentMutation("capability_unavailable");
    const result = await this.#requestThreadMutation(
      "thread/resume",
      {
        threadId: snapshots.input.threadId,
        ...(snapshots.input.model === undefined ? {} : { model: snapshots.input.model }),
        ...(workspaceIdentity === undefined ? {} : { cwd: workspaceIdentity.workspacePath }),
        approvalPolicy: snapshots.input.approvalPolicy ?? "never",
        ...(snapshots.input.sandboxMode === undefined ? {} : { sandbox: snapshots.input.sandboxMode }),
      },
      snapshots.requestOptions,
      decodeThreadResumeResponse,
      {
        ...(snapshots.input.model === undefined ? {} : { model: snapshots.input.model }),
        ...(workspaceIdentity === undefined ? {} : { workspaceKey: workspaceIdentity.workspaceKey }),
        approvalPolicy: snapshots.input.approvalPolicy ?? "never",
        ...(snapshots.input.sandboxMode === undefined ? {} : { sandboxMode: snapshots.input.sandboxMode }),
      },
    );
    if (result.kind === "accepted" && result.value.snapshot.threadId !== snapshots.input.threadId) {
      return ambiguousInvalidResponse();
    }
    if (result.kind === "accepted") {
      const effectiveModelCapability = await this.#validateModelCapability(
        result.value.snapshot.model,
        result.value.snapshot.reasoningEffort ?? undefined,
        snapshots.requestOptions,
        "text",
        false,
      );
      if (effectiveModelCapability.kind !== "valid") return ambiguousInvalidResponse();
    }
    if (result.kind !== "accepted") {
      if (pendingThread.sideEffectObserved && result.kind === "rejected") {
        return ambiguousInvalidResponse();
      }
      if (result.kind !== "ambiguous") this.#releasePendingThreadMutation(pendingThread);
      return result;
    }
    const acceptedSnapshot = this.#acceptThreadSnapshot(
      result.value.snapshot,
      result.value.identity,
      result.value.activeTurn,
      result.value.workspacePath,
    );
    if (acceptedSnapshot === undefined) return ambiguousInvalidResponse();
    this.#releasePendingThreadMutation(pendingThread);
    return Object.freeze({ kind: "accepted", effect: "present", value: acceptedSnapshot });
  }

  async readThread(
    input: CodexReadThreadInput,
    requestOptions?: CodexAdapterRequestOptions,
  ): Promise<CodexAdapterReadResult<CodexAdapterReadThreadSnapshot>> {
    const snapshots = snapshotOperationInputs(snapshotReadThreadInput(input), requestOptions);
    if (!snapshots.ok) return snapshots.result;
    if (!this.#isOperational()) return notSent("capability_unavailable");
    const response = await this.#requestRead(
      "thread/read",
      { threadId: snapshots.input.threadId, includeTurns: snapshots.input.includeTurns },
      snapshots.requestOptions,
    );
    if (response.kind !== "accepted") return response;
    const decoded = decodeThreadReadResponse(response.value);
    if (!decoded.ok || decoded.value.thread.id !== snapshots.input.threadId) {
      return invalidReadResponse();
    }
    return Object.freeze({
      kind: "accepted",
      effect: "none",
      value: Object.freeze({
        threadId: decoded.value.thread.id,
        status: toAdapterThreadStatus(decoded.value.thread.status),
        cliVersion: decoded.value.thread.cliVersion,
        turns: Object.freeze(
          decoded.value.thread.turns.map((turn) =>
            Object.freeze({
              turnId: turn.id,
              status: toAdapterTurnStatus(turn.status),
              itemCount: turn.items.length,
            }),
          ),
        ),
      }),
    });
  }

  async startTurn(
    input: CodexStartTurnInput,
    requestOptions?: CodexAdapterRequestOptions,
  ): Promise<CodexAdapterMutationResult<CodexAdapterTurnSnapshot>> {
    const snapshots = snapshotOperationInputs(snapshotStartTurnInput(input), requestOptions);
    if (!snapshots.ok) return snapshots.result;
    if (this.#isTurnMutationUnavailable(snapshots.input.threadId)) {
      return this.#unavailableMutationResult();
    }
    const threadContext = this.#threadContexts.get(snapshots.input.threadId);
    if (threadContext === undefined) return notSentMutation("capability_unavailable");
    if (snapshots.input.modelSelection !== undefined && snapshots.input.model === undefined) {
      return notSentMutation("invalid_input");
    }
    const requestedTurnModel = snapshots.input.model ?? threadContext.model;
    if (requestedTurnModel === undefined) return notSentMutation("capability_unavailable");
    const modelCapability = await this.#validateModelCapability(
      requestedTurnModel,
      snapshots.input.reasoningEffort,
      snapshots.requestOptions,
      "text",
      snapshots.input.model !== undefined && snapshots.input.modelSelection !== "inherited",
    );
    if (modelCapability.kind !== "valid") return modelCapabilityMutationFailure(modelCapability);
    if (this.#isTurnMutationUnavailable(snapshots.input.threadId)) {
      return this.#unavailableMutationResult();
    }
    if (
      this.#pendingTurnModels.has(snapshots.input.threadId) ||
      !this.#lifecycle.canStartTurn(snapshots.input.threadId)
    ) {
      return notSentMutation("capability_unavailable");
    }
    if (this.#pendingTurnModels.size >= CODEX_ADAPTER_LIMITS.maxTrackedThreads) {
      return notSentMutation("capability_unavailable");
    }
    const turnModel = requestedTurnModel ?? "unknown";
    const pendingTurn: PendingTurnMutation = {
      model: turnModel,
      previousModel: threadContext.model,
      observedTurnId: undefined,
    };
    this.#pendingTurnModels.set(snapshots.input.threadId, pendingTurn);
    const response = await this.#requestMutation(
      "turn/start",
      {
        threadId: snapshots.input.threadId,
        input: toCodexUserInput(snapshots.input.contentBlocks),
        ...(snapshots.input.workspacePath === undefined ? {} : { cwd: snapshots.input.workspacePath }),
        approvalPolicy: snapshots.input.approvalPolicy ?? "never",
        ...(snapshots.input.sandboxPolicy === undefined
          ? {}
          : { sandboxPolicy: toCodexSandboxPolicy(snapshots.input.sandboxPolicy) }),
        ...(snapshots.input.model === undefined ? {} : { model: snapshots.input.model }),
        ...(snapshots.input.reasoningEffort === undefined ? {} : { effort: snapshots.input.reasoningEffort }),
        ...(snapshots.input.reasoningSummary === undefined ? {} : { summary: snapshots.input.reasoningSummary }),
      },
      snapshots.requestOptions,
    );
    if (response.kind === "not_sent") {
      if (pendingTurn.observedTurnId !== undefined) {
        this.#rollbackPendingTurnModel(snapshots.input.threadId, pendingTurn);
      }
      this.#releasePendingTurn(snapshots.input.threadId, pendingTurn);
      return response;
    }
    if (!this.#ownsPendingTurnOutcome(snapshots.input.threadId, pendingTurn)) {
      this.#emitEvents([
        diagnosticEvent("out_of_order_event", "An older turn/start response arrived after a newer Turn mutation."),
      ]);
      return ambiguousInvalidResponse();
    }
    if (response.kind === "accepted" && this.#ambiguousTurnThreads.has(snapshots.input.threadId)) {
      this.#releasePendingTurn(snapshots.input.threadId, pendingTurn);
      return ambiguousInvalidResponse();
    }
    if (response.kind !== "accepted") {
      const observed = this.#observedPendingTurn(snapshots.input.threadId, pendingTurn);
      if (observed !== undefined && !this.#ambiguousTurnThreads.has(snapshots.input.threadId)) {
        this.#commitPendingTurnModel(snapshots.input.threadId, pendingTurn);
        this.#releasePendingTurn(snapshots.input.threadId, pendingTurn);
        return Object.freeze({ kind: "accepted", effect: "present", value: observed });
      }
      if (response.kind !== "ambiguous") this.#releasePendingTurn(snapshots.input.threadId, pendingTurn);
      return response;
    }
    const decoded = decodeTurnStartResponse(response.value);
    if (!decoded.ok || decoded.value.turn.status !== "inProgress") {
      const observed = this.#observedPendingTurn(snapshots.input.threadId, pendingTurn);
      if (observed !== undefined && !this.#ambiguousTurnThreads.has(snapshots.input.threadId)) {
        this.#commitPendingTurnModel(snapshots.input.threadId, pendingTurn);
        this.#releasePendingTurn(snapshots.input.threadId, pendingTurn);
        return Object.freeze({ kind: "accepted", effect: "present", value: observed });
      }
      if (pendingTurn.observedTurnId !== undefined) {
        this.#ambiguousTurnThreads.add(snapshots.input.threadId);
        this.#commitPendingTurnModel(snapshots.input.threadId, pendingTurn);
        this.#releasePendingTurn(snapshots.input.threadId, pendingTurn);
      }
      return ambiguousInvalidResponse();
    }
    if (pendingTurn.observedTurnId !== undefined && pendingTurn.observedTurnId !== decoded.value.turn.id) {
      this.#ambiguousTurnThreads.add(snapshots.input.threadId);
      this.#commitPendingTurnModel(snapshots.input.threadId, pendingTurn);
      this.#releasePendingTurn(snapshots.input.threadId, pendingTurn);
      this.#emitEvents([
        diagnosticEvent("identity_mismatch", "A turn/start response conflicted with its observed Turn."),
      ]);
      return ambiguousInvalidResponse();
    }
    const observed = this.#observedPendingTurn(snapshots.input.threadId, pendingTurn);
    if (observed !== undefined && observed.status !== "in_progress") {
      this.#commitPendingTurnModel(snapshots.input.threadId, pendingTurn);
      this.#releasePendingTurn(snapshots.input.threadId, pendingTurn);
      return Object.freeze({ kind: "accepted", effect: "present", value: observed });
    }
    const value = Object.freeze({
      threadId: snapshots.input.threadId,
      turnId: decoded.value.turn.id,
      status: "in_progress" as const,
    });
    const accepted = this.#acceptTurnStarted(value, "response");
    this.#commitPendingTurnModel(snapshots.input.threadId, pendingTurn);
    this.#releasePendingTurn(snapshots.input.threadId, pendingTurn);
    if (!accepted) return ambiguousInvalidResponse();
    return Object.freeze({
      kind: "accepted",
      effect: "present",
      value,
    });
  }

  async steerTurn(
    input: CodexSteerTurnInput,
    requestOptions?: CodexAdapterRequestOptions,
  ): Promise<CodexAdapterMutationResult<CodexAdapterSteerAcknowledgement>> {
    const snapshots = snapshotOperationInputs(snapshotSteerTurnInput(input), requestOptions);
    if (!snapshots.ok) return snapshots.result;
    if (this.#isTurnMutationUnavailable(snapshots.input.threadId)) {
      return this.#unavailableMutationResult();
    }
    if (!this.#lifecycle.isActiveTurn(snapshots.input.threadId, snapshots.input.expectedTurnId)) {
      return notSentMutation("capability_unavailable");
    }
    if (this.#pendingSteers.size >= CODEX_ADAPTER_LIMITS.maxTrackedTurns) {
      return notSentMutation("capability_unavailable");
    }
    const clientUserMessageId = randomUUID();
    const pendingSteer: PendingSteerMutation = {
      threadId: snapshots.input.threadId,
      turnId: snapshots.input.expectedTurnId,
      sideEffectObserved: false,
      observedTupleConflict: false,
      settled: false,
    };
    this.#pendingSteers.set(clientUserMessageId, pendingSteer);
    const response = await this.#requestMutation(
      "turn/steer",
      {
        threadId: snapshots.input.threadId,
        expectedTurnId: snapshots.input.expectedTurnId,
        input: toCodexUserInput(snapshots.input.contentBlocks),
        clientUserMessageId,
      },
      snapshots.requestOptions,
    );
    if (response.kind === "accepted" && this.#ambiguousTurnThreads.has(snapshots.input.threadId)) {
      this.#pendingSteers.delete(clientUserMessageId);
      return ambiguousInvalidResponse();
    }
    if (pendingSteer.observedTupleConflict) {
      this.#pendingSteers.delete(clientUserMessageId);
      return ambiguousInvalidResponse();
    }
    if (response.kind !== "accepted") {
      if (pendingSteer.sideEffectObserved) {
        this.#pendingSteers.delete(clientUserMessageId);
        if (response.kind === "not_sent" || response.kind === "rejected") {
          return ambiguousInvalidResponse();
        }
      } else if (
        response.kind === "ambiguous" &&
        this.#lifecycle.isActiveTurn(pendingSteer.threadId, pendingSteer.turnId)
      ) {
        pendingSteer.settled = true;
      } else {
        this.#pendingSteers.delete(clientUserMessageId);
      }
      return response;
    }
    const decoded = decodeTurnSteerResponse(response.value);
    if (!decoded.ok || decoded.value.turnId !== snapshots.input.expectedTurnId) {
      this.#pendingSteers.delete(clientUserMessageId);
      return ambiguousInvalidResponse();
    }
    if (pendingSteer.sideEffectObserved || !this.#lifecycle.isActiveTurn(pendingSteer.threadId, pendingSteer.turnId)) {
      this.#pendingSteers.delete(clientUserMessageId);
    } else {
      pendingSteer.settled = true;
    }
    return Object.freeze({
      kind: "accepted",
      effect: "present",
      value: Object.freeze({
        threadId: snapshots.input.threadId,
        turnId: decoded.value.turnId,
      }),
    });
  }

  async interruptTurn(
    input: CodexInterruptTurnInput,
    requestOptions?: CodexAdapterRequestOptions,
  ): Promise<CodexAdapterMutationResult<CodexAdapterInterruptAcknowledgement>> {
    const snapshots = snapshotOperationInputs(snapshotInterruptTurnInput(input), requestOptions);
    if (!snapshots.ok) return snapshots.result;
    if (this.#isTurnMutationUnavailable(snapshots.input.threadId)) {
      return this.#unavailableMutationResult();
    }
    if (
      this.#pendingInterrupts.has(snapshots.input.threadId) ||
      this.#pendingInterrupts.size >= CODEX_ADAPTER_LIMITS.maxTrackedThreads
    ) {
      return notSentMutation("capability_unavailable");
    }
    if (!this.#lifecycle.isActiveTurn(snapshots.input.threadId, snapshots.input.turnId)) {
      return notSentMutation("capability_unavailable");
    }
    const pendingInterrupt: PendingInterruptMutation = {
      turnId: snapshots.input.turnId,
      terminalStatus: undefined,
      settled: false,
    };
    this.#pendingInterrupts.set(snapshots.input.threadId, pendingInterrupt);
    const response = await this.#requestMutation(
      "turn/interrupt",
      { threadId: snapshots.input.threadId, turnId: snapshots.input.turnId },
      snapshots.requestOptions,
    );
    pendingInterrupt.settled = true;
    if (response.kind === "accepted" && this.#ambiguousTurnThreads.has(snapshots.input.threadId)) {
      this.#releasePendingInterrupt(snapshots.input.threadId, pendingInterrupt);
      return ambiguousInvalidResponse();
    }
    if (response.kind !== "accepted") {
      if (pendingInterrupt.terminalStatus !== undefined && response.kind === "rejected") {
        this.#releasePendingInterrupt(snapshots.input.threadId, pendingInterrupt);
        return ambiguousInvalidResponse();
      }
      if (pendingInterrupt.terminalStatus !== undefined || response.kind !== "ambiguous") {
        this.#releasePendingInterrupt(snapshots.input.threadId, pendingInterrupt);
      }
      return response;
    }
    const decoded = decodeTurnInterruptResponse(response.value);
    if (!decoded.ok) {
      if (pendingInterrupt.terminalStatus !== undefined) {
        this.#releasePendingInterrupt(snapshots.input.threadId, pendingInterrupt);
      }
      return ambiguousInvalidResponse();
    }
    this.#releasePendingInterrupt(snapshots.input.threadId, pendingInterrupt);
    return Object.freeze({
      kind: "accepted",
      effect: "present",
      value: Object.freeze({
        threadId: snapshots.input.threadId,
        turnId: snapshots.input.turnId,
        terminal: false,
      }),
    });
  }

  reserveInteractionResponse(
    handle: CodexAdapterInteractionHandle,
    response: CodexAdapterInteractionResponse,
  ): CodexAdapterInteractionResponseReserveResult {
    return this.#interactions.reserve(handle, response);
  }

  writeReservedInteractionResponse(
    reservation: CodexAdapterInteractionResponseReservation,
  ): Promise<CodexAdapterInteractionResponseResult> {
    return this.#interactions.writeReserved(reservation);
  }

  releaseInteractionResponseReservation(reservation: CodexAdapterInteractionResponseReservation): void {
    this.#interactions.releaseReservation(reservation);
  }

  nextEvent(): Promise<CodexAdapterEvent> {
    this.#materializePendingConnectionFailure();
    const queued = this.#eventQueue.shift();
    if (queued !== undefined) {
      this.#queuedTextBytes -= queued.textBytes;
      this.#materializePendingConnectionFailure();
      return Promise.resolve(queued.event);
    }
    if (this.#state !== "open") return Promise.reject(adapterClosedError());
    if (this.#eventWaiter !== undefined) return Promise.reject(adapterEventWaiterError());
    return new Promise<CodexAdapterEvent>((resolve, reject) => {
      this.#eventWaiter = { resolve, reject };
    });
  }

  close(): Promise<void> {
    if (this.#state === "closed") return Promise.resolve();
    const existing = this.#closePromise;
    if (existing !== undefined) return existing;
    const attempt = this.#closeExplicitly();
    this.#closePromise = attempt;
    void attempt.catch(() => {
      if (this.#closePromise === attempt) this.#closePromise = undefined;
    });
    return attempt;
  }

  #acceptThreadSnapshot(
    snapshot: CodexAdapterThreadSnapshot,
    identity: CodexThreadLifecycleIdentity,
    activeTurn: CodexAdapterTurnSnapshot | undefined,
    workspacePath: string,
  ): CodexAdapterThreadSnapshot | undefined {
    if (this.#state !== "open") return undefined;
    const lifecycle = this.#lifecycle.acceptThreadResponse(snapshot, identity);
    const accepted = lifecycle.events.find(
      (event): event is Extract<CodexAdapterEvent, { kind: "thread_started" }> =>
        event.kind === "thread_started" && event.thread.threadId === snapshot.threadId,
    );
    if (accepted !== undefined) {
      this.#threadContexts.set(
        snapshot.threadId,
        Object.freeze({ cliVersion: snapshot.cliVersion, model: snapshot.model, workspacePath }),
      );
    }
    this.#emitComponentResult(lifecycle);
    if (accepted !== undefined && activeTurn !== undefined && !this.#acceptTurnStarted(activeTurn, "response")) {
      return undefined;
    }
    return accepted?.thread;
  }

  #acceptTurnStarted(snapshot: CodexAdapterTurnSnapshot, source: "response" | "notification"): boolean {
    if (this.#state !== "open") return false;
    const pendingTurn = this.#pendingTurnModels.get(snapshot.threadId);
    const currentActiveTurn = this.#lifecycle.activeTurn(snapshot.threadId);
    if (currentActiveTurn !== undefined && currentActiveTurn.turnId !== snapshot.turnId) {
      this.#ambiguousTurnThreads.add(snapshot.threadId);
    }
    const lifecycle = this.#lifecycle.acceptTurnStarted(snapshot, source);
    const started = lifecycle.events.some(
      (event) => event.kind === "turn_started" && event.turn.turnId === snapshot.turnId,
    );
    if (source === "notification" && started) {
      this.#recordPendingTurnObservation(snapshot.threadId, snapshot.turnId);
    }
    const accepted =
      !lifecycle.fatal &&
      this.#lifecycle.isActiveTurn(snapshot.threadId, snapshot.turnId) &&
      (started || lifecycle.events.length === 0);
    if (!started) {
      this.#emitComponentResult(lifecycle);
      return accepted;
    }
    const threadContext = this.#threadContexts.get(snapshot.threadId);
    const model = pendingTurn?.model ?? threadContext?.model ?? "unknown";
    if (
      threadContext !== undefined &&
      (threadContext.model !== model ||
        (pendingTurn !== undefined && threadContext.provisionalModelOwner !== pendingTurn))
    ) {
      this.#threadContexts.set(
        snapshot.threadId,
        Object.freeze({
          cliVersion: threadContext.cliVersion,
          model,
          workspacePath: threadContext.workspacePath,
          ...(pendingTurn === undefined ? {} : { provisionalModelOwner: pendingTurn }),
        }),
      );
    }
    const items = this.#items.beginTurn(
      snapshot.threadId,
      snapshot.turnId,
      threadContext?.cliVersion ?? this.#cliVersion,
      model,
    );
    this.#pendingTurnModels.delete(snapshot.threadId);
    this.#emitEvents([...lifecycle.events, ...items.events], lifecycle.fatal || items.fatal);
    return accepted && !items.fatal;
  }

  #releasePendingTurn(threadId: string, owner: PendingTurnMutation): void {
    if (this.#pendingTurnModels.get(threadId) === owner) this.#pendingTurnModels.delete(threadId);
  }

  #ownsPendingTurnOutcome(threadId: string, owner: PendingTurnMutation): boolean {
    const pendingOwner = this.#pendingTurnModels.get(threadId);
    if (pendingOwner !== undefined) return pendingOwner === owner;
    return this.#threadContexts.get(threadId)?.provisionalModelOwner === owner;
  }

  #commitPendingTurnModel(threadId: string, owner: PendingTurnMutation): void {
    const threadContext = this.#threadContexts.get(threadId);
    if (threadContext?.provisionalModelOwner !== owner) return;
    this.#threadContexts.set(
      threadId,
      Object.freeze({
        cliVersion: threadContext.cliVersion,
        model: threadContext.model,
        workspacePath: threadContext.workspacePath,
      }),
    );
  }

  #rollbackPendingTurnModel(threadId: string, owner: PendingTurnMutation): void {
    const threadContext = this.#threadContexts.get(threadId);
    if (threadContext?.provisionalModelOwner !== owner) return;
    this.#threadContexts.set(
      threadId,
      Object.freeze({
        cliVersion: threadContext.cliVersion,
        model: owner.previousModel,
        workspacePath: threadContext.workspacePath,
      }),
    );
  }

  #recordPendingTurnObservation(threadId: string, turnId: string): void {
    const pendingTurn = this.#pendingTurnModels.get(threadId);
    if (pendingTurn === undefined) return;
    if (pendingTurn.observedTurnId === undefined) {
      pendingTurn.observedTurnId = turnId;
    } else if (pendingTurn.observedTurnId !== turnId) {
      this.#ambiguousTurnThreads.add(threadId);
    }
  }

  #observedPendingTurn(threadId: string, pendingTurn: PendingTurnMutation): CodexAdapterTurnSnapshot | undefined {
    const turnId = pendingTurn.observedTurnId;
    if (turnId === undefined) return undefined;
    const active = this.#lifecycle.activeTurn(threadId);
    if (active?.turnId === turnId) return active;
    const terminalStatus = this.#lifecycle.terminalTurnStatus(threadId, turnId);
    return terminalStatus === undefined
      ? undefined
      : Object.freeze({
          threadId,
          turnId,
          status: terminalStatus,
        });
  }

  #isTurnMutationUnavailable(threadId: string): boolean {
    if (!this.#isOperational() || this.#ambiguousTurnThreads.has(threadId)) return true;
    for (const owner of this.#pendingThreadMutations) {
      if (owner.threadId === threadId || owner.observedThreadId === threadId) return true;
    }
    return false;
  }

  #releasePendingInterrupt(threadId: string, owner: PendingInterruptMutation): void {
    if (this.#pendingInterrupts.get(threadId) === owner) this.#pendingInterrupts.delete(threadId);
  }

  #reserveThreadMutation(kind: "start" | "resume", threadId?: string): PendingThreadMutation | undefined {
    if (this.#pendingThreadMutations.size >= CODEX_ADAPTER_LIMITS.maxTrackedThreads) return undefined;
    if (kind === "resume" && (threadId === undefined || this.#pendingResumeThreads.has(threadId))) return undefined;
    const prospective = kind === "start" || !this.#lifecycle.hasThread(threadId as string);
    if (
      prospective &&
      this.#lifecycle.snapshot().trackedThreads + this.#pendingProspectiveThreadCount >=
        CODEX_ADAPTER_LIMITS.maxTrackedThreads
    ) {
      return undefined;
    }
    const owner: PendingThreadMutation = {
      kind,
      ...(threadId === undefined ? {} : { threadId }),
      prospective,
      sideEffectObserved: false,
      observedThreadId: undefined,
      observedCorrelationUnresolved: false,
      observedThreadConflict: false,
    };
    this.#pendingThreadMutations.add(owner);
    if (threadId !== undefined) this.#pendingResumeThreads.set(threadId, owner);
    if (prospective) this.#pendingProspectiveThreadCount += 1;
    return owner;
  }

  #releasePendingThreadMutation(owner: PendingThreadMutation): void {
    if (!this.#pendingThreadMutations.delete(owner)) return;
    if (owner.threadId !== undefined && this.#pendingResumeThreads.get(owner.threadId) === owner) {
      this.#pendingResumeThreads.delete(owner.threadId);
    }
    if (owner.prospective) this.#pendingProspectiveThreadCount -= 1;
  }

  #clearPendingThreadMutations(): void {
    this.#pendingThreadMutations.clear();
    this.#pendingResumeThreads.clear();
    this.#pendingProspectiveThreadCount = 0;
  }

  #recordPendingThreadResumeObservation(threadId: string): boolean {
    const owner = this.#pendingResumeThreads.get(threadId);
    if (owner === undefined) return false;
    this.#recordPendingThreadOwnerObservation(owner, threadId);
    return true;
  }

  #recordPendingThreadStartObservation(threadId: string): void {
    const pendingStarts = [...this.#pendingThreadMutations].filter((owner) => owner.kind === "start");
    for (const owner of pendingStarts) owner.sideEffectObserved = true;
    if (pendingStarts.length !== 1) {
      for (const owner of pendingStarts) owner.observedCorrelationUnresolved = true;
      return;
    }
    this.#recordPendingThreadOwnerObservation(pendingStarts[0] as PendingThreadMutation, threadId);
  }

  #recordPendingThreadOwnerObservation(owner: PendingThreadMutation, threadId: string): void {
    owner.sideEffectObserved = true;
    if (owner.observedCorrelationUnresolved) return;
    if (owner.observedThreadId === undefined) {
      owner.observedThreadId = threadId;
    } else if (owner.observedThreadId !== threadId) {
      owner.observedThreadConflict = true;
    }
  }

  async #pumpEvents(): Promise<void> {
    while (this.#state === "open") {
      let event: CodexAdapterTransportEvent;
      try {
        event = await this.#transport.nextEvent();
      } catch (error) {
        if (this.#state !== "open") return;
        const failure = snapshotTransportFailure(error);
        this.#enterFailure(failure?.kind === "connection_failure" ? failure.code : "protocol_failed", false);
        return;
      }
      if (this.#state !== "open") return;
      const snapshot = snapshotAdapterTransportEvent(event);
      if (snapshot === undefined) {
        this.#emitEvents(
          [diagnosticEvent("known_invalid_payload", "A transport event had an invalid envelope.", {}, "applied")],
          false,
        );
        this.#enterFailure("protocol_failed", false);
        return;
      }
      try {
        this.#acceptTransportEvent(snapshot);
      } catch {
        this.#emitEvents(
          [diagnosticEvent("known_invalid_payload", "A transport event could not be safely inspected.", {}, "applied")],
          false,
        );
        this.#enterFailure("protocol_failed", false);
      }
    }
  }

  #acceptTransportEvent(event: SnapshottedAdapterTransportEvent): void {
    switch (event.kind) {
      case "notification":
        this.#acceptNotification(event.method, event.params);
        break;
      case "serverRequest":
        this.#acceptServerRequest(event.request);
        break;
      case "protocolAnomaly":
        this.#emitEvents([
          diagnosticEvent("protocol_anomaly", "A Codex transport protocol anomaly closed the Adapter connection."),
        ]);
        this.#enterFailure("protocol_failed", false);
        break;
    }
  }

  #acceptServerRequest(request: CodexAdapterServerRequestPort): void {
    try {
      const ownerRecord = inspectServerRequestOwner(request.params);
      const workspacePath =
        ownerRecord === undefined ? undefined : this.#threadContexts.get(ownerRecord.threadId)?.workspacePath;
      const admission = this.#interactions.admit(request, workspacePath, (threadId, turnId) =>
        this.#lifecycle.isActiveTurn(threadId, turnId),
      );
      if (admission.protocolFailure) {
        this.#sendFailClosedResponse(this.#interactions.failClosedRequest(request));
        this.#emitEvents([
          diagnosticEvent("known_invalid_payload", "A Codex interaction request violated the Provider protocol.", {
            method: request.method,
          }),
        ]);
        this.#enterFailure("protocol_failed", false);
        return;
      }
      if (admission.event !== undefined) this.#emitEvents([admission.event]);
      if (admission.resourceLimit) {
        this.#emitEvents([diagnosticEvent("resource_limit", "A Codex interaction resource limit was reached.")]);
        if (admission.event === undefined) this.#sendFailClosedResponse(this.#interactions.failClosedRequest(request));
      }
      if (admission.event !== undefined && admission.failClosed) {
        this.#sendFailClosedResponse(this.#interactions.failClosed(admission.event.handle));
      }
      if (admission.interrupt && ownerRecord !== undefined) {
        this.#interruptFailClosedInteraction(ownerRecord.threadId, ownerRecord.turnId);
      }
      if (admission.resourceLimit) return;
      if (admission.event === undefined) {
        this.#sendFailClosedResponse(this.#interactions.failClosedRequest(request));
        this.#emitEvents([
          diagnosticEvent("unsupported_server_request", "A Codex server request could not be admitted safely.", {
            method: request.method,
          }),
        ]);
        this.#enterFailure("unsupported_server_request", false);
      }
    } finally {
      request.releasePayload?.();
    }
  }

  #sendFailClosedResponse(response: Promise<void>): void {
    void response.catch((error: unknown) => {
      const failure = snapshotTransportFailure(error);
      this.#enterFailure(failure?.kind === "connection_failure" ? failure.code : "protocol_failed", false);
    });
  }

  #interruptFailClosedInteraction(threadId: string, turnId: string): void {
    void this.#requestMutation("turn/interrupt", { threadId, turnId }, {}).then(
      (result) => {
        if (result.kind !== "accepted" || !decodeTurnInterruptResponse(result.value).ok) {
          this.#enterFailure(result.kind === "connection_failure" ? result.code : "protocol_failed", false);
        }
      },
      () => this.#enterFailure("protocol_failed", false),
    );
  }

  #acceptNotification(method: unknown, params: unknown): void {
    const classified = classifyCodexNotification(method, params);
    switch (classified.kind) {
      case "known":
        this.#acceptKnownNotification(classified.notification);
        break;
      case "known_invalid":
        this.#emitEvents([
          diagnosticEvent("known_invalid_payload", "A known Codex notification had an invalid payload.", {
            method: classified.method,
          }),
        ]);
        this.#enterFailure("protocol_failed", false);
        break;
      case "unknown_valid":
        this.#emitEvents([
          providerMetadataEvent(classified.correlation),
          diagnosticEvent("unknown_notification", "An unknown Codex notification was retained as bounded metadata.", {
            method: classified.method,
            correlation: classified.correlation,
          }),
        ]);
        break;
      case "unknown_invalid":
        this.#emitEvents([
          diagnosticEvent(
            "known_invalid_payload",
            "An invalid unknown notification closed the Adapter connection.",
            {},
            "applied",
          ),
        ]);
        this.#enterFailure("protocol_failed", false);
        break;
    }
  }

  #acceptKnownNotification(notification: CodexValidatedNotification): void {
    switch (notification.method) {
      case "thread/started":
        {
          const responseConfirmedThread = this.#lifecycle.hasThreadResponse(notification.thread.id);
          const pendingResumeObserved = this.#recordPendingThreadResumeObservation(notification.thread.id);
          const lifecycle = this.#lifecycle.acceptThreadStartedNotification(notification.thread);
          if (
            lifecycle.events.some(
              (event) => event.kind === "diagnostic" && event.diagnostic.code === "identity_mismatch",
            )
          ) {
            this.#ambiguousTurnThreads.add(notification.thread.id);
          }
          if (!responseConfirmedThread && !pendingResumeObserved && !lifecycle.fatal && lifecycle.events.length === 0) {
            this.#recordPendingThreadStartObservation(notification.thread.id);
          }
          this.#emitComponentResult(lifecycle);
        }
        break;
      case "thread/status/changed":
        this.#emitComponentResult(this.#lifecycle.acceptThreadStatus(notification.threadId, notification.status));
        break;
      case "turn/started":
        this.#acceptTurnStarted(
          Object.freeze({
            threadId: notification.threadId,
            turnId: notification.turn.id,
            status: "in_progress",
          }),
          "notification",
        );
        break;
      case "turn/completed":
        this.#acceptTurnTerminal(
          notification.threadId,
          notification.turn.id,
          toAdapterTurnStatus(notification.turn.status) as "completed" | "failed" | "interrupted",
        );
        break;
      case "item/started":
        if (
          notification.item.classification === "operation" &&
          notification.item.itemType === "fileChange" &&
          notification.item.fileChanges !== undefined
        ) {
          const observation = this.#interactions.observeFileChanges(
            notification.threadId,
            notification.turnId,
            notification.item.id,
            notification.item.fileChanges,
          );
          if (observation.kind === "resource_limit") {
            this.#emitEvents([
              diagnosticEvent("resource_limit", "A Codex file observation resource limit was reached."),
            ]);
          }
        }
        this.#observePendingSteer(notification);
        this.#emitComponentResult(
          this.#items.acceptItemStarted(notification.threadId, notification.turnId, notification.item),
        );
        break;
      case "item/completed":
        this.#observePendingSteer(notification);
        this.#emitComponentResult(
          this.#items.acceptItemCompleted(notification.threadId, notification.turnId, notification.item),
        );
        break;
      case "item/fileChange/patchUpdated":
        {
          const observation = this.#interactions.observeFileChanges(
            notification.threadId,
            notification.turnId,
            notification.itemId,
            notification.changes,
          );
          if (observation.kind === "resource_limit") {
            this.#emitEvents([
              diagnosticEvent("resource_limit", "A Codex file observation resource limit was reached."),
            ]);
          }
        }
        break;
      case "serverRequest/resolved": {
        const observed = this.#transport.observeServerRequestResolution(notification.requestId);
        if (observed.kind !== "current") {
          this.#emitEvents([
            diagnosticEvent(
              "protocol_anomaly",
              observed.kind === "duplicate"
                ? "A duplicate Codex interaction resolution closed the Adapter connection."
                : "An unknown Codex interaction resolution closed the Adapter connection.",
            ),
          ]);
          this.#enterFailure("protocol_failed", false);
          break;
        }
        const resolution = this.#interactions.resolve(observed.identity, notification.threadId);
        if (resolution.kind === "resolved") this.#emitEvents([resolution.event]);
        else {
          this.#emitEvents([diagnosticEvent("identity_mismatch", "An interaction resolution had no current owner.")]);
          this.#enterFailure("protocol_failed", false);
        }
        break;
      }
      case "item/agentMessage/delta":
        this.#emitComponentResult(
          this.#items.acceptAgentDelta(
            notification.threadId,
            notification.turnId,
            notification.itemId,
            notification.delta,
          ),
        );
        break;
      case "thread/tokenUsage/updated":
        this.#acceptTokenUsage(notification);
        break;
      case "warning":
        this.#emitEvents([
          diagnosticEvent(
            "provider_warning",
            "Codex reported a warning whose raw message was not retained.",
            {
              method: notification.method,
              ...(notification.threadId === null ? {} : { correlation: { threadId: notification.threadId } }),
            },
            "applied",
          ),
        ]);
        break;
      case "error":
        if (!this.#lifecycle.isActiveTurn(notification.threadId, notification.turnId)) {
          this.#emitEvents([
            diagnosticEvent(
              this.#lifecycle.hasActiveTurn(notification.threadId) ? "identity_mismatch" : "out_of_order_event",
              "An error for a non-active Turn was ignored.",
              {
                method: notification.method,
                correlation: { threadId: notification.threadId, turnId: notification.turnId },
              },
              "not_required",
            ),
          ]);
          break;
        }
        this.#emitEvents([
          diagnosticEvent(
            "provider_error",
            "Codex reported an error whose raw details were not retained.",
            {
              method: notification.method,
              correlation: { threadId: notification.threadId, turnId: notification.turnId },
              willRetry: notification.willRetry,
            },
            "applied",
          ),
        ]);
        break;
    }
  }

  #observePendingSteer(
    notification: Extract<CodexValidatedNotification, { method: "item/started" | "item/completed" }>,
  ): void {
    const item = notification.item;
    if (item.classification !== "userMessage" || typeof item.clientId !== "string") return;
    const pendingSteer = this.#pendingSteers.get(item.clientId);
    if (pendingSteer === undefined) return;
    pendingSteer.sideEffectObserved = true;
    if (pendingSteer.threadId !== notification.threadId || pendingSteer.turnId !== notification.turnId) {
      pendingSteer.observedTupleConflict = true;
      this.#ambiguousTurnThreads.add(pendingSteer.threadId);
      if (this.#lifecycle.hasThread(notification.threadId)) {
        this.#ambiguousTurnThreads.add(notification.threadId);
      }
      this.#emitEvents([
        diagnosticEvent("identity_mismatch", "A userMessage delivery observation conflicted with its steer tuple.", {
          method: notification.method,
          correlation: {
            threadId: notification.threadId,
            turnId: notification.turnId,
            itemId: item.id,
          },
        }),
      ]);
      if (pendingSteer.settled) this.#pendingSteers.delete(item.clientId);
      return;
    }
    if (pendingSteer.settled) this.#pendingSteers.delete(item.clientId);
  }

  #acceptTurnTerminal(threadId: string, turnId: string, status: "completed" | "failed" | "interrupted"): void {
    this.#interactions.completeTurn(threadId, turnId);
    const terminalWasKnown = this.#lifecycle.hasTerminalTurn(threadId, turnId);
    if (!terminalWasKnown && this.#pendingTurnModels.has(threadId) && !this.#lifecycle.hasActiveTurn(threadId)) {
      this.#acceptTurnStarted(
        Object.freeze({
          threadId,
          turnId,
          status: "in_progress",
        }),
        "notification",
      );
    }
    const lifecycle = this.#lifecycle.acceptTurnTerminal(threadId, turnId, status);
    if (!terminalWasKnown) this.#recordPendingTurnObservation(threadId, turnId);
    const terminalIndex = lifecycle.events.findIndex(
      (event) => event.kind === "turn_terminal" && event.turnId === turnId,
    );
    if (terminalIndex < 0) {
      this.#emitComponentResult(lifecycle);
      return;
    }
    this.#releaseSettledSteers(threadId, turnId);
    const pendingInterrupt = this.#pendingInterrupts.get(threadId);
    if (pendingInterrupt?.turnId === turnId) {
      pendingInterrupt.terminalStatus = status;
      if (pendingInterrupt.settled) this.#releasePendingInterrupt(threadId, pendingInterrupt);
    }
    const content = this.#items.completeTurn(threadId, turnId, status);
    this.#releaseTokenUsage(threadId, turnId);
    const lifecycleEvents = lifecycle.events.map((event, index) =>
      index === terminalIndex && event.kind === "turn_terminal"
        ? Object.freeze({
            ...event,
            finalAssistantMessage: content.finalAssistantMessage,
            contentFailure: content.contentFailure,
          })
        : event,
    );
    this.#emitEvents([...content.events, ...lifecycleEvents], content.fatal || lifecycle.fatal);
  }

  #releaseSettledSteers(threadId: string, turnId: string): void {
    for (const [clientId, steer] of this.#pendingSteers) {
      if (steer.settled && steer.threadId === threadId && steer.turnId === turnId) {
        this.#pendingSteers.delete(clientId);
      }
    }
  }

  #acceptTokenUsage(notification: Extract<CodexValidatedNotification, { method: "thread/tokenUsage/updated" }>): void {
    if (!this.#lifecycle.isActiveTurn(notification.threadId, notification.turnId)) {
      this.#emitEvents([
        diagnosticEvent(
          this.#lifecycle.hasActiveTurn(notification.threadId) ? "identity_mismatch" : "out_of_order_event",
          "Token usage for a non-active Turn was ignored.",
          {
            method: notification.method,
            correlation: { threadId: notification.threadId, turnId: notification.turnId },
          },
        ),
      ]);
      return;
    }
    let turns = this.#turnTokenUsage.get(notification.threadId);
    if (turns === undefined) {
      turns = new Map();
      this.#turnTokenUsage.set(notification.threadId, turns);
    }
    const previous = turns.get(notification.turnId);
    const duplicate = previous !== undefined && tokenUsageEqual(previous, notification.tokenUsage);
    const invalidProgression =
      !tokenUsageBreakdownAtLeast(notification.tokenUsage.total, notification.tokenUsage.last) ||
      (previous !== undefined && !tokenUsageBreakdownAtLeast(notification.tokenUsage.total, previous.total));
    if (duplicate || invalidProgression) {
      this.#emitEvents([
        diagnosticEvent(
          duplicate ? "duplicate_event" : "out_of_order_event",
          duplicate ? "A duplicate token usage update was ignored." : "A regressive token usage update was ignored.",
          {
            method: notification.method,
            correlation: { threadId: notification.threadId, turnId: notification.turnId },
          },
        ),
      ]);
      return;
    }
    turns.set(notification.turnId, notification.tokenUsage);
    this.#emitEvents([tokenUsageEvent(notification)]);
  }

  #releaseTokenUsage(threadId: string, turnId: string): void {
    const turns = this.#turnTokenUsage.get(threadId);
    if (turns === undefined) return;
    turns.delete(turnId);
    if (turns.size === 0) this.#turnTokenUsage.delete(threadId);
  }

  #emitComponentResult(result: CodexLifecycleResult | CodexItemMapperResult): void {
    this.#emitEvents(result.events, result.fatal);
  }

  #emitEvents(events: readonly CodexAdapterEvent[], fatal = false): void {
    if (this.#state !== "open") return;
    const pendingTerminal = events.find((event) => event.kind === "turn_terminal");
    let terminalEnqueued = false;
    for (const event of events) {
      if (event.kind === "connection_failure") continue;
      if (!this.#enqueueEvent(event, event.kind === "turn_terminal")) {
        if (pendingTerminal !== undefined && !terminalEnqueued) {
          this.#forceEnqueueTerminal(stripTerminalContent(pendingTerminal));
        }
        this.#enterFailure("adapter_resource_limit", true);
        return;
      }
      if (event.kind === "turn_terminal") terminalEnqueued = true;
    }
    if (fatal) this.#enterFailure("adapter_resource_limit", false);
  }

  #enqueueEvent(event: CodexAdapterEvent, priority: boolean): boolean {
    const diagnosticBytes = event.kind === "diagnostic" ? jsonBytes(event.diagnostic) : 0;
    if (
      event.kind === "diagnostic" &&
      (this.#diagnosticCount >= CODEX_ADAPTER_LIMITS.maxDiagnostics ||
        this.#diagnosticBytes + diagnosticBytes > CODEX_ADAPTER_LIMITS.maxDiagnosticBytes)
    ) {
      return false;
    }
    const textBytes = eventTextBytes(event);
    if (
      this.#items.snapshot().retainedTextBytes + this.#queuedTextBytes + textBytes >
      CODEX_ADAPTER_LIMITS.maxConnectionTextBytes
    ) {
      return false;
    }
    const waiter = this.#eventWaiter;
    if (waiter !== undefined) {
      if (event.kind === "diagnostic") {
        this.#diagnosticCount += 1;
        this.#diagnosticBytes += diagnosticBytes;
      }
      this.#eventWaiter = undefined;
      waiter.resolve(event);
      return true;
    }
    if (this.#eventQueue.length >= CODEX_ADAPTER_LIMITS.maxQueuedEvents) return false;
    if (event.kind === "diagnostic") {
      this.#diagnosticCount += 1;
      this.#diagnosticBytes += diagnosticBytes;
    }
    this.#eventQueue.push(Object.freeze({ event, textBytes }));
    this.#queuedTextBytes += textBytes;
    return true;
  }

  #enterFailure(
    code: Extract<CodexAdapterEvent, { kind: "connection_failure" }>["code"],
    includeResourceDiagnostic: boolean,
  ): void {
    if (this.#state !== "open") return;
    this.#terminalConnectionFailureCode = code;
    this.#state = "failed";
    this.#lifecycle.release();
    this.#items.release();
    this.#threadContexts.clear();
    this.#clearPendingThreadMutations();
    this.#pendingTurnModels.clear();
    this.#pendingInterrupts.clear();
    this.#pendingSteers.clear();
    this.#ambiguousTurnThreads.clear();
    this.#turnTokenUsage.clear();
    this.#interactions.close();
    this.#modelsByRequestName = undefined;
    this.#modelCatalogLoadPromise = undefined;
    if (includeResourceDiagnostic) {
      this.#enqueueEvent(diagnosticEvent("resource_limit", "A Codex Adapter resource limit was reached."), true);
    }
    if (!this.#enqueueEvent(Object.freeze({ kind: "connection_failure", code }), true)) {
      this.#pendingConnectionFailureCode = code;
    }
    void this.#requestTransportClose().catch(() => undefined);
  }

  #requestTransportClose(): Promise<void> {
    const existing = this.#transportClosePromise;
    if (existing !== undefined) return existing;
    const attempt = Promise.resolve().then(() => this.#transport.close());
    this.#transportClosePromise = attempt;
    void attempt.catch(() => {
      if (this.#transportClosePromise === attempt) this.#transportClosePromise = undefined;
    });
    return attempt;
  }

  async #closeExplicitly(): Promise<void> {
    this.#state = "closing";
    this.#lifecycle.release();
    this.#items.release();
    this.#threadContexts.clear();
    this.#clearPendingThreadMutations();
    this.#pendingTurnModels.clear();
    this.#pendingInterrupts.clear();
    this.#pendingSteers.clear();
    this.#ambiguousTurnThreads.clear();
    this.#turnTokenUsage.clear();
    this.#interactions.close();
    this.#modelsByRequestName = undefined;
    this.#modelCatalogLoadPromise = undefined;
    const waiter = this.#eventWaiter;
    this.#eventWaiter = undefined;
    waiter?.reject(adapterClosedError());
    try {
      await this.#requestTransportClose();
      this.#state = "closed";
    } catch (error) {
      this.#terminalConnectionFailureCode ??= "close_failed";
      this.#state = "failed";
      throw error;
    }
  }

  #forceEnqueueTerminal(event: Extract<CodexAdapterEvent, { kind: "turn_terminal" }>): void {
    if (this.#eventQueue.length >= CODEX_ADAPTER_LIMITS.maxQueuedEvents) {
      const removableIndex = this.#eventQueue.findIndex((queued) => queued.event.kind !== "turn_terminal");
      if (removableIndex < 0) return;
      const [removed] = this.#eventQueue.splice(removableIndex, 1);
      if (removed !== undefined) this.#queuedTextBytes -= removed.textBytes;
    }
    this.#enqueueEvent(event, true);
  }

  #materializePendingConnectionFailure(): void {
    const code = this.#pendingConnectionFailureCode;
    if (code === undefined || this.#eventQueue.length >= CODEX_ADAPTER_LIMITS.maxQueuedEvents) return;
    this.#pendingConnectionFailureCode = undefined;
    this.#enqueueEvent(Object.freeze({ kind: "connection_failure", code }), true);
  }

  async #validateModelCapability(
    requestModel: string,
    reasoningEffort: string | undefined,
    requestOptions: CodexAdapterRequestOptions,
    requiredModality?: "text" | "image" | "audio",
    requireSelectable = true,
  ): Promise<ModelCapabilityValidation> {
    if (this.#modelsByRequestName === undefined) {
      const load = (this.#modelCatalogLoadPromise ??= this.listModels());
      try {
        const result = await load;
        if (result.kind !== "accepted") {
          return Object.freeze({ kind: "unavailable", failure: result });
        }
        if (!this.#isOperational()) {
          return Object.freeze({
            kind: "unavailable",
            failure:
              this.#terminalConnectionFailureCode === undefined
                ? notSent("capability_unavailable")
                : connectionReadFailure(this.#terminalConnectionFailureCode),
          });
        }
      } finally {
        if (this.#modelCatalogLoadPromise === load) this.#modelCatalogLoadPromise = undefined;
      }
    }
    const model = this.#modelsByRequestName?.get(requestModel);
    if (
      model === undefined ||
      (requireSelectable && !model.selectable) ||
      (requiredModality !== undefined && !model.inputModalities.includes(requiredModality))
    ) {
      return Object.freeze({ kind: "invalid" });
    }
    return reasoningEffort === undefined || model.supportedReasoningEfforts.includes(reasoningEffort)
      ? Object.freeze({ kind: "valid" })
      : Object.freeze({ kind: "invalid" });
  }

  async #requestThreadMutation(
    method: "thread/start" | "thread/resume",
    params: unknown,
    requestOptions: CodexAdapterRequestOptions,
    decode: (value: unknown) => Readonly<{ ok: true; value: CodexValidatedThreadOperationResponse } | { ok: false }>,
    expected: ExpectedThreadConfiguration,
  ): Promise<CodexAdapterMutationResult<ThreadMutationProjection>> {
    const response = await this.#requestMutation(method, params, requestOptions);
    if (response.kind !== "accepted") return response;
    const decoded = decode(response.value);
    if (
      !decoded.ok ||
      (expected.approvalPolicy !== undefined && decoded.value.effective.approvalPolicy !== expected.approvalPolicy) ||
      (expected.model !== undefined && decoded.value.model !== expected.model) ||
      (expected.workspaceKey !== undefined && decoded.value.effective.workspaceKey !== expected.workspaceKey) ||
      (expected.sandboxMode !== undefined && decoded.value.effective.sandboxMode !== expected.sandboxMode) ||
      (expected.ephemeral !== undefined && decoded.value.thread.ephemeral !== expected.ephemeral)
    ) {
      return ambiguousInvalidResponse();
    }
    const status = toAdapterThreadStatus(decoded.value.thread.status);
    const activeTurns = decoded.value.thread.turns.filter((turn) => turn.status === "inProgress");
    if (
      activeTurns.length > 1 ||
      (status === "active" && activeTurns.length !== 1) ||
      (status !== "active" && activeTurns.length !== 0)
    ) {
      return ambiguousInvalidResponse();
    }
    const snapshot = Object.freeze({
      threadId: decoded.value.thread.id,
      status,
      model: decoded.value.model,
      modelProvider: decoded.value.modelProvider,
      cliVersion: decoded.value.thread.cliVersion,
      reasoningEffort: decoded.value.reasoningEffort,
    });
    const activeTurn = activeTurns[0];
    return Object.freeze({
      kind: "accepted",
      effect: "present",
      value: Object.freeze({
        snapshot,
        identity: Object.freeze({
          workspaceKey: decoded.value.thread.workspaceKey,
          ephemeral: decoded.value.thread.ephemeral,
        }),
        workspacePath: decoded.value.effective.cwd,
        activeTurn:
          activeTurn === undefined
            ? undefined
            : Object.freeze({
                threadId: decoded.value.thread.id,
                turnId: activeTurn.id,
                status: "in_progress",
              }),
      }),
    });
  }

  async #requestRead(
    method: string,
    params: unknown,
    requestOptions: CodexAdapterRequestOptions,
  ): Promise<CodexAdapterReadResult<unknown>> {
    if (!this.#isOperational()) return notSent("capability_unavailable");
    try {
      const value = await this.#transport.request<unknown>(method, params, requestOptions);
      return Object.freeze({ kind: "accepted", effect: "none", value });
    } catch (error) {
      const result = mapReadFailure(error);
      if (result.kind === "connection_failure") this.#enterFailure(result.code, false);
      if (result.kind === "not_sent" && this.#terminalConnectionFailureCode !== undefined) {
        return connectionReadFailure(this.#terminalConnectionFailureCode);
      }
      return result;
    }
  }

  async #requestMutation(
    method: string,
    params: unknown,
    requestOptions: CodexAdapterRequestOptions,
  ): Promise<CodexAdapterMutationResult<unknown>> {
    if (!this.#isOperational()) return this.#unavailableMutationResult();
    try {
      const value = await this.#transport.request<unknown>(method, params, requestOptions);
      return Object.freeze({ kind: "accepted", effect: "present", value });
    } catch (error) {
      const result = mapMutationFailure(error);
      if (result.kind === "connection_failure") this.#enterFailure(result.code, false);
      if (result.kind === "not_sent" && this.#terminalConnectionFailureCode !== undefined) {
        return notSentMutation(this.#terminalConnectionFailureCode);
      }
      return result;
    }
  }

  #isOperational(): boolean {
    return this.#state === "open";
  }

  #unavailableMutationResult(): CodexAdapterMutationResult<never> {
    return this.#terminalConnectionFailureCode === undefined
      ? notSentMutation("capability_unavailable")
      : notSentMutation(this.#terminalConnectionFailureCode);
  }
}

function diagnosticEvent(
  code: CodexAdapterDiagnostic["code"],
  summary: string,
  details: Readonly<{
    method?: string;
    correlation?: Readonly<{ threadId?: string; turnId?: string; itemId?: string }>;
    willRetry?: boolean;
  }> = {},
  redaction: CodexAdapterDiagnostic["redaction"] = "not_required",
): CodexAdapterEvent {
  return Object.freeze({
    kind: "diagnostic",
    diagnostic: Object.freeze({ code, summary, ...details, redaction }),
  });
}

function tokenUsageEvent(
  notification: Extract<CodexValidatedNotification, { method: "thread/tokenUsage/updated" }>,
): CodexAdapterEvent {
  return Object.freeze({
    kind: "turn_output",
    threadId: notification.threadId,
    turnId: notification.turnId,
    output: Object.freeze({
      category: "telemetry",
      kind: "token_usage",
      summary: "Codex token usage was updated.",
      completionState: "complete",
      payload: Object.freeze({
        kind: "token_usage",
        last: notification.tokenUsage.last,
        total: notification.tokenUsage.total,
        modelContextWindow: notification.tokenUsage.modelContextWindow,
        redaction: "not_required",
      }),
    }),
  });
}

function tokenUsageEqual(left: CodexValidatedTokenUsage, right: CodexValidatedTokenUsage): boolean {
  return (
    tokenUsageBreakdownEqual(left.last, right.last) &&
    tokenUsageBreakdownEqual(left.total, right.total) &&
    left.modelContextWindow === right.modelContextWindow
  );
}

function tokenUsageBreakdownEqual(
  left: CodexValidatedTokenUsage["last"],
  right: CodexValidatedTokenUsage["last"],
): boolean {
  return (
    left.inputTokens === right.inputTokens &&
    left.cachedInputTokens === right.cachedInputTokens &&
    left.cacheWriteInputTokens === right.cacheWriteInputTokens &&
    left.outputTokens === right.outputTokens &&
    left.reasoningOutputTokens === right.reasoningOutputTokens &&
    left.totalTokens === right.totalTokens
  );
}

function tokenUsageBreakdownAtLeast(
  current: CodexValidatedTokenUsage["last"],
  previous: CodexValidatedTokenUsage["last"],
): boolean {
  return (
    current.inputTokens >= previous.inputTokens &&
    current.cachedInputTokens >= previous.cachedInputTokens &&
    current.cacheWriteInputTokens >= previous.cacheWriteInputTokens &&
    current.outputTokens >= previous.outputTokens &&
    current.reasoningOutputTokens >= previous.reasoningOutputTokens &&
    current.totalTokens >= previous.totalTokens
  );
}

function providerMetadataEvent(
  correlation: Readonly<{ threadId?: string; turnId?: string; itemId?: string }>,
): CodexAdapterEvent {
  return Object.freeze({
    kind: "provider_metadata",
    correlation,
    output: Object.freeze({
      category: "provider_metadata",
      kind: "other",
      summary: "Unknown Codex notification metadata was observed.",
      completionState: "complete",
      payload: Object.freeze({ kind: "none", redaction: "not_required" }),
    }),
  });
}

type SnapshottedAdapterTransportEvent =
  | Readonly<{ kind: "notification"; method: unknown; params: unknown }>
  | Readonly<{ kind: "serverRequest"; request: CodexAdapterServerRequestPort }>
  | Readonly<{
      kind: "protocolAnomaly";
      code: "duplicate_or_late_response_id" | "unknown_response_id";
      responseIdType: "number" | "string";
    }>;

function snapshotAdapterTransportEvent(event: unknown): SnapshottedAdapterTransportEvent | undefined {
  const record = inspectTransportEventRecord(event);
  if (record === undefined || typeof record.kind !== "string") return undefined;
  switch (record.kind) {
    case "notification":
      if (!hasExactKeys(record, ["kind", "method"], ["params"])) return undefined;
      return Object.freeze({
        kind: "notification",
        method: record.method,
        params: Object.hasOwn(record, "params") ? record.params : undefined,
      });
    case "serverRequest":
      if (!hasExactKeys(record, ["kind", "request"], [])) return undefined;
      {
        const request = snapshotServerRequest(record.request);
        return request === undefined ? undefined : Object.freeze({ kind: "serverRequest", request });
      }
    case "protocolAnomaly":
      if (
        !hasExactKeys(record, ["kind", "code", "responseIdType"], []) ||
        (record.code !== "duplicate_or_late_response_id" && record.code !== "unknown_response_id") ||
        (record.responseIdType !== "number" && record.responseIdType !== "string")
      ) {
        return undefined;
      }
      return Object.freeze({ kind: "protocolAnomaly", code: record.code, responseIdType: record.responseIdType });
    default:
      return undefined;
  }
}

function inspectTransportEventRecord(value: unknown): Record<string, unknown> | undefined {
  try {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
    const prototype = Object.getPrototypeOf(value) as unknown;
    if (prototype !== Object.prototype && prototype !== null) return undefined;
    const keys = Reflect.ownKeys(value);
    if (keys.length > 3 || keys.some((key) => typeof key !== "string")) return undefined;
    const snapshot = Object.create(null) as Record<string, unknown>;
    for (const key of keys as string[]) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) return undefined;
      snapshot[key] = descriptor.value as unknown;
    }
    return snapshot;
  } catch {
    return undefined;
  }
}

function hasExactKeys(
  record: Readonly<Record<string, unknown>>,
  required: readonly string[],
  optional: readonly string[],
): boolean {
  const allowed = new Set([...required, ...optional]);
  const keys = Object.keys(record);
  return required.every((key) => Object.hasOwn(record, key)) && keys.every((key) => allowed.has(key));
}

function snapshotServerRequest(request: unknown): CodexAdapterServerRequestPort | undefined {
  try {
    if (typeof request !== "object" || request === null) return undefined;
    const methodDescriptor = Object.getOwnPropertyDescriptor(request, "method");
    const paramsDescriptor = Object.getOwnPropertyDescriptor(request, "params");
    if (
      methodDescriptor === undefined ||
      !("value" in methodDescriptor) ||
      typeof methodDescriptor.value !== "string" ||
      paramsDescriptor === undefined ||
      !("value" in paramsDescriptor)
    )
      return undefined;
    const method = methodDescriptor.value;
    if (!(
      method.length > 0 &&
      method.length <= CODEX_ADAPTER_LIMITS.maxMethodCharacters &&
      Buffer.byteLength(method, "utf8") <= CODEX_ADAPTER_LIMITS.maxShortStringBytes
    ))
      return undefined;
    const identity = readRequestIdentity(request);
    const respond = dataMethod(request, "respond");
    if (identity === undefined || respond === undefined) return undefined;
    const releaseUpstreamPayload = dataMethod(request, "releasePayload");
    let params = paramsDescriptor.value;
    let released = false;
    if (releaseUpstreamPayload !== undefined) {
      Reflect.apply(releaseUpstreamPayload, request, []);
    } else if (paramsDescriptor.writable !== true || !Reflect.set(request, "params", undefined, request)) {
      return undefined;
    }
    return Object.freeze({
      identity,
      method,
      get params() {
        return params;
      },
      respond: (result: unknown) =>
        Promise.resolve(Reflect.apply(respond, request, [result]) as unknown).then(() => undefined),
      releasePayload: () => {
        if (released) return;
        released = true;
        params = undefined;
      },
    });
  } catch {
    return undefined;
  }
}

function readRequestIdentity(request: object): CodexAdapterServerRequestPort["identity"] | undefined {
  let current: object | null = request;
  for (let depth = 0; depth < 4 && current !== null; depth += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(current, "identity");
    if (descriptor !== undefined) {
      const value =
        "value" in descriptor
          ? descriptor.value
          : typeof descriptor.get === "function"
            ? Reflect.apply(descriptor.get, request, [])
            : undefined;
      return typeof value === "object" && value !== null
        ? (value as CodexAdapterServerRequestPort["identity"])
        : undefined;
    }
    current = Object.getPrototypeOf(current) as object | null;
  }
  return undefined;
}

function dataMethod(value: object, key: string): ((...args: readonly unknown[]) => unknown) | undefined {
  let current: object | null = value;
  for (let depth = 0; depth < 4 && current !== null; depth += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(current, key);
    if (descriptor !== undefined)
      return "value" in descriptor && typeof descriptor.value === "function"
        ? (descriptor.value as (...args: readonly unknown[]) => unknown)
        : undefined;
    current = Object.getPrototypeOf(current) as object | null;
  }
  return undefined;
}

function inspectServerRequestOwner(params: unknown): Readonly<{ threadId: string; turnId: string }> | undefined {
  try {
    if (typeof params !== "object" || params === null || Array.isArray(params)) return undefined;
    const prototype = Object.getPrototypeOf(params) as unknown;
    if (prototype !== Object.prototype && prototype !== null) return undefined;
    const threadDescriptor = Object.getOwnPropertyDescriptor(params, "threadId");
    const turnDescriptor = Object.getOwnPropertyDescriptor(params, "turnId");
    if (
      threadDescriptor === undefined ||
      !("value" in threadDescriptor) ||
      turnDescriptor === undefined ||
      !("value" in turnDescriptor) ||
      typeof threadDescriptor.value !== "string" ||
      typeof turnDescriptor.value !== "string"
    )
      return undefined;
    return Object.freeze({ threadId: threadDescriptor.value, turnId: turnDescriptor.value });
  } catch {
    return undefined;
  }
}

function stripTerminalContent(
  event: Extract<CodexAdapterEvent, { kind: "turn_terminal" }>,
): Extract<CodexAdapterEvent, { kind: "turn_terminal" }> {
  return Object.freeze({
    ...event,
    finalAssistantMessage: null,
    contentFailure: null,
    resourceLimitExceeded: true,
  });
}

function eventTextBytes(event: CodexAdapterEvent): number {
  switch (event.kind) {
    case "item_output":
    case "turn_output":
      return event.output.payload.kind === "text" ? Buffer.byteLength(event.output.payload.text, "utf8") : 0;
    case "turn_terminal":
      return (
        event.finalAssistantMessage?.contentBlocks.reduce(
          (total, block) => total + Buffer.byteLength(block.text, "utf8"),
          0,
        ) ?? 0
      );
    default:
      return 0;
  }
}

function jsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function adapterClosedError(): Error {
  return new Error("Codex Adapter is closed.");
}

function adapterEventWaiterError(): Error {
  return new Error("Codex Adapter already has an event waiter.");
}

type ExpectedThreadConfiguration = Readonly<{
  model?: string;
  workspaceKey?: string;
  approvalPolicy?: "never" | "untrusted" | "on-request";
  sandboxMode?: "read-only" | "workspace-write" | "danger-full-access";
  ephemeral?: boolean;
}>;

type OperationSnapshots<T> =
  | Readonly<{ ok: true; input: T; requestOptions: CodexAdapterRequestOptions }>
  | Readonly<{
      ok: false;
      result: Readonly<{ kind: "not_sent"; effect: "none"; code: "invalid_input" }>;
    }>;

function snapshotOperationInputs<T>(
  input: Readonly<{ ok: true; value: T }> | Readonly<{ ok: false }>,
  requestOptions: unknown,
): OperationSnapshots<T> {
  const options = snapshotAdapterRequestOptions(requestOptions);
  if (!input.ok || !options.ok) {
    return Object.freeze({
      ok: false,
      result: Object.freeze({ kind: "not_sent", effect: "none", code: "invalid_input" }),
    });
  }
  return Object.freeze({ ok: true, input: input.value, requestOptions: options.value });
}

function snapshotCapabilityPreflightInput(
  value: unknown,
): Readonly<{ ok: true; value: CodexAdapterCapabilityPreflightInput }> | Readonly<{ ok: false }> {
  try {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return Object.freeze({ ok: false });
    const prototype = Object.getPrototypeOf(value) as unknown;
    if (prototype !== Object.prototype && prototype !== null) return Object.freeze({ ok: false });
    const keys = ["model", "modelSelection", "reasoningEffort", "requiredModality"] as const;
    const actualKeys = Object.keys(value);
    if (actualKeys.length !== keys.length || actualKeys.some((key) => !keys.includes(key as (typeof keys)[number]))) {
      return Object.freeze({ ok: false });
    }
    const record = value as Readonly<Record<string, unknown>>;
    const entries = Object.fromEntries(
      keys.map((key) => {
        const descriptor = Object.getOwnPropertyDescriptor(record, key);
        if (descriptor === undefined || !("value" in descriptor)) throw new TypeError("Invalid capability input.");
        return [key, descriptor.value] as const;
      }),
    );
    const model = entries.model;
    const modelSelection = entries.modelSelection;
    const reasoningEffort = entries.reasoningEffort;
    const requiredModality = entries.requiredModality;
    if (
      !isBoundedCapabilityString(model) ||
      (modelSelection !== "explicit" && modelSelection !== "inherited") ||
      !isBoundedCapabilityString(reasoningEffort) ||
      (requiredModality !== "text" && requiredModality !== "image" && requiredModality !== "audio")
    ) {
      return Object.freeze({ ok: false });
    }
    return Object.freeze({
      ok: true,
      value: Object.freeze({ model, modelSelection, reasoningEffort, requiredModality }),
    });
  } catch {
    return Object.freeze({ ok: false });
  }
}

function isBoundedCapabilityString(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= CODEX_ADAPTER_LIMITS.maxIdentifierCharacters &&
    Buffer.byteLength(value, "utf8") <= CODEX_ADAPTER_LIMITS.maxIdentifierBytes &&
    !value.includes("\0")
  );
}

function toCodexUserInput(contentBlocks: CodexStartTurnInput["contentBlocks"]): readonly unknown[] {
  return Object.freeze(
    contentBlocks.map((block) => Object.freeze({ type: "text", text: block.text, text_elements: Object.freeze([]) })),
  );
}

function toCodexSandboxPolicy(policy: CodexAdapterSandboxPolicy): unknown {
  switch (policy.mode) {
    case "read-only":
      return Object.freeze({ type: "readOnly", networkAccess: policy.networkAccess });
    case "workspace-write":
      return Object.freeze({
        type: "workspaceWrite",
        writableRoots: policy.writableRoots,
        networkAccess: policy.networkAccess,
        excludeTmpdirEnvVar: true,
        excludeSlashTmp: true,
      });
    case "danger-full-access":
      return Object.freeze({ type: "dangerFullAccess" });
  }
}

function mapReadFailure(error: unknown): CodexAdapterReadResult<never> {
  const failure = snapshotTransportFailure(error);
  if (failure === undefined) return connectionReadFailure("protocol_failed");
  switch (failure.kind) {
    case "request_not_sent":
      return notSent(failure.code);
    case "remote_error":
      return Object.freeze({ kind: "rejected", effect: "none", code: failure.code });
    case "response_unknown":
      return Object.freeze({ kind: "ambiguous", effect: "none", code: failure.code });
    case "connection_failure":
      return connectionReadFailure(failure.code);
  }
}

function mapMutationFailure(error: unknown): CodexAdapterMutationResult<never> {
  const failure = snapshotTransportFailure(error);
  if (failure === undefined) return connectionMutationFailure("protocol_failed");
  switch (failure.kind) {
    case "request_not_sent":
      return notSentMutation(failure.code);
    case "remote_error":
      return Object.freeze({ kind: "rejected", effect: "none", code: failure.code });
    case "response_unknown":
      return Object.freeze({ kind: "ambiguous", effect: "unknown", code: failure.code });
    case "connection_failure":
      return connectionMutationFailure(failure.code);
  }
}

function snapshotTransportFailure(error: unknown): CodexTransportFailure | undefined {
  try {
    if (!(error instanceof CodexTransportError)) return undefined;
    const failureDescriptor = Object.getOwnPropertyDescriptor(error, "failure");
    if (failureDescriptor === undefined || !("value" in failureDescriptor)) return undefined;
    const failure = failureDescriptor.value as unknown;
    if (typeof failure !== "object" || failure === null || Array.isArray(failure)) return undefined;
    if (Object.getPrototypeOf(failure) !== Object.prototype) return undefined;
    const descriptors = Object.getOwnPropertyDescriptors(failure);
    const keys = Reflect.ownKeys(descriptors);
    if (keys.some((key) => typeof key !== "string")) return undefined;
    const kind = dataDescriptorValue(descriptors.kind);
    if (kind === "request_not_sent") {
      const code = dataDescriptorValue(descriptors.code);
      return keys.length === 2 && REQUEST_NOT_SENT_CODES.has(code)
        ? Object.freeze({ kind, code: code as CodexRequestNotSentCode })
        : undefined;
    }
    if (kind === "response_unknown") {
      const code = dataDescriptorValue(descriptors.code);
      return keys.length === 2 && RESPONSE_UNKNOWN_CODES.has(code)
        ? Object.freeze({ kind, code: code as CodexResponseUnknownCode })
        : undefined;
    }
    if (kind === "connection_failure") {
      const code = dataDescriptorValue(descriptors.code);
      return keys.length === 2 && CONNECTION_FAILURE_CODES.has(code)
        ? Object.freeze({ kind, code: code as CodexConnectionFailureCode })
        : undefined;
    }
    if (kind === "remote_error") {
      const code = dataDescriptorValue(descriptors.code);
      return keys.length === 2 && Number.isSafeInteger(code)
        ? Object.freeze({ kind, code: code as number })
        : undefined;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

function dataDescriptorValue(descriptor: PropertyDescriptor | undefined): unknown {
  return descriptor !== undefined && "value" in descriptor && descriptor.enumerable ? descriptor.value : undefined;
}

function notSent(code: CodexAdapterNotSentCode): Readonly<{
  kind: "not_sent";
  effect: "none";
  code: CodexAdapterNotSentCode;
}> {
  return Object.freeze({ kind: "not_sent", effect: "none", code });
}

function notSentMutation(code: CodexAdapterMutationNotSentCode): CodexAdapterMutationResult<never> {
  return Object.freeze({ kind: "not_sent", effect: "none", code });
}

function modelCapabilityMutationFailure(
  capability: Exclude<ModelCapabilityValidation, Readonly<{ kind: "valid" }>>,
): CodexAdapterMutationResult<never> {
  if (capability.kind === "invalid") return notSentMutation("invalid_input");
  const failure = capability.failure;
  if (failure.kind === "rejected") {
    return Object.freeze({ kind: "rejected", effect: "none", code: failure.code });
  }
  return notSentMutation(failure.code);
}

function invalidReadResponse(): CodexAdapterReadResult<never> {
  return Object.freeze({ kind: "invalid_response", effect: "none", code: "invalid_response" });
}

function ambiguousInvalidResponse(): CodexAdapterMutationResult<never> {
  return Object.freeze({ kind: "ambiguous", effect: "unknown", code: "invalid_response" });
}

function connectionReadFailure(code: CodexConnectionFailureCode): Readonly<{
  kind: "connection_failure";
  effect: "none";
  code: CodexConnectionFailureCode;
}>;
function connectionReadFailure(code: CodexAdapterConnectionFailureCode): Readonly<{
  kind: "connection_failure";
  effect: "none";
  code: CodexAdapterConnectionFailureCode;
}>;
function connectionReadFailure(code: CodexAdapterConnectionFailureCode) {
  return Object.freeze({ kind: "connection_failure", effect: "none", code });
}

function connectionMutationFailure(code: CodexConnectionFailureCode): CodexAdapterMutationResult<never> {
  return Object.freeze({ kind: "connection_failure", effect: "unknown", code });
}
