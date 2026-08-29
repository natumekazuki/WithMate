import { createHash } from "node:crypto";

import { approvalModeOptions } from "../src/approval-mode.js";
import { codexSandboxModeOptions } from "../src/codex-sandbox-mode.js";
import {
  COORDINATION_EVENT_DEFAULT_LIST_LIMIT,
  COORDINATION_EVENT_KINDS,
  COORDINATION_EVENT_MAX_LIST_LIMIT,
  COORDINATION_EVENT_STATES,
  CoordinationEventValidationError,
  type CoordinationEventCancelInput,
  type CoordinationEventConsumeInput,
  type CoordinationEventCorrectInput,
  type CoordinationEventCreateInput,
  type CoordinationEventGetInput,
  type CoordinationEventListInput,
  type CoordinationEventResolveInput,
} from "../src/coordination-event.js";

import {
  SESSION_RUNTIME_REQUEST_SCHEMA_VERSION,
  SESSION_RUNTIME_DEFAULT_WAIT_TIMEOUT_MS,
  SESSION_RUNTIME_MAX_RESPONSE_BYTES,
  SessionRuntimeProjectionLimitError,
  SessionRuntimeValidationError,
  createSessionRuntimeError,
  createSessionRuntimeResult,
  parseSessionRuntimeRequestEnvelope,
  projectSessionExecution,
  type SessionRuntimeCancelInput,
  type SessionRuntimeCatalogResult,
  type SessionRuntimeCreateInput,
  type SessionRuntimeEnqueueInput,
  type SessionRuntimeError,
  type SessionRuntimeExecutionInput,
  type SessionRuntimeFileListInput,
  type SessionRuntimeFileReadTextInput,
  type SessionRuntimeFileWriteTextInput,
  type SessionRuntimeInteractionListInput,
  type SessionRuntimeInteractionRespondInput,
  type SessionRuntimeInteractionRespondResult,
  type SessionRuntimeListInput,
  type SessionRuntimeOperation,
  type SessionRuntimePublicExecution,
  projectSessionInteraction,
  type SessionRuntimeResultByOperation,
  type SessionRuntimeResultEnvelope,
  type SessionRuntimeRunInput,
  type SessionRuntimeRenameInput,
  type SessionRuntimeSessionInput,
  type SessionRuntimeSessionListInput,
  type SessionRuntimeTurnOptionsResult,
  type SessionRuntimeTerminalFailureNotificationProjection,
  type SessionRuntimeTranscriptExportInput,
  type SessionRuntimeWorkItemCancelInput,
  type SessionRuntimeWorkItemCreateInput,
  type SessionRuntimeWorkItemInput,
  type SessionRuntimeWorkItemReviseInput,
  type SessionRuntimeWorkItemHistoryAppendInput,
  type SessionRuntimeWorkItemHistoryListInput,
  type SessionRuntimeWorkItemHistoryListResult,
  type SessionRuntimeWorkItemListInput,
  type SessionRuntimeWorkItemListResult,
  type SessionRuntimeWorkItemResultInput,
  type SessionRuntimeWorkItemTransitionInput,
  type SessionRuntimeWorkItemAggregationGetInput,
  type SessionRuntimeWorkItemAggregationListInput,
  type SessionRuntimeWorkItemAggregationListResult,
  type SessionRuntimeWorkItemAggregationDecisionInput,
  type SessionRuntimeWorkItemAggregationRetryInput,
} from "../src/session-external-runtime-contract.js";
import type { ModelCatalogSnapshot } from "../src/model-catalog.js";
import {
  SESSION_ROLE_CHILDREN,
  SESSION_ROLE_CONTRACT_REVISION,
  SESSION_ROLE_MAX_DELEGATION_DEPTH,
  SESSION_ROLE_VALUES,
  requireSessionRoleBinding,
} from "../src/session-role-binding.js";
import {
  SESSION_TURN_COMMUNICATION_CONTRACT_REVISION,
  canSendSessionTurn,
  type SessionTurnAuthoritySession,
} from "../src/session-turn-communication-authority.js";
import {
  WORK_ITEM_CONTRACT_REVISION,
  WORK_ITEM_AGGREGATION_CONTRACT_REVISION,
  WORK_ITEM_AGGREGATION_DECISIONS,
  WORK_ITEM_AGGREGATION_DEFAULT_LIST_LIMIT,
  WORK_ITEM_AGGREGATION_MAX_LIST_LIMIT,
  WORK_ITEM_DEFAULT_LIST_LIMIT,
  WORK_ITEM_MAX_LIST_LIMIT,
  WORK_ITEM_MAX_RESULT_BYTES,
  WORK_ITEM_STATES,
} from "../src/work-item.js";
import type { SessionExecution, TurnInitiator } from "../src/session-execution.js";
import {
  SessionInteractionContinuationUnavailableError,
  SessionInteractionKindMismatchError,
  type SessionInteractionService,
} from "./session-interaction-service.js";
import {
  SessionInteractionAlreadyResolvedError,
  SessionInteractionIdempotencyConflictError,
  SessionInteractionNotFoundError,
  SessionInteractionTargetMismatchError,
} from "./session-interaction-storage-v6.js";
import type { SessionExecutionPublicProgressStorageV6 } from "./session-execution-public-progress-storage-v6.js";
import { SessionTurnValidationError } from "./session-turn-validation-error.js";
import {
  SessionExecutionNotFoundError,
  SessionExecutionOwnerMismatchError,
  SessionExecutionShuttingDownError,
  type SessionExecutionService,
} from "./session-execution-service.js";
import {
  SessionExecutionBusyError,
  SessionExecutionIdempotencyConflictError,
  SessionExecutionQueueFullError,
  SessionExecutionStateConflictError,
  SessionExecutionWorkItemAssociationError,
} from "./session-execution-storage-v6.js";
import { SessionCrudError, type SessionCrudService } from "./session-crud-service.js";
import { SessionFileServiceError, type SessionFileService } from "./session-file-service.js";
import { SessionTranscriptServiceError, type SessionTranscriptService } from "./session-transcript-service.js";
import type { ResolvedAgentRuntimeBinding } from "./agent-runtime-binding.js";
import { CoordinationEventPublicationError, type CoordinationEventService } from "./coordination-event-service.js";
import {
  CoordinationEventIdempotencyConflictError,
  CoordinationEventNotFoundError,
  CoordinationEventStateConflictError,
} from "./coordination-event-storage-v6.js";
import {
  TERMINAL_FAILURE_NOTIFICATION_CONTRACT_VERSION,
  type SessionExecutionTerminalFailureNotification,
} from "./session-execution-turn-request.js";
import {
  WorkItemAuthorityError,
  WorkItemExecutionAssociationError,
  WorkItemParentError,
  type WorkItemListScope,
  type WorkItemService,
} from "./work-item-service.js";
import {
  WorkItemIdempotencyConflictError,
  WorkItemNotFoundError,
  WorkItemRevisionConflictError,
  WorkItemResultTooLargeError,
  WorkItemStateConflictError,
  WorkItemAggregationConflictError,
} from "./work-item-storage-v6.js";

export type SessionExternalApplicationServiceDeps = {
  executionService: Pick<
    SessionExecutionService,
    "beginShutdown" | "run" | "enqueue" | "get" | "listPage" | "cancel" | "waitForTerminal" | "resolveReplay"
  > & Partial<Pick<SessionExecutionService, "getRecord">>;
  interactionService?: Pick<
    SessionInteractionService,
    "getPendingForExecution" | "listSessionInteractionsPage" | "respond" | "subscribeExecution"
  >;
  progressStorage?: Pick<SessionExecutionPublicProgressStorageV6, "get">;
  transcriptService?: Pick<SessionTranscriptService, "export">;
  coordinationService?: Pick<
    CoordinationEventService,
    "create" | "list" | "get" | "resolve" | "consume" | "cancel" | "correct"
  >;
  crudService: Pick<SessionCrudService, "create" | "list" | "get" | "rename">;
  fileService?: Pick<SessionFileService, "list" | "readText" | "writeText">;
  currentModelCatalog(): ModelCatalogSnapshot | null;
  isProviderEnabled(providerId: string): boolean;
  isProviderSupported(providerId: string): boolean;
  discoverSessionCustomAgents(workspacePath: string): Promise<Array<{
    name: string;
    displayName: string;
    description: string;
  }>>;
  resolveTurnInitiator(actorSessionId: string): Promise<Extract<TurnInitiator, { kind: "session" }> | null>;
  getTurnAuthoritySession(sessionId: string): SessionTurnAuthoritySession | null;
  projectTerminalFailureNotification?(
    execution: SessionExecution,
    request: unknown,
  ): SessionRuntimeTerminalFailureNotificationProjection | null;
  workItemService?: Pick<
    WorkItemService,
    "create" | "get" | "resolveListScope" | "iterateList" | "transition" | "reportResult" | "cancel" | "requireExecutionAssociation"
    | "getAggregation" | "listAggregation" | "decideAggregation" | "retryAggregation" | "revise" | "appendHistory" | "listHistory"
  >;
  getExecutionWorkItemId?(executionId: string): string | null;
};

export type SessionExternalApplicationResponse = SessionRuntimeResultEnvelope | SessionRuntimeError;

export class SessionExternalApplicationService {
  private accepting = true;

  constructor(private readonly deps: SessionExternalApplicationServiceDeps) {}

  beginShutdown(): void {
    this.accepting = false;
    this.deps.executionService.beginShutdown();
  }

  async execute(
    operation: SessionRuntimeOperation | string,
    input: unknown,
    agentRuntimeBinding: ResolvedAgentRuntimeBinding | null,
  ): Promise<SessionExternalApplicationResponse> {
    if (!this.accepting) {
      return createSessionRuntimeError({
        code: "RUNTIME_SHUTTING_DOWN",
        message: "The Session runtime is shutting down.",
      });
    }
    try {
      const request = parseSessionRuntimeRequestEnvelope({
        schemaVersion: SESSION_RUNTIME_REQUEST_SCHEMA_VERSION,
        operation,
        input,
      });
      if (!agentRuntimeBinding) {
        throw new SessionRuntimeValidationError(
          "Session runtime actor binding is required for this operation.",
          { field: "agentRuntimeBinding" },
          "SESSION_BINDING_REQUIRED",
        );
      }
      const result = await this.executeValidated(request.operation, request.input, agentRuntimeBinding);
      const response = createSessionRuntimeResult(request.operation, result);
      assertApplicationResponseSize(request.operation, result, response);
      return response;
    } catch (error) {
      return mapApplicationError(error, operation, input);
    }
  }

  private async executeValidated(
    operation: SessionRuntimeOperation,
    input: unknown,
    agentRuntimeBinding: ResolvedAgentRuntimeBinding,
  ): Promise<SessionRuntimeResultByOperation[SessionRuntimeOperation]> {
    if (operation === "runtime.catalog") {
      return projectRuntimeCatalog(
        this.requireCurrentModelCatalog(),
        this.deps.isProviderEnabled,
        (providerId) => this.isProviderSupported(providerId),
      );
    }
    if (operation === "session.self") {
      const session = await this.deps.crudService.get(agentRuntimeBinding.actorSessionId);
      return {
        sessionId: session.sessionId,
        sessionRole: session.sessionRole,
        roleContractRevision: session.roleContractRevision,
        rootSessionId: session.rootSessionId,
        parentSessionId: session.parentSessionId,
        delegationDepth: session.delegationDepth,
      };
    }
    if (operation === "session.create") {
      return this.deps.crudService.create(input as SessionRuntimeCreateInput, agentRuntimeBinding.actorSessionId);
    }
    if (operation === "session.list") {
      return this.deps.crudService.list(input as SessionRuntimeSessionListInput);
    }
    if (operation === "session.get") {
      return this.deps.crudService.get((input as SessionRuntimeSessionInput).sessionId);
    }
    if (operation === "session.rename") {
      return this.deps.crudService.rename(input as SessionRuntimeRenameInput);
    }
    if (operation === "session.files.list") {
      return this.requireFileService().list(input as SessionRuntimeFileListInput);
    }
    if (operation === "session.files.read_text") {
      return this.requireFileService().readText(input as SessionRuntimeFileReadTextInput);
    }
    if (operation === "session.files.write_text") {
      return this.requireFileService().writeText(input as SessionRuntimeFileWriteTextInput);
    }
    if (operation === "work.create") {
      return this.requireWorkItemService().create(input as SessionRuntimeWorkItemCreateInput, agentRuntimeBinding);
    }
    if (operation === "work.get") {
      return this.requireWorkItemService().get((input as SessionRuntimeWorkItemInput).workItemId, agentRuntimeBinding);
    }
    if (operation === "work.revise") {
      return this.requireWorkItemService().revise(input as SessionRuntimeWorkItemReviseInput, agentRuntimeBinding);
    }
    if (operation === "work.history.append") {
      return this.requireWorkItemService().appendHistory(input as SessionRuntimeWorkItemHistoryAppendInput, agentRuntimeBinding);
    }
    if (operation === "work.history.list") {
      return this.listWorkItemHistory(input as SessionRuntimeWorkItemHistoryListInput, agentRuntimeBinding);
    }
    if (operation === "work.list") {
      return this.listWorkItems(input as SessionRuntimeWorkItemListInput, agentRuntimeBinding);
    }
    if (operation === "work.transition") {
      return this.requireWorkItemService().transition(input as SessionRuntimeWorkItemTransitionInput, agentRuntimeBinding);
    }
    if (operation === "work.result") {
      return this.requireWorkItemService().reportResult(input as SessionRuntimeWorkItemResultInput, agentRuntimeBinding);
    }
    if (operation === "work.cancel") {
      return this.requireWorkItemService().cancel(input as SessionRuntimeWorkItemCancelInput, agentRuntimeBinding);
    }
    if (operation === "work.aggregation.get") {
      return this.requireWorkItemService().getAggregation(input as SessionRuntimeWorkItemAggregationGetInput, agentRuntimeBinding);
    }
    if (operation === "work.aggregation.list") {
      return this.listWorkItemAggregation(input as SessionRuntimeWorkItemAggregationListInput, agentRuntimeBinding);
    }
    if (operation === "work.aggregation.decide") {
      return this.requireWorkItemService().decideAggregation(input as SessionRuntimeWorkItemAggregationDecisionInput, agentRuntimeBinding);
    }
    if (operation === "work.aggregation.retry") {
      return this.requireWorkItemService().retryAggregation(input as SessionRuntimeWorkItemAggregationRetryInput, agentRuntimeBinding);
    }
    if (operation === "turn.options") {
      return this.turnOptions((input as SessionRuntimeSessionInput).sessionId);
    }
    if (operation === "turn.run") {
      return this.run(input as SessionRuntimeRunInput, agentRuntimeBinding);
    }
    if (operation === "turn.enqueue") {
      return this.enqueue(input as SessionRuntimeEnqueueInput, agentRuntimeBinding);
    }
    if (operation === "turn.list") {
      return this.list(input as SessionRuntimeListInput);
    }
    if (operation === "turn.get") {
      const request = input as SessionRuntimeExecutionInput;
      return this.projectExecution(request.sessionId, request.executionId);
    }
    if (operation === "turn.cancel") {
      const request = input as SessionRuntimeCancelInput;
      const execution = await this.deps.executionService.cancel({
        ...request,
        requestFingerprint: fingerprintCancel(request),
      });
      return this.projectExecution(execution.sessionId, execution.id, execution);
    }
    if (operation === "interaction.list") {
      return this.listInteractions(input as SessionRuntimeInteractionListInput);
    }
    if (operation === "interaction.respond") {
      return this.respondToInteraction(input as SessionRuntimeInteractionRespondInput);
    }
    if (operation === "coordination.event.create") {
      return this.requireCoordinationService().create(input as CoordinationEventCreateInput, agentRuntimeBinding);
    }
    if (operation === "coordination.event.list") {
      return this.requireCoordinationService().list(input as CoordinationEventListInput, agentRuntimeBinding);
    }
    if (operation === "coordination.event.get") {
      return this.requireCoordinationService().get(input as CoordinationEventGetInput, agentRuntimeBinding);
    }
    if (operation === "coordination.event.resolve") {
      return this.requireCoordinationService().resolve(input as CoordinationEventResolveInput, agentRuntimeBinding);
    }
    if (operation === "coordination.event.consume") {
      return this.requireCoordinationService().consume(input as CoordinationEventConsumeInput, agentRuntimeBinding);
    }
    if (operation === "coordination.event.cancel") {
      return this.requireCoordinationService().cancel(input as CoordinationEventCancelInput, agentRuntimeBinding);
    }
    if (operation === "coordination.event.correct") {
      return this.requireCoordinationService().correct(input as CoordinationEventCorrectInput, agentRuntimeBinding);
    }
    if (operation === "transcript.export") {
      return this.requireTranscriptService().export(input as SessionRuntimeTranscriptExportInput);
    }
    throw new SessionRuntimeValidationError("Unsupported Session runtime operation.", { field: "operation" });
  }

  private async run(
    input: SessionRuntimeRunInput,
    agentRuntimeBinding: ResolvedAgentRuntimeBinding,
  ): Promise<SessionRuntimePublicExecution> {
    const initiatorIdentity = sessionInitiatorIdentity(agentRuntimeBinding.actorSessionId);
    const mutation = {
      sessionId: input.sessionId,
      request: { catalogRevision: input.catalogRevision, turn: input.turn },
      idempotencyKey: input.idempotencyKey,
      requestFingerprint: fingerprintMutation(input, initiatorIdentity),
    };
    const replay = this.deps.executionService.resolveReplay("turn.run", mutation);
    if (!replay) {
      this.requireCurrentCatalog(input.catalogRevision);
    }
    const execution = replay ?? await this.deps.executionService.run({
      ...mutation,
      ...this.resolveWorkItemAssociation(input, agentRuntimeBinding),
      ...await this.resolveTurnAcceptance(agentRuntimeBinding.actorSessionId, input.sessionId, input.turn.userMessage),
      request: {
        initiator: await this.requireTurnInitiator(agentRuntimeBinding.actorSessionId),
        catalogRevision: input.catalogRevision,
        ...await this.resolveTerminalFailureNotification(input),
        turn: input.turn,
      },
    });
    if (input.responseMode === "deferred") {
      return this.projectExecution(execution.sessionId, execution.id, execution);
    }
    const timeoutMs = input.waitTimeoutMs ?? SESSION_RUNTIME_DEFAULT_WAIT_TIMEOUT_MS;
    await this.waitForObservation(input.sessionId, execution.id, timeoutMs);
    return this.projectExecution(input.sessionId, execution.id, execution);
  }

  private async turnOptions(sessionId: string): Promise<SessionRuntimeTurnOptionsResult> {
    const session = await this.deps.crudService.get(sessionId);
    const snapshot = this.requireCurrentModelCatalog();
    const provider = snapshot.providers.find((candidate) => candidate.id === session.provider.id);
    if (!provider) {
      throw new SessionRuntimeValidationError(
        "The Session provider is unavailable in the current model catalog.",
        { providerId: session.provider.id },
        "RUNTIME_UNAVAILABLE",
      );
    }
    if (!this.isProviderSupported(provider.id)) {
      throw new SessionRuntimeValidationError(
        "Turn options are unavailable for this Session provider.",
        { providerId: provider.id },
        "RUNTIME_UNAVAILABLE",
      );
    }
    if (!this.deps.isProviderEnabled(provider.id)) {
      throw new SessionRuntimeValidationError(
        "The Session provider is disabled.",
        { providerId: provider.id },
        "PROVIDER_DISABLED",
      );
    }
    const common = {
      sessionId: session.sessionId,
      catalogRevision: snapshot.revision,
      models: provider.models.map((model) => ({
        id: model.id,
        label: model.label,
        reasoningEfforts: [...model.reasoningEfforts],
      })),
      approvalModes: approvalModeOptions.map((option) => ({ ...option })),
    };
    const result: SessionRuntimeTurnOptionsResult = provider.id === "codex"
      ? {
        ...common,
        provider: { id: "codex" },
        codexSandboxModes: codexSandboxModeOptions.map((option) => ({ ...option })),
      }
      : {
        ...common,
        provider: { id: "copilot" },
        customAgents: [
          { name: "", displayName: "Default", description: "" },
          ...await (this.deps.discoverSessionCustomAgents?.(session.workspace.path) ?? Promise.resolve([])),
        ],
      };
    if (
      Buffer.byteLength(JSON.stringify(createSessionRuntimeResult("turn.options", result)), "utf8")
      > SESSION_RUNTIME_MAX_RESPONSE_BYTES
    ) {
      throw new SessionRuntimeProjectionLimitError("result");
    }
    return result;
  }

  private async enqueue(
    input: SessionRuntimeEnqueueInput,
    agentRuntimeBinding: ResolvedAgentRuntimeBinding,
  ): Promise<SessionRuntimePublicExecution> {
    const initiatorIdentity = sessionInitiatorIdentity(agentRuntimeBinding.actorSessionId);
    const mutation = {
      sessionId: input.sessionId,
      request: { catalogRevision: input.catalogRevision, turn: input.turn },
      idempotencyKey: input.idempotencyKey,
      requestFingerprint: fingerprintMutation(input, initiatorIdentity),
    };
    const replay = this.deps.executionService.resolveReplay("turn.enqueue", mutation);
    if (!replay) {
      this.requireCurrentCatalog(input.catalogRevision);
    }
    const execution = replay ?? await this.deps.executionService.enqueue({
      ...mutation,
      ...this.resolveWorkItemAssociation(input, agentRuntimeBinding),
      ...await this.resolveTurnAcceptance(agentRuntimeBinding.actorSessionId, input.sessionId, input.turn.userMessage),
      request: {
        initiator: await this.requireTurnInitiator(agentRuntimeBinding.actorSessionId),
        catalogRevision: input.catalogRevision,
        ...await this.resolveTerminalFailureNotification(input),
        turn: input.turn,
      },
    });
    return this.projectExecution(execution.sessionId, execution.id, execution);
  }

  private async resolveTerminalFailureNotification(
    input: SessionRuntimeEnqueueInput,
  ): Promise<{ terminalFailureNotification?: SessionExecutionTerminalFailureNotification }> {
    const notification = input.terminalFailureNotification;
    if (!notification) return {};
    if (notification.targetSessionId === input.sessionId) {
      throw new SessionRuntimeValidationError(
        "The terminal failure notification target must differ from the source Session.",
        { sessionId: input.sessionId, targetSessionId: notification.targetSessionId },
        "TERMINAL_NOTIFICATION_SAME_SESSION",
      );
    }
    this.requireSessionTurnAuthority(input.sessionId, notification.targetSessionId);
    const sourceSession = await this.requireTurnInitiator(input.sessionId);
    return {
      terminalFailureNotification: {
        contractVersion: TERMINAL_FAILURE_NOTIFICATION_CONTRACT_VERSION,
        targetSessionId: notification.targetSessionId,
        sourceSession,
      },
    };
  }

  private async requireTurnInitiator(
    actorSessionId: string,
  ): Promise<Extract<TurnInitiator, { kind: "session" }>> {
    const initiator = await this.deps.resolveTurnInitiator(actorSessionId);
    if (!initiator || initiator.sessionId !== actorSessionId) {
      throw new SessionRuntimeValidationError(
        "The actor Session character snapshot is unavailable.",
        { sessionId: actorSessionId },
        "SESSION_INITIATOR_UNAVAILABLE",
      );
    }
    return initiator;
  }

  private async resolveTurnAcceptance(
    actorSessionId: string,
    targetSessionId: string,
    userMessage: string,
  ): Promise<{ origin?: import("../src/session-execution.js").SessionExecutionOriginSnapshot }> {
    const { actor, target } = this.requireSessionTurnAuthority(actorSessionId, targetSessionId);
    if (actor.sessionId === target.sessionId) return {};
    return {
      origin: {
        sourceSessionId: actor.sessionId,
        targetSessionTitle: target.title,
        targetSessionRole: target.sessionRole,
        userMessage,
      },
    };
  }

  private requireSessionTurnAuthority(
    actorSessionId: string,
    targetSessionId: string,
  ): { actor: SessionTurnAuthoritySession; target: SessionTurnAuthoritySession } {
    const actor = this.deps.getTurnAuthoritySession(actorSessionId);
    if (!actor) {
      throw new SessionCrudError(
        "SESSION_NOT_FOUND",
        "The requested Session was not found.",
        false,
        { sessionId: actorSessionId },
      );
    }
    const target = actorSessionId === targetSessionId
      ? actor
      : this.deps.getTurnAuthoritySession(targetSessionId);
    if (!target) {
      throw new SessionCrudError(
        "SESSION_NOT_FOUND",
        "The requested Session was not found.",
        false,
        { sessionId: targetSessionId },
      );
    }
    const actorBinding = requireSessionRoleBinding(actor.sessionId, actor);
    const targetBinding = requireSessionRoleBinding(target.sessionId, target);
    if (!canSendSessionTurn(
      { sessionId: actor.sessionId, ...actorBinding },
      { sessionId: target.sessionId, ...targetBinding },
    )) {
      throw new SessionRuntimeValidationError(
        "The actor Session is not allowed to send a Turn to the target Session.",
        {
          actorSessionId: actor.sessionId,
          targetSessionId: target.sessionId,
          communicationContractRevision: SESSION_TURN_COMMUNICATION_CONTRACT_REVISION,
        },
        "SESSION_TURN_FORBIDDEN",
      );
    }
    return { actor, target };
  }

  private list(input: SessionRuntimeListInput): { items: SessionRuntimePublicExecution[]; nextCursor?: string } {
    const afterSequence = input.cursor ? decodeListCursor(input.cursor, input.sessionId) : null;
    const resultBase: { items: SessionRuntimePublicExecution[]; nextCursor?: string } = {
      items: [],
    };
    let responseBytes = Buffer.byteLength(JSON.stringify(createSessionRuntimeResult("turn.list", resultBase)), "utf8");
    let lastSequence: number | undefined;
    for (const execution of this.deps.executionService.listPage(input.sessionId, afterSequence, input.limit + 1)) {
      if (resultBase.items.length >= input.limit) {
        if (lastSequence !== undefined) {
          resultBase.nextCursor = encodeListCursor(input.sessionId, lastSequence);
          if (
            Buffer.byteLength(JSON.stringify(createSessionRuntimeResult("turn.list", resultBase)), "utf8")
            > SESSION_RUNTIME_MAX_RESPONSE_BYTES
          ) {
            throw new SessionRuntimeProjectionLimitError("result.items");
          }
        }
        break;
      }
      const item = this.projectExecution(input.sessionId, execution.id, execution);
      responseBytes += (resultBase.items.length > 0 ? 1 : 0) + Buffer.byteLength(JSON.stringify(item), "utf8");
      if (responseBytes > SESSION_RUNTIME_MAX_RESPONSE_BYTES) {
        throw new SessionRuntimeProjectionLimitError("result.items");
      }
      resultBase.items.push(item);
      lastSequence = execution.sequence;
    }
    return resultBase;
  }

  private projectExecution(
    sessionId: string,
    executionId: string,
    fallback?: SessionExecution,
  ): SessionRuntimePublicExecution {
    const record = this.deps.executionService.getRecord?.(sessionId, executionId)
      ?? fallback
      ?? this.deps.executionService.get(sessionId, executionId);
    return projectSessionExecution(record, {
      request: "request" in record ? record.request : undefined,
      pendingInteraction: this.deps.interactionService?.getPendingForExecution(executionId) ?? null,
      partialOutput: this.deps.progressStorage?.get(executionId) ?? null,
      terminalFailureNotification: this.deps.projectTerminalFailureNotification?.(
        record,
        "request" in record ? record.request : undefined,
      ) ?? null,
      workItemId: this.deps.getExecutionWorkItemId?.(executionId) ?? null,
    });
  }

  private listInteractions(input: SessionRuntimeInteractionListInput) {
    const filter = {
      ...(input.executionId === undefined ? {} : { executionId: input.executionId }),
      ...(input.kind === undefined ? {} : { kind: input.kind }),
      ...(input.state === undefined ? {} : { state: input.state }),
    };
    const afterSequence = input.cursor ? decodeInteractionCursor(input, input.cursor) : null;
    const interactions = this.requireInteractionService().listSessionInteractionsPage(
      input.sessionId,
      afterSequence,
      input.limit + 1,
      filter,
    );
    const items = interactions.slice(0, input.limit).map(projectSessionInteraction);
    return {
      items,
      ...(interactions.length > input.limit && items.length > 0
        ? { nextCursor: encodeInteractionCursor(input, items[items.length - 1]!.sequence) }
        : {}),
    };
  }

  private listWorkItems(
    input: SessionRuntimeWorkItemListInput,
    binding: ResolvedAgentRuntimeBinding,
  ): SessionRuntimeWorkItemListResult {
    const service = this.requireWorkItemService();
    const scope = service.resolveListScope(binding);
    const cursor = input.cursor ? decodeWorkItemCursor(input, scope, input.cursor) : null;
    const iterator = service.iterateList({
      ...(input.creatorSessionId === undefined ? {} : { creatorSessionId: input.creatorSessionId }),
      ...(input.targetSessionId === undefined ? {} : { targetSessionId: input.targetSessionId }),
      ...(input.state === undefined ? {} : { state: input.state }),
      limit: input.limit + 1,
      afterSequence: cursor,
    }, scope)[Symbol.iterator]();
    const result: SessionRuntimeWorkItemListResult = { items: [] };
    try {
      let current = iterator.next();
      while (!current.done) {
        const item = current.value;
        const next = iterator.next();
        const hasMore = !next.done;
        const candidate: SessionRuntimeWorkItemListResult = {
          items: [...result.items, item],
          ...(hasMore ? { nextCursor: encodeWorkItemCursor(input, scope, item.sequence) } : {}),
        };
        if (
          Buffer.byteLength(JSON.stringify(createSessionRuntimeResult("work.list", candidate)), "utf8")
          > SESSION_RUNTIME_MAX_RESPONSE_BYTES
        ) {
          const lastItem = result.items[result.items.length - 1];
          if (!lastItem) throw new SessionRuntimeProjectionLimitError("result.items");
          result.nextCursor = encodeWorkItemCursor(input, scope, lastItem.sequence);
          break;
        }
        result.items.push(item);
        if (!hasMore) break;
        if (result.items.length >= input.limit) {
          result.nextCursor = candidate.nextCursor;
          break;
        }
        current = next;
      }
    } finally {
      iterator.return?.();
    }
    return result;
  }

  private listWorkItemAggregation(
    input: SessionRuntimeWorkItemAggregationListInput,
    binding: ResolvedAgentRuntimeBinding,
  ): SessionRuntimeWorkItemAggregationListResult {
    const service = this.requireWorkItemService();
    const scope = service.resolveListScope(binding);
    const afterSequence = input.cursor ? decodeWorkItemAggregationCursor(input, scope, input.cursor) : null;
    const items = service.listAggregation({
      parentWorkItemId: input.parentWorkItemId,
      ...(input.decision === undefined ? {} : { decision: input.decision }),
      limit: input.limit + 1,
      afterSequence,
    }, binding);
    const result: SessionRuntimeWorkItemAggregationListResult = { items: [] };
    for (let index = 0; index < items.length && result.items.length < input.limit; index += 1) {
      const item = items[index]!;
      const hasMore = index + 1 < items.length;
      const candidate: SessionRuntimeWorkItemAggregationListResult = {
        items: [...result.items, item],
        ...(hasMore ? { nextCursor: encodeWorkItemAggregationCursor(input, scope, item.child.sequence) } : {}),
      };
      if (Buffer.byteLength(JSON.stringify(createSessionRuntimeResult("work.aggregation.list", candidate)), "utf8")
        > SESSION_RUNTIME_MAX_RESPONSE_BYTES) {
        const last = result.items[result.items.length - 1];
        if (!last) throw new SessionRuntimeProjectionLimitError("result.items");
        result.nextCursor = encodeWorkItemAggregationCursor(input, scope, last.child.sequence);
        break;
      }
      result.items.push(item);
      if (hasMore && result.items.length === input.limit) result.nextCursor = candidate.nextCursor;
    }
    return result;
  }

  private listWorkItemHistory(
    input: SessionRuntimeWorkItemHistoryListInput,
    binding: ResolvedAgentRuntimeBinding,
  ): SessionRuntimeWorkItemHistoryListResult {
    const service = this.requireWorkItemService();
    const scope = service.resolveListScope(binding);
    const afterSequence = input.cursor ? decodeWorkItemHistoryCursor(input, scope, input.cursor) : null;
    const events = service.listHistory({ workItemId: input.workItemId, limit: input.limit + 1, afterSequence }, binding);
    const items = events.slice(0, input.limit);
    const projected = { items };
    if (Buffer.byteLength(JSON.stringify(createSessionRuntimeResult("work.history.list", projected)), "utf8") > SESSION_RUNTIME_MAX_RESPONSE_BYTES) {
      throw new SessionRuntimeProjectionLimitError("result.items");
    }
    return {
      items,
      ...(events.length > input.limit && items.length > 0
        ? { nextCursor: encodeWorkItemHistoryCursor(input, scope, (items[items.length - 1] as { sequence: number }).sequence) }
        : {}),
    };
  }

  private resolveWorkItemAssociation(
    input: SessionRuntimeEnqueueInput,
    binding: ResolvedAgentRuntimeBinding,
  ): { workItemId?: string } {
    if (!input.workItemId) return {};
    this.requireWorkItemService().requireExecutionAssociation(
      input.workItemId,
      binding.actorSessionId,
      input.sessionId,
    );
    return { workItemId: input.workItemId };
  }

  private async respondToInteraction(
    input: SessionRuntimeInteractionRespondInput,
  ): Promise<SessionRuntimeInteractionRespondResult> {
    const answered = this.requireInteractionService().respond({
      sessionId: input.sessionId,
      executionId: input.executionId,
      interactionId: input.interactionId,
      response: input.response,
      idempotencyKey: input.idempotencyKey,
      respondedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    }).interaction;
    if (answered.state !== "answered") {
      throw new Error("Session interaction response did not produce an answered interaction.");
    }
    if (input.responseMode === "wait") {
      await this.waitForObservation(
        input.sessionId,
        input.executionId,
        input.waitTimeoutMs ?? SESSION_RUNTIME_DEFAULT_WAIT_TIMEOUT_MS,
      );
    }
    const interaction = projectSessionInteraction(answered);
    if (interaction.state !== "answered") throw new Error("Answered interaction projection is invalid.");
    return {
      interaction,
      execution: this.projectExecution(input.sessionId, input.executionId),
    };
  }

  private async waitForObservation(sessionId: string, executionId: string, timeoutMs: number): Promise<void> {
    if (isTerminalOrPending(this.deps.executionService.get(sessionId, executionId), this.deps.interactionService?.getPendingForExecution(executionId) ?? null)) {
      return;
    }
    await new Promise<void>((resolve) => {
      let settled = false;
      let unsubscribe: () => void = () => undefined;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        unsubscribe();
        resolve();
      };
      const observe = () => {
        const execution = this.deps.executionService.get(sessionId, executionId);
        const pending = this.deps.interactionService?.getPendingForExecution(executionId) ?? null;
        if (isTerminalOrPending(execution, pending)) finish();
      };
      const timeout = setTimeout(finish, timeoutMs);
      unsubscribe = this.requireInteractionService().subscribeExecution(executionId, observe);
      observe();
      void this.deps.executionService.waitForTerminal(sessionId, executionId).then(finish, finish);
    });
  }

  private requireInteractionService() {
    if (!this.deps.interactionService) {
      throw new SessionRuntimeValidationError("Session interactions are unavailable.", {}, "RUNTIME_UNAVAILABLE");
    }
    return this.deps.interactionService;
  }

  private requireCurrentCatalog(catalogRevision: number): void {
    if (catalogRevision !== this.requireCurrentModelCatalog().revision) {
      throw new SessionRuntimeValidationError(
        "The model catalog revision is stale.",
        { field: "catalogRevision", catalogRevision },
        "CATALOG_REVISION_STALE",
      );
    }
  }

  private requireCurrentModelCatalog(): ModelCatalogSnapshot {
    const snapshot = this.deps.currentModelCatalog();
    if (!snapshot) {
      throw new SessionRuntimeValidationError(
        "The model catalog is unavailable.",
        {},
        "RUNTIME_UNAVAILABLE",
      );
    }
    return snapshot;
  }

  private requireFileService(): Pick<SessionFileService, "list" | "readText" | "writeText"> {
    if (!this.deps.fileService) {
      throw new SessionRuntimeValidationError(
        "Session file operations are unavailable.",
        {},
        "RUNTIME_UNAVAILABLE",
      );
    }
    return this.deps.fileService;
  }

  private requireTranscriptService(): Pick<SessionTranscriptService, "export"> {
    if (!this.deps.transcriptService) {
      throw new SessionRuntimeValidationError(
        "Session transcript export is unavailable.",
        {},
        "RUNTIME_UNAVAILABLE",
      );
    }
    return this.deps.transcriptService;
  }

  private requireCoordinationService(): NonNullable<SessionExternalApplicationServiceDeps["coordinationService"]> {
    if (!this.deps.coordinationService) {
      throw new SessionRuntimeValidationError(
        "The coordination event service is unavailable.",
        {},
        "RUNTIME_UNAVAILABLE",
      );
    }
    return this.deps.coordinationService;
  }

  private requireWorkItemService(): NonNullable<SessionExternalApplicationServiceDeps["workItemService"]> {
    if (!this.deps.workItemService) {
      throw new SessionRuntimeValidationError("Work Item operations are unavailable.", {}, "RUNTIME_UNAVAILABLE");
    }
    return this.deps.workItemService;
  }

  private isProviderSupported(providerId: string): boolean {
    return this.deps.isProviderSupported?.(providerId) ?? (providerId === "codex" || providerId === "copilot");
  }
}

function projectRuntimeCatalog(
  snapshot: ModelCatalogSnapshot,
  isProviderEnabled: (providerId: string) => boolean,
  isProviderSupported: (providerId: string) => boolean,
): SessionRuntimeCatalogResult {
  return {
    revision: snapshot.revision,
    sessionRoleContractRevision: SESSION_ROLE_CONTRACT_REVISION,
    supportedSessionRoles: [...SESSION_ROLE_VALUES],
    allowedChildSessionRoles: {
      standalone: [...SESSION_ROLE_CHILDREN.standalone],
      "overall-coordinator": [...SESSION_ROLE_CHILDREN["overall-coordinator"]],
      "task-coordinator": [...SESSION_ROLE_CHILDREN["task-coordinator"]],
      executor: [...SESSION_ROLE_CHILDREN.executor],
    },
    maxDelegationDepth: SESSION_ROLE_MAX_DELEGATION_DEPTH,
    sessionTurnCommunicationContractRevision: SESSION_TURN_COMMUNICATION_CONTRACT_REVISION,
    coordinationEvents: {
      kinds: COORDINATION_EVENT_KINDS,
      states: COORDINATION_EVENT_STATES,
      scopes: ["self", "subtree"],
      defaultListLimit: COORDINATION_EVENT_DEFAULT_LIST_LIMIT,
      maxListLimit: COORDINATION_EVENT_MAX_LIST_LIMIT,
    },
    workItems: {
      contractRevision: WORK_ITEM_CONTRACT_REVISION,
      states: WORK_ITEM_STATES,
      mutations: ["create", "revise", "transition", "result", "cancel", "history.append"],
      history: { events: ["created", "migration_baseline", "contract_revised", "progress", "handoff", "state_transitioned", "result_reported"], operations: ["append", "list"], defaultListLimit: WORK_ITEM_DEFAULT_LIST_LIMIT, maxListLimit: WORK_ITEM_MAX_LIST_LIMIT },
      defaultListLimit: WORK_ITEM_DEFAULT_LIST_LIMIT,
      maxListLimit: WORK_ITEM_MAX_LIST_LIMIT,
      maxListResponseBytes: SESSION_RUNTIME_MAX_RESPONSE_BYTES,
      maxResultBytes: WORK_ITEM_MAX_RESULT_BYTES,
      aggregation: {
        contractRevision: WORK_ITEM_AGGREGATION_CONTRACT_REVISION,
        decisions: WORK_ITEM_AGGREGATION_DECISIONS,
        operations: ["get", "list", "decide", "retry"],
        defaultListLimit: WORK_ITEM_AGGREGATION_DEFAULT_LIST_LIMIT,
        maxListLimit: WORK_ITEM_AGGREGATION_MAX_LIST_LIMIT,
      },
    },
    providers: snapshot.providers
      .filter((provider) => isProviderSupported(provider.id) && isProviderEnabled(provider.id))
      .map((provider) => ({
      id: provider.id,
      label: provider.label,
      defaultModelId: provider.defaultModelId,
      defaultReasoningEffort: provider.defaultReasoningEffort,
      models: provider.models.map((model) => ({
        id: model.id,
        label: model.label,
        reasoningEfforts: [...model.reasoningEfforts],
      })),
      })),
  };
}

function assertApplicationResponseSize(
  operation: SessionRuntimeOperation,
  result: SessionRuntimeResultByOperation[SessionRuntimeOperation],
  response: SessionRuntimeResultEnvelope,
): void {
  if (Buffer.byteLength(JSON.stringify(response), "utf8") <= SESSION_RUNTIME_MAX_RESPONSE_BYTES) {
    return;
  }
  throw new SessionRuntimeProjectionLimitError("result", projectionResourceDetails(operation, result));
}

function projectionResourceDetails(
  operation: SessionRuntimeOperation,
  result: unknown,
): Record<string, string> {
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    return {};
  }
  const record = result as Record<string, unknown>;
  const sessionId = typeof record.sessionId === "string" ? record.sessionId : null;
  const executionId = typeof record.id === "string" ? record.id : null;
  const file = record.file && typeof record.file === "object" && !Array.isArray(record.file)
    ? record.file as Record<string, unknown>
    : null;
  const relativePath = typeof file?.relativePath === "string" ? file.relativePath : null;
  const fileSessionId = typeof file?.sessionId === "string" ? file.sessionId : null;
  if (operation === "session.create" || operation === "session.rename") {
    return sessionId ? { sessionId } : {};
  }
  if (operation === "turn.run" || operation === "turn.enqueue" || operation === "turn.cancel") {
    return {
      ...(sessionId ? { sessionId } : {}),
      ...(executionId ? { executionId } : {}),
    };
  }
  if (operation === "session.files.write_text") {
    return {
      ...(fileSessionId ? { sessionId: fileSessionId } : {}),
      ...(relativePath ? { relativePath } : {}),
    };
  }
  return {};
}

function fingerprintMutation(
  input: SessionRuntimeEnqueueInput,
  initiator: Pick<Extract<TurnInitiator, { kind: "session" }>, "kind" | "sessionId">,
): string {
  return createHash("sha256").update(stableJson({
    initiator,
    sessionId: input.sessionId,
    catalogRevision: input.catalogRevision,
    turn: input.turn,
    workItemId: input.workItemId ?? null,
    terminalFailureNotification: input.terminalFailureNotification ?? null,
  }), "utf8").digest("hex");
}

function sessionInitiatorIdentity(
  actorSessionId: string,
): Pick<Extract<TurnInitiator, { kind: "session" }>, "kind" | "sessionId"> {
  return { kind: "session", sessionId: actorSessionId };
}

function fingerprintCancel(input: SessionRuntimeCancelInput): string {
  return createHash("sha256").update(stableJson({
    sessionId: input.sessionId,
    executionId: input.executionId,
  }), "utf8").digest("hex");
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function waitWithoutCancel(
  pending: Promise<SessionExecution>,
  timeoutMs: number,
  fallback: SessionExecution,
): Promise<SessionExecution> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(fallback), timeoutMs);
    timer.unref?.();
    pending.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function encodeListCursor(sessionId: string, afterSequence: number): string {
  return Buffer.from(
    JSON.stringify({ version: 1, operation: "turn.list", sessionId, afterSequence }),
    "utf8",
  ).toString("base64url");
}

function decodeListCursor(cursor: string, sessionId: string): number {
  try {
    const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as Record<string, unknown>;
    if (
      value.version !== 1
      || value.operation !== "turn.list"
      || value.sessionId !== sessionId
      || !Number.isSafeInteger(value.afterSequence)
      || (value.afterSequence as number) < 1
    ) {
      throw new Error("invalid cursor");
    }
    return value.afterSequence as number;
  } catch {
    throw new SessionRuntimeValidationError("The pagination cursor is invalid.", { field: "cursor" }, "INVALID_CURSOR");
  }
}

function encodeInteractionCursor(input: SessionRuntimeInteractionListInput, afterSequence: number): string {
  return Buffer.from(JSON.stringify({
    version: 1,
    operation: "interaction.list",
    sessionId: input.sessionId,
    executionId: input.executionId ?? null,
    kind: input.kind ?? null,
    state: input.state ?? null,
    afterSequence,
  }), "utf8").toString("base64url");
}

function encodeWorkItemCursor(
  input: SessionRuntimeWorkItemListInput,
  scope: WorkItemListScope,
  afterSequence: number,
): string {
  return Buffer.from(JSON.stringify({
    version: 2,
    operation: "work.list",
    rootSessionId: scope.rootSessionId,
    actorSessionId: scope.actorSessionId,
    visibility: scope.visibility,
    creatorSessionId: input.creatorSessionId ?? null,
    targetSessionId: input.targetSessionId ?? null,
    state: input.state ?? null,
    afterSequence,
  }), "utf8").toString("base64url");
}

function decodeWorkItemCursor(
  input: SessionRuntimeWorkItemListInput,
  scope: WorkItemListScope,
  cursor: string,
): number {
  try {
    const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as Record<string, unknown>;
    if (
      value.version !== 2
      || value.operation !== "work.list"
      || value.rootSessionId !== scope.rootSessionId
      || value.actorSessionId !== scope.actorSessionId
      || value.visibility !== scope.visibility
      || value.creatorSessionId !== (input.creatorSessionId ?? null)
      || value.targetSessionId !== (input.targetSessionId ?? null)
      || value.state !== (input.state ?? null)
      || !Number.isSafeInteger(value.afterSequence)
      || (value.afterSequence as number) < 1
    ) throw new Error("invalid cursor");
    return value.afterSequence as number;
  } catch {
    throw new SessionRuntimeValidationError("The pagination cursor is invalid.", { field: "cursor" }, "INVALID_CURSOR");
  }
}

function encodeWorkItemHistoryCursor(input: SessionRuntimeWorkItemHistoryListInput, scope: WorkItemListScope, afterSequence: number): string {
  return Buffer.from(JSON.stringify({ version: 1, operation: "work.history.list", workItemId: input.workItemId, rootSessionId: scope.rootSessionId, actorSessionId: scope.actorSessionId, visibility: scope.visibility, afterSequence }), "utf8").toString("base64url");
}

function decodeWorkItemHistoryCursor(input: SessionRuntimeWorkItemHistoryListInput, scope: WorkItemListScope, cursor: string): number {
  try {
    const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as Record<string, unknown>;
    if (value.version !== 1 || value.operation !== "work.history.list" || value.workItemId !== input.workItemId || value.rootSessionId !== scope.rootSessionId || value.actorSessionId !== scope.actorSessionId || value.visibility !== scope.visibility || !Number.isSafeInteger(value.afterSequence) || (value.afterSequence as number) < 1) throw new Error("invalid cursor");
    return value.afterSequence as number;
  } catch {
    throw new SessionRuntimeValidationError("The pagination cursor is invalid.", { field: "cursor" }, "INVALID_CURSOR");
  }
}

function encodeWorkItemAggregationCursor(
  input: SessionRuntimeWorkItemAggregationListInput,
  scope: WorkItemListScope,
  afterSequence: number,
): string {
  return Buffer.from(JSON.stringify({
    version: 1,
    operation: "work.aggregation.list",
    parentWorkItemId: input.parentWorkItemId,
    rootSessionId: scope.rootSessionId,
    actorSessionId: scope.actorSessionId,
    visibility: scope.visibility,
    decision: input.decision ?? null,
    afterSequence,
  }), "utf8").toString("base64url");
}

function decodeWorkItemAggregationCursor(
  input: SessionRuntimeWorkItemAggregationListInput,
  scope: WorkItemListScope,
  cursor: string,
): number {
  try {
    const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as Record<string, unknown>;
    if (value.version !== 1 || value.operation !== "work.aggregation.list"
      || value.parentWorkItemId !== input.parentWorkItemId || value.rootSessionId !== scope.rootSessionId
      || value.actorSessionId !== scope.actorSessionId || value.visibility !== scope.visibility
      || value.decision !== (input.decision ?? null) || !Number.isSafeInteger(value.afterSequence)
      || (value.afterSequence as number) < 1) throw new Error("invalid cursor");
    return value.afterSequence as number;
  } catch {
    throw new SessionRuntimeValidationError("The pagination cursor is invalid.", { field: "cursor" }, "INVALID_CURSOR");
  }
}

function decodeInteractionCursor(input: SessionRuntimeInteractionListInput, cursor: string): number {
  try {
    const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as Record<string, unknown>;
    if (
      value.version !== 1
      || value.operation !== "interaction.list"
      || value.sessionId !== input.sessionId
      || value.executionId !== (input.executionId ?? null)
      || value.kind !== (input.kind ?? null)
      || value.state !== (input.state ?? null)
      || !Number.isSafeInteger(value.afterSequence)
      || (value.afterSequence as number) < 1
    ) throw new Error("invalid cursor");
    return value.afterSequence as number;
  } catch {
    throw new SessionRuntimeValidationError("The pagination cursor is invalid.", { field: "cursor" }, "INVALID_CURSOR");
  }
}

function isTerminalOrPending(execution: SessionExecution, pending: unknown): boolean {
  return pending !== null
    || execution.state === "completed"
    || execution.state === "failed"
    || execution.state === "canceled"
    || execution.state === "interrupted";
}

function mapApplicationError(error: unknown, operation: SessionRuntimeOperation | string, input?: unknown): SessionRuntimeError {
  if (error instanceof SessionCrudError) {
    return createSessionRuntimeError({
      code: error.code,
      message: error.message,
      retryable: error.retryable,
      details: error.details,
    });
  }
  if (error instanceof SessionRuntimeProjectionLimitError) {
    return createSessionRuntimeError({
      code: error.code,
      message: error.message,
      effect: operation === "session.create"
        || operation === "session.rename"
        || operation === "turn.run"
        || operation === "turn.enqueue"
        || operation === "turn.cancel"
        || operation === "work.create"
        || operation === "work.transition"
        || operation === "work.result"
        || operation === "work.cancel"
        || operation === "work.aggregation.decide"
        || operation === "work.aggregation.retry"
        || operation === "interaction.respond"
        || operation === "coordination.event.create"
        || operation === "coordination.event.resolve"
        || operation === "coordination.event.consume"
        || operation === "coordination.event.cancel"
        || operation === "coordination.event.correct"
        || operation === "session.files.write_text"
        ? "applied"
        : "not_applied",
      details: error.details,
    });
  }
  if (error instanceof SessionFileServiceError) {
    return createSessionRuntimeError({
      code: error.code,
      message: error.message,
      retryable: error.retryable,
      effect: error.effect,
      details: error.details,
    });
  }
  if (error instanceof SessionTranscriptServiceError) {
    return createSessionRuntimeError({
      code: error.code,
      message: error.message,
      retryable: error.retryable,
      effect: error.effect,
      details: error.details,
    });
  }
  if (error instanceof SessionRuntimeValidationError) {
    return createSessionRuntimeError({
      code: error.code,
      message: error.message,
      retryable: error.code === "CATALOG_REVISION_STALE" || error.code === "RUNTIME_UNAVAILABLE",
      details: error.details,
    });
  }
  if (error instanceof CoordinationEventValidationError) {
    return createSessionRuntimeError({
      code: error.code,
      message: error.message,
      details: error.details,
    });
  }
  if (error instanceof CoordinationEventPublicationError) {
    return createSessionRuntimeError({
      code: error.code,
      message: error.message,
      retryable: error.retryable,
      effect: error.effect,
      details: { eventId: error.eventId },
    });
  }
  if (error instanceof CoordinationEventNotFoundError) {
    return createSessionRuntimeError({ code: error.code, message: error.message });
  }
  if (error instanceof CoordinationEventStateConflictError) {
    return createSessionRuntimeError({ code: error.code, message: error.message });
  }
  if (error instanceof CoordinationEventIdempotencyConflictError) {
    return createSessionRuntimeError({ code: error.code, message: error.message });
  }
  if (error instanceof WorkItemNotFoundError) {
    return createSessionRuntimeError({ code: error.code, message: "The Work Item was not found." });
  }
  if (
    error instanceof WorkItemAuthorityError
    || error instanceof WorkItemParentError
    || error instanceof WorkItemExecutionAssociationError
  ) {
    return createSessionRuntimeError({ code: error.code, message: error.message, details: error instanceof WorkItemAuthorityError ? error.details : {} });
  }
  if (error instanceof WorkItemRevisionConflictError || error instanceof WorkItemStateConflictError) {
    return createSessionRuntimeError({ code: error.code, message: error.message });
  }
  if (error instanceof WorkItemAggregationConflictError) {
    return createSessionRuntimeError({ code: error.code, message: error.message, details: error.details });
  }
  if (error instanceof WorkItemIdempotencyConflictError) {
    return createSessionRuntimeError({ code: error.code, message: "The idempotency key was reused with different input." });
  }
  if (error instanceof WorkItemResultTooLargeError) {
    return createSessionRuntimeError({
      code: error.code,
      message: error.message,
      details: { actualBytes: error.actualBytes, maxBytes: WORK_ITEM_MAX_RESULT_BYTES },
    });
  }
  if (error instanceof SessionExecutionQueueFullError) {
    return createSessionRuntimeError({ code: "QUEUE_FULL", message: "The Session execution queue is full." });
  }
  if (error instanceof SessionExecutionBusyError) {
    return createSessionRuntimeError({ code: "SESSION_BUSY", message: "The Session already has an active execution." });
  }
  if (error instanceof SessionExecutionIdempotencyConflictError) {
    return createSessionRuntimeError({ code: "IDEMPOTENCY_CONFLICT", message: "The idempotency key was reused with different input." });
  }
  if (error instanceof SessionExecutionWorkItemAssociationError) {
    return createSessionRuntimeError({ code: error.code, message: error.message });
  }
  if (error instanceof SessionExecutionNotFoundError || error instanceof SessionExecutionOwnerMismatchError) {
    return createSessionRuntimeError({ code: "EXECUTION_NOT_FOUND", message: "The Session execution was not found." });
  }
  if (error instanceof SessionExecutionStateConflictError) {
    return createSessionRuntimeError({ code: "EXECUTION_NOT_CANCELLABLE", message: "The Session execution cannot be canceled in its current state." });
  }
  if (error instanceof SessionExecutionShuttingDownError) {
    return createSessionRuntimeError({ code: error.code, message: error.message });
  }
  if (error instanceof SessionInteractionNotFoundError || error instanceof SessionInteractionTargetMismatchError) {
    return createSessionRuntimeError({ code: "INTERACTION_NOT_FOUND", message: "The Session interaction was not found." });
  }
  if (error instanceof SessionInteractionAlreadyResolvedError) {
    return createSessionRuntimeError({ code: "INTERACTION_ALREADY_RESOLVED", message: "The Session interaction is already resolved." });
  }
  if (error instanceof SessionInteractionIdempotencyConflictError) {
    return createSessionRuntimeError({ code: "IDEMPOTENCY_CONFLICT", message: "The idempotency key was reused with a different response." });
  }
  if (error instanceof SessionInteractionKindMismatchError || error instanceof SessionInteractionContinuationUnavailableError) {
    return createSessionRuntimeError({ code: error.code, message: error.message });
  }
  if (error instanceof SessionTurnValidationError) {
    return createSessionRuntimeError({
      code: error.code,
      message: error.message,
      retryable: error.code === "CATALOG_REVISION_STALE" || error.code === "WORKSPACE_UNAVAILABLE",
    });
  }
  if (error instanceof TypeError) {
    return createSessionRuntimeError({ code: "INVALID_INPUT", message: "The Session operation input is invalid." });
  }
  return createSessionRuntimeError({
    code: "RUNTIME_UNAVAILABLE",
    message: "The Session operation could not be completed.",
    retryable: true,
    effect: isMutationOperation(operation, input) ? "indeterminate" : "not_applied",
  });
}

function isMutationOperation(operation: SessionRuntimeOperation | string, input?: unknown): boolean {
  return operation === "session.create"
    || operation === "session.rename"
    || operation === "turn.run"
    || operation === "turn.enqueue"
    || operation === "turn.cancel"
    || operation === "work.create"
    || operation === "work.revise"
    || operation === "work.history.append"
    || operation === "work.transition"
    || operation === "work.result"
    || operation === "work.cancel"
    || operation === "work.aggregation.decide"
    || operation === "work.aggregation.retry"
    || operation === "interaction.respond"
    || operation === "coordination.event.create"
    || operation === "coordination.event.resolve"
    || operation === "coordination.event.consume"
    || operation === "coordination.event.cancel"
    || operation === "coordination.event.correct"
    || operation === "session.files.write_text"
    || (operation === "transcript.export"
      && (input === undefined || (input as { destination?: { kind?: string } }).destination?.kind !== "inline"));
}
