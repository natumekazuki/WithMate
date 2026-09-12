import { SessionLifecycleOperationConflictError, SessionLifecycleOperationRevisionConflictError } from "./session-lifecycle-storage.js";
import { createHash } from "node:crypto";
import { SessionLifecycleRecoveryError, type SessionLifecycleService } from "./session-lifecycle-service.js";
import type { SessionRuntimeConfigureInput, SessionRuntimeMoveInput, SessionRuntimeCloneInput, SessionRuntimeRestoreInput, SessionRuntimeArchiveInput, SessionRuntimeDeleteInput } from "../src/session-external-runtime-contract.js";
import { SessionAuthorityError, SESSION_AUTHORITY_MAPPING_REVISION, SESSION_AUTHORITY_OPERATION_DEFINITIONS, type MutationAdmissionProof, type MutationAuthorityProof } from "../src/session-authority.js";
import type { SessionAuthorityService } from "./session-authority-service.js";
import { SessionResourceRevisionConflictError } from "./resource-history-schema.js";
import {
  RESOURCE_BUDGET_CONTRACT_REVISION,
  RESOURCE_BUDGET_DEFAULT_DURATION_MS,
  RESOURCE_BUDGET_DEFAULT_HARD_LIMITS,
  RESOURCE_BUDGET_DEFAULT_LIST_LIMIT,
  RESOURCE_BUDGET_DIMENSIONS,
  RESOURCE_BUDGET_MAX_LIST_LIMIT,
  RESOURCE_BUDGET_RETRY_PER_EXECUTION_LIMIT,
  type ResourceBudgetConfigureInput,
  type ResourceBudgetGetInput,
  type ResourceBudgetListInput,
} from "../src/resource-budget.js";
import { ResourceBudgetError, type ResourceBudgetStorage } from "./resource-budget-storage.js";

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
  type SessionRuntimeWorkItemReassignInput,
  type SessionRuntimeWorkItemMoveInput,
  type SessionRuntimeWorkItemCloneInput,
  type SessionRuntimeWorkItemReopenInput,
  type SessionRuntimeWorkItemArchiveInput,
  type SessionRuntimeWorkItemRestoreInput,
  type SessionRuntimeWorkItemDeleteInput,
  type SessionRuntimeWorkItemHistoryAppendInput,
  type SessionRuntimeWorkItemHistoryListInput,
  type SessionRuntimeWorkItemHistoryListResult,
  type SessionRuntimeWorkItemListInput,
  type SessionRuntimeWorkItemListResult,
  type SessionRuntimeWorkItemResultInput,
  type SessionRuntimeWorkItemResultCorrectionInput,
  type SessionRuntimeWorkItemTransitionInput,
  type SessionRuntimeWorkItemAggregationGetInput,
  type SessionRuntimeWorkItemAggregationListInput,
  type SessionRuntimeWorkItemAggregationListResult,
  type SessionRuntimeWorkItemAggregationDecisionInput,
  type SessionRuntimeWorkItemAggregationRetryInput,
  type SessionRuntimeWorkItemAggregationCorrectionInput,
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
  type SessionTurnAuthoritySession,
} from "../src/session-turn-communication-authority.js";
import {
  WORK_ITEM_CONTRACT_REVISION,
  WORK_ITEM_AGGREGATION_CONTRACT_REVISION,
  WORK_ITEM_AGGREGATION_DECISIONS,
  WORK_ITEM_AGGREGATION_DEFAULT_LIST_LIMIT,
  WORK_ITEM_AGGREGATION_MAX_LIST_LIMIT,
  WORK_ITEM_DEFAULT_LIST_LIMIT,
  WORK_ITEM_MAX_EVENT_PAYLOAD_BYTES,
  WORK_ITEM_MAX_MIGRATION_BASELINE_PAYLOAD_BYTES,
  WORK_ITEM_MAX_LIST_LIMIT,
  WORK_ITEM_MAX_RESULT_BYTES,
  WORK_ITEM_STATES,
  WorkItemEventPayloadTooLargeError,
  type WorkItemEvent,
} from "../src/work-item.js";
import type { SessionExecution, TurnInitiator } from "../src/session-execution.js";
import {
  SessionInteractionContinuationUnavailableError,
  SessionInteractionContinuationSettlementError,
  SessionInteractionKindMismatchError,
  type SessionInteractionService,
} from "./session-interaction-service.js";
import {
  SessionInteractionAlreadyResolvedError,
  SessionInteractionAuthorityError,
  SessionInteractionRevisionConflictError,
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
  SessionExecutionIdempotencyResponseUnavailableError,
  SessionExecutionRevisionConflictError,
  SessionExecutionQueueFullError,
  SessionExecutionStateConflictError,
  SessionExecutionWorkItemAssociationError,
} from "./session-execution-storage-v6.js";
import { SessionCrudError, type SessionCrudService } from "./session-crud-service.js";
import { SessionCrudIdempotencyResponseUnavailableError, SessionFileWriteIdempotencyResponseUnavailableError } from "./session-storage-v6.js";
import { SessionFileServiceError, type SessionFileService } from "./session-file-service.js";
import { SessionTranscriptServiceError, type SessionTranscriptService } from "./session-transcript-service.js";
import { SessionTranscriptIdempotencyResponseUnavailableError } from "./session-transcript-storage-v6.js";
import type { ResolvedAgentRuntimeBinding } from "./agent-runtime-binding.js";
import { CoordinationEventPublicationError, type CoordinationEventService } from "./coordination-event-service.js";
import {
  CoordinationEventIdempotencyConflictError,
  CoordinationEventIdempotencyResponseUnavailableError,
  CoordinationEventRevisionConflictError,
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
  WorkItemIdempotencyResponseUnavailableError,
  WorkItemNotFoundError,
  WorkItemRevisionConflictError,
  WorkItemResultTooLargeError,
  WorkItemStateConflictError,
  WorkItemAggregationConflictError,
} from "./work-item-storage-v6.js";

export type SessionExternalApplicationServiceDeps = {
  lifecycleService?: Pick<SessionLifecycleService, "configure" | "move" | "clone" | "restore" | "archive" | "delete" | "deleteManifest" | "moveManifest">;
  authorityService: Pick<SessionAuthorityService, "authorize" | "authorizeSessionAct" | "canSessionAct">;
  executionService: Pick<
    SessionExecutionService,
    "beginShutdown" | "run" | "enqueue" | "get" | "listPage" | "cancel" | "waitForTerminal" | "resolveReplay"
  > & Pick<SessionExecutionService, "resumeRootQueues"> & Partial<Pick<SessionExecutionService, "getRecord">>;
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
  budgetStorage?: Pick<ResourceBudgetStorage, "get" | "listVisible" | "configure">;
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
    | "getAggregation" | "listAggregation" | "decideAggregation" | "retryAggregation" | "correctResult" | "correctAggregation" | "revise" | "appendHistory" | "iterateHistory"
    | "reassign" | "move" | "clone" | "reopen" | "archive" | "restore" | "delete"
  >;
  getExecutionWorkItemId?(executionId: string): string | null;
  invalidateSession?(sessionId: string): void;
};

export type SessionExternalApplicationResponse = SessionRuntimeResultEnvelope | SessionRuntimeError;

const WORK_ITEM_MUTATION_OPERATIONS = new Set<SessionRuntimeOperation>([
  "work.create",
  "work.reassign",
  "work.move",
  "work.clone",
  "work.reopen",
  "work.archive",
  "work.restore",
  "work.delete",
  "work.revise",
  "work.history.append",
  "work.transition",
  "work.result",
  "work.result.correct",
  "work.cancel",
  "work.aggregation.decide",
  "work.aggregation.retry",
  "work.aggregation.correct",
]);

export class SessionExternalApplicationService {
  private accepting = true;

  constructor(private readonly deps: SessionExternalApplicationServiceDeps) {}

  private requireLifecycleService() {
    if (!this.deps.lifecycleService) throw new SessionCrudError("RUNTIME_UNAVAILABLE", "The Session lifecycle owner is unavailable.");
    return this.deps.lifecycleService;
  }

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
      const authorized = this.deps.authorityService.authorize(agentRuntimeBinding, request.operation, request.input);
      const additionalProofs = this.authorizeWorkItemAdditionalProofs(request.operation, request.input, agentRuntimeBinding);
      const result = await this.executeValidated(request.operation, authorized.input, agentRuntimeBinding, authorized.proof, additionalProofs);
      this.invalidateWorkItemMutation(request.operation, agentRuntimeBinding.actorSessionId);
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
    proof: MutationAdmissionProof,
    additionalProofs: readonly MutationAuthorityProof[] = [],
  ): Promise<SessionRuntimeResultByOperation[SessionRuntimeOperation]> {
    if (operation === "runtime.catalog") {
      return projectRuntimeCatalog(
        this.requireCurrentModelCatalog(),
        this.deps.isProviderEnabled,
        (providerId) => this.isProviderSupported(providerId),
      );
    }
    if (operation === "budget.get") {
      return this.requireBudgetStorage().get((input as ResourceBudgetGetInput).sessionId);
    }
    if (operation === "budget.list") {
      const request = input as ResourceBudgetListInput;
      const session = await this.deps.crudService.get(request.sessionId);
      return this.requireBudgetStorage().listVisible(
        agentRuntimeBinding.actorSessionId,
        session.rootSessionId,
        request.limit,
        request.cursor,
      );
    }
    if (operation === "budget.configure") {
      const updated = this.requireBudgetStorage().configure(
        input as ResourceBudgetConfigureInput,
        proof,
        new Date().toISOString(),
      );
      await this.deps.executionService.resumeRootQueues(updated.rootSessionId);
      return updated;
    }
    if (operation === "session.self") {
      const session = await this.deps.crudService.get(agentRuntimeBinding.actorSessionId);
      return {
        sessionId: session.sessionId,
        revision: session.revision,
        sessionRole: session.sessionRole,
        roleContractRevision: session.roleContractRevision,
        rootSessionId: session.rootSessionId,
        parentSessionId: session.parentSessionId,
        delegationDepth: session.delegationDepth,
      };
    }
    if (operation === "session.create") {
      return this.deps.crudService.create(input as SessionRuntimeCreateInput, agentRuntimeBinding.actorSessionId, proof);
    }
    if (operation === "session.list") {
      return this.deps.crudService.list(input as SessionRuntimeSessionListInput, proof);
    }
    if (operation === "session.get") {
      return this.deps.crudService.get((input as SessionRuntimeSessionInput).sessionId);
    }
    if (operation === "session.rename") {
      return this.requireLifecycleService().configure({ ...input as SessionRuntimeRenameInput, kind: "title" }, proof);
    }
    if (operation === "session.configure") return this.requireLifecycleService().configure(input as SessionRuntimeConfigureInput, proof);
    if (operation === "session.move") return this.requireLifecycleService().move(input as SessionRuntimeMoveInput, proof);
    if (operation === "session.clone") return this.requireLifecycleService().clone(input as SessionRuntimeCloneInput, proof);
    if (operation === "session.restore") return this.requireLifecycleService().restore(input as SessionRuntimeRestoreInput, proof);
    if (operation === "session.archive") return this.requireLifecycleService().archive(input as SessionRuntimeArchiveInput, proof);
    if (operation === "session.delete") return this.requireLifecycleService().delete(input as SessionRuntimeDeleteInput, proof);
    if (operation === "session.delete.manifest") return this.requireLifecycleService().deleteManifest((input as { sessionId: string }).sessionId);
    if (operation === "session.move.manifest") {
      const request = input as { sessionId: string; destinationRootSessionId: string };
      return this.requireLifecycleService().moveManifest(request.sessionId, request.destinationRootSessionId, proof);
    }
    if (operation === "session.files.list") {
      return this.requireFileService().list(input as SessionRuntimeFileListInput);
    }
    if (operation === "session.files.read_text") {
      return this.requireFileService().readText(input as SessionRuntimeFileReadTextInput);
    }
    if (operation === "session.files.write_text") {
      return this.requireFileService().writeText(input as SessionRuntimeFileWriteTextInput, proof);
    }
    if (operation === "work.create") {
      return this.requireWorkItemService().create(input as SessionRuntimeWorkItemCreateInput, agentRuntimeBinding, proof);
    }
    if (operation === "work.get") {
      return this.requireWorkItemService().get((input as SessionRuntimeWorkItemInput).workItemId, agentRuntimeBinding, proof);
    }
    if (operation === "work.revise") {
      return this.requireWorkItemService().revise(input as SessionRuntimeWorkItemReviseInput, agentRuntimeBinding, proof);
    }
    if (operation === "work.reassign") return this.requireWorkItemService().reassign(input as SessionRuntimeWorkItemReassignInput, agentRuntimeBinding, proof, additionalProofs);
    if (operation === "work.move") return this.requireWorkItemService().move(input as SessionRuntimeWorkItemMoveInput, agentRuntimeBinding, proof, additionalProofs);
    if (operation === "work.clone") return this.requireWorkItemService().clone(input as SessionRuntimeWorkItemCloneInput, agentRuntimeBinding, proof, additionalProofs);
    if (operation === "work.reopen") return this.requireWorkItemService().reopen(input as SessionRuntimeWorkItemReopenInput, agentRuntimeBinding, proof, additionalProofs);
    if (operation === "work.archive") return this.requireWorkItemService().archive(input as SessionRuntimeWorkItemArchiveInput, agentRuntimeBinding, proof);
    if (operation === "work.restore") return this.requireWorkItemService().restore(input as SessionRuntimeWorkItemRestoreInput, agentRuntimeBinding, proof);
    if (operation === "work.delete") return this.requireWorkItemService().delete(input as SessionRuntimeWorkItemDeleteInput, agentRuntimeBinding, proof);
    if (operation === "work.history.append") {
      return this.requireWorkItemService().appendHistory(input as SessionRuntimeWorkItemHistoryAppendInput, agentRuntimeBinding, proof);
    }
    if (operation === "work.history.list") {
      return this.listWorkItemHistory(input as SessionRuntimeWorkItemHistoryListInput, agentRuntimeBinding, proof);
    }
    if (operation === "work.list") {
      return this.listWorkItems(input as SessionRuntimeWorkItemListInput, agentRuntimeBinding, proof);
    }
    if (operation === "work.transition") {
      return this.requireWorkItemService().transition(input as SessionRuntimeWorkItemTransitionInput, agentRuntimeBinding, proof);
    }
    if (operation === "work.result") {
      return this.requireWorkItemService().reportResult(input as SessionRuntimeWorkItemResultInput, agentRuntimeBinding, proof);
    }
    if (operation === "work.result.correct") {
      return this.requireWorkItemService().correctResult(input as SessionRuntimeWorkItemResultCorrectionInput, agentRuntimeBinding, proof);
    }
    if (operation === "work.cancel") {
      return this.requireWorkItemService().cancel(input as SessionRuntimeWorkItemCancelInput, agentRuntimeBinding, proof);
    }
    if (operation === "work.aggregation.get") {
      return this.requireWorkItemService().getAggregation(input as SessionRuntimeWorkItemAggregationGetInput, agentRuntimeBinding, proof);
    }
    if (operation === "work.aggregation.list") {
      return this.listWorkItemAggregation(input as SessionRuntimeWorkItemAggregationListInput, agentRuntimeBinding, proof);
    }
    if (operation === "work.aggregation.decide") {
      return this.requireWorkItemService().decideAggregation(input as SessionRuntimeWorkItemAggregationDecisionInput, agentRuntimeBinding, proof);
    }
    if (operation === "work.aggregation.retry") {
      return this.requireWorkItemService().retryAggregation(input as SessionRuntimeWorkItemAggregationRetryInput, agentRuntimeBinding, proof);
    }
    if (operation === "work.aggregation.correct") {
      return this.requireWorkItemService().correctAggregation(input as SessionRuntimeWorkItemAggregationCorrectionInput, agentRuntimeBinding, proof);
    }
    if (operation === "turn.options") {
      return this.turnOptions((input as SessionRuntimeSessionInput).sessionId);
    }
    if (operation === "turn.run") {
      return this.run(input as SessionRuntimeRunInput, agentRuntimeBinding, proof);
    }
    if (operation === "turn.enqueue") {
      return this.enqueue(input as SessionRuntimeEnqueueInput, agentRuntimeBinding, proof);
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
        proof,
      });
      return this.projectExecution(execution.sessionId, execution.id, execution);
    }
    if (operation === "interaction.list") {
      return this.listInteractions(input as SessionRuntimeInteractionListInput);
    }
    if (operation === "interaction.respond") {
      return this.respondToInteraction(input as SessionRuntimeInteractionRespondInput, proof);
    }
    if (operation === "coordination.event.create") {
      return this.requireCoordinationService().create(input as CoordinationEventCreateInput, agentRuntimeBinding, proof);
    }
    if (operation === "coordination.event.list") {
      return this.requireCoordinationService().list(input as CoordinationEventListInput, agentRuntimeBinding, proof);
    }
    if (operation === "coordination.event.get") {
      return this.requireCoordinationService().get(input as CoordinationEventGetInput, agentRuntimeBinding, proof);
    }
    if (operation === "coordination.event.resolve") {
      return this.requireCoordinationService().resolve(input as CoordinationEventResolveInput, agentRuntimeBinding, proof);
    }
    if (operation === "coordination.event.consume") {
      return this.requireCoordinationService().consume(input as CoordinationEventConsumeInput, agentRuntimeBinding, proof);
    }
    if (operation === "coordination.event.cancel") {
      return this.requireCoordinationService().cancel(input as CoordinationEventCancelInput, agentRuntimeBinding, proof);
    }
    if (operation === "coordination.event.correct") {
      return this.requireCoordinationService().correct(input as CoordinationEventCorrectInput, agentRuntimeBinding, proof);
    }
    if (operation === "transcript.export") {
      return this.requireTranscriptService().export(input as SessionRuntimeTranscriptExportInput, proof);
    }
    throw new SessionRuntimeValidationError("Unsupported Session runtime operation.", { field: "operation" });
  }

  private async run(
    input: SessionRuntimeRunInput,
    agentRuntimeBinding: ResolvedAgentRuntimeBinding,
    proof: MutationAdmissionProof,
  ): Promise<SessionRuntimePublicExecution> {
    const initiatorIdentity = sessionInitiatorIdentity(agentRuntimeBinding.actorSessionId);
    const mutation = {
      proof,
      expectedContainerRevision: input.expectedContainerRevision,
      sessionId: input.sessionId,
      request: { catalogRevision: input.catalogRevision, turn: input.turn },
      idempotencyKey: input.idempotencyKey,
      requestFingerprint: fingerprintMutation(input, initiatorIdentity),
    };
    const replay = this.deps.executionService.resolveReplay("turn.run", mutation);
    if (!replay) {
      this.requireCurrentCatalog(input.catalogRevision);
    }
    const terminalNotification = replay ? null : await this.resolveTerminalFailureNotification(input);
    const execution = replay ?? await this.deps.executionService.run({
      ...mutation,
      ...(terminalNotification?.proof
        ? { terminalFailureNotificationProof: terminalNotification.proof }
        : {}),
      ...this.resolveWorkItemAssociation(input, agentRuntimeBinding),
      ...await this.resolveTurnAcceptance(agentRuntimeBinding.actorSessionId, input.sessionId, input.turn.userMessage, proof.operation),
      request: {
        initiator: await this.requireTurnInitiator(agentRuntimeBinding.actorSessionId),
        catalogRevision: input.catalogRevision,
        ...terminalNotification?.request,
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
    proof: MutationAdmissionProof,
  ): Promise<SessionRuntimePublicExecution> {
    const initiatorIdentity = sessionInitiatorIdentity(agentRuntimeBinding.actorSessionId);
    const mutation = {
      proof,
      expectedContainerRevision: input.expectedContainerRevision,
      sessionId: input.sessionId,
      request: { catalogRevision: input.catalogRevision, turn: input.turn },
      idempotencyKey: input.idempotencyKey,
      requestFingerprint: fingerprintMutation(input, initiatorIdentity),
    };
    const replay = this.deps.executionService.resolveReplay("turn.enqueue", mutation);
    if (!replay) {
      this.requireCurrentCatalog(input.catalogRevision);
    }
    const terminalNotification = replay ? null : await this.resolveTerminalFailureNotification(input);
    const execution = replay ?? await this.deps.executionService.enqueue({
      ...mutation,
      ...(terminalNotification?.proof
        ? { terminalFailureNotificationProof: terminalNotification.proof }
        : {}),
      ...this.resolveWorkItemAssociation(input, agentRuntimeBinding),
      ...await this.resolveTurnAcceptance(agentRuntimeBinding.actorSessionId, input.sessionId, input.turn.userMessage, proof.operation),
      request: {
        initiator: await this.requireTurnInitiator(agentRuntimeBinding.actorSessionId),
        catalogRevision: input.catalogRevision,
        ...terminalNotification?.request,
        turn: input.turn,
      },
    });
    return this.projectExecution(execution.sessionId, execution.id, execution);
  }

  private async resolveTerminalFailureNotification(
    input: SessionRuntimeEnqueueInput,
  ): Promise<{
    request: { terminalFailureNotification?: SessionExecutionTerminalFailureNotification };
    proof?: MutationAdmissionProof;
  }> {
    const notification = input.terminalFailureNotification;
    if (!notification) return { request: {} };
    if (notification.targetSessionId === input.sessionId) {
      throw new SessionRuntimeValidationError(
        "The terminal failure notification target must differ from the source Session.",
        { sessionId: input.sessionId, targetSessionId: notification.targetSessionId },
        "TERMINAL_NOTIFICATION_SAME_SESSION",
      );
    }
    this.requireSessionTurnAuthority(input.sessionId, notification.targetSessionId, "turn.enqueue");
    const proof = this.deps.authorityService.authorizeSessionAct(
      input.sessionId,
      "turn.enqueue",
      { sessionId: notification.targetSessionId },
    ).proof;
    const sourceSession = await this.requireTurnInitiator(input.sessionId);
    return {
      request: {
        terminalFailureNotification: {
          contractVersion: TERMINAL_FAILURE_NOTIFICATION_CONTRACT_VERSION,
          targetSessionId: notification.targetSessionId,
          sourceSession,
        },
      },
      proof,
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
    operation: SessionRuntimeOperation,
  ): Promise<{ origin?: import("../src/session-execution.js").SessionExecutionOriginSnapshot }> {
    const { actor, target } = this.requireSessionTurnAuthority(actorSessionId, targetSessionId, operation);
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
    operation: SessionRuntimeOperation,
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
    if (actorBinding.rootSessionId !== targetBinding.rootSessionId
      || !this.deps.authorityService.canSessionAct(actor.sessionId, operation, { sessionId: target.sessionId })) {
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
    proof: MutationAdmissionProof,
  ): SessionRuntimeWorkItemListResult {
    const service = this.requireWorkItemService();
    const scope = service.resolveListScope(binding, proof);
    const cursor = input.cursor ? decodeWorkItemCursor(input, scope, input.cursor) : null;
    const iterator = service.iterateList({
      ...(input.creatorSessionId === undefined ? {} : { creatorSessionId: input.creatorSessionId }),
      ...(input.targetSessionId === undefined ? {} : { targetSessionId: input.targetSessionId }),
      ...(input.state === undefined ? {} : { state: input.state }),
      includeArchived: input.includeArchived ?? false,
      limit: input.limit + 1,
      afterSequence: cursor,
    }, scope, proof)[Symbol.iterator]();
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
    proof: MutationAdmissionProof,
  ): SessionRuntimeWorkItemAggregationListResult {
    const service = this.requireWorkItemService();
    const scope = service.resolveListScope(binding, proof);
    const afterSequence = input.cursor ? decodeWorkItemAggregationCursor(input, scope, input.cursor) : null;
    const items = service.listAggregation({
      parentWorkItemId: input.parentWorkItemId,
      ...(input.decision === undefined ? {} : { decision: input.decision }),
      ...(input.state === undefined ? {} : { state: input.state }),
      ...(input.depth === undefined ? {} : { depth: input.depth }),
      ...(input.fields === undefined ? {} : { fields: input.fields }),
      limit: input.limit + 1,
      afterSequence,
    }, binding, proof);
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
    proof: MutationAdmissionProof,
  ): SessionRuntimeWorkItemHistoryListResult {
    const service = this.requireWorkItemService();
    const scope = service.resolveListScope(binding, proof);
    const afterSequence = input.cursor ? decodeWorkItemHistoryCursor(input, scope, input.cursor) : null;
    const events = service.iterateHistory({ workItemId: input.workItemId, limit: input.limit + 1, afterSequence }, binding, proof);
    const result: {
      items: WorkItemEvent[];
      nextCursor?: string;
    } = { items: [] };
    for (const event of events) {
      const hasMore = result.items.length >= input.limit;
      if (hasMore) {
        const last = result.items.at(-1);
        if (last) result.nextCursor = encodeWorkItemHistoryCursor(input, scope, last.sequence);
        break;
      }
      const candidate: SessionRuntimeWorkItemHistoryListResult = {
        items: [...result.items, event],
        nextCursor: encodeWorkItemHistoryCursor(input, scope, event.sequence),
      };
      if (
        Buffer.byteLength(JSON.stringify(createSessionRuntimeResult("work.history.list", candidate)), "utf8")
        > SESSION_RUNTIME_MAX_RESPONSE_BYTES
      ) {
        const last = result.items[result.items.length - 1];
        if (!last) throw new SessionRuntimeProjectionLimitError("result.items");
        result.nextCursor = encodeWorkItemHistoryCursor(input, scope, last.sequence);
        break;
      }
      result.items.push(event);
    }
    return result;
  }

  private invalidateWorkItemMutation(operation: SessionRuntimeOperation, actorSessionId: string): void {
    if (!this.deps.invalidateSession || !WORK_ITEM_MUTATION_OPERATIONS.has(operation)) return;
    const rootSessionId = this.deps.getTurnAuthoritySession(actorSessionId)?.rootSessionId;
    if (!rootSessionId) return;
    try {
      this.deps.invalidateSession(rootSessionId);
    } catch (error) {
      console.warn("Committed Work Item mutation invalidation failed", error);
    }
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
    proof: MutationAdmissionProof,
  ): Promise<SessionRuntimeInteractionRespondResult> {
    const answered = this.requireInteractionService().respond({
      sessionId: input.sessionId,
      expectedRevision: input.expectedRevision,
      principal: { kind: "agent", sessionId: proof.principal.actorSessionId },
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

  private requireBudgetStorage(): NonNullable<SessionExternalApplicationServiceDeps["budgetStorage"]> {
    if (!this.deps.budgetStorage) {
      throw new SessionRuntimeValidationError(
        "Resource budget operations are unavailable.",
        {},
        "RUNTIME_UNAVAILABLE",
      );
    }
    return this.deps.budgetStorage;
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

  private authorizeWorkItemAdditionalProofs(operation: SessionRuntimeOperation, input: unknown, binding: ResolvedAgentRuntimeBinding): MutationAuthorityProof[] {
    if (operation === "work.reassign") {
      const request = input as SessionRuntimeWorkItemReassignInput;
      return [this.deps.authorityService.authorize(binding, "work.create", { targetSessionId: request.targetSessionId }).proof];
    }
    if (operation === "work.clone") {
      const request = input as SessionRuntimeWorkItemCloneInput;
      const sourceRead = this.deps.authorityService.authorize(binding, "work.get", { workItemId: request.workItemId }).proof;
      const source = this.requireWorkItemService().get(request.workItemId, binding, sourceRead);
      const parentWorkItemId = request.parentWorkItemId === undefined ? source.parentWorkItemId : request.parentWorkItemId;
      const proofs: MutationAuthorityProof[] = [this.deps.authorityService.authorize(binding, "work.create", { targetSessionId: request.targetSessionId }).proof];
      if (parentWorkItemId !== null) proofs.push(this.deps.authorityService.authorize(binding, "work.move", { workItemId: parentWorkItemId }).proof);
      return proofs;
    }
    if (operation === "work.reopen") {
      const request = input as SessionRuntimeWorkItemReopenInput;
      const sourceRead = this.deps.authorityService.authorize(binding, "work.get", { workItemId: request.workItemId }).proof;
      const source = this.requireWorkItemService().get(request.workItemId, binding, sourceRead);
      const parentWorkItemId = request.destinationParentWorkItemId === undefined ? source.parentWorkItemId : request.destinationParentWorkItemId;
      const proofs: MutationAuthorityProof[] = [this.deps.authorityService.authorize(binding, "work.create", { targetSessionId: source.targetSessionId }).proof];
      if (parentWorkItemId !== null) proofs.push(this.deps.authorityService.authorize(binding, "work.move", { workItemId: parentWorkItemId }).proof);
      return proofs;
    }
    if (operation === "work.move") {
      const request = input as SessionRuntimeWorkItemMoveInput;
      const proofs: MutationAuthorityProof[] = [];
      if (request.destinationParentWorkItemId) proofs.push(this.deps.authorityService.authorize(binding, "work.move", { workItemId: request.destinationParentWorkItemId }).proof);
      return proofs;
    }
    return [];
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
    authority: {
      mappingRevision: SESSION_AUTHORITY_MAPPING_REVISION,
      operations: Object.values(SESSION_AUTHORITY_OPERATION_DEFINITIONS),
      budget: {
        contractRevision: RESOURCE_BUDGET_CONTRACT_REVISION,
        operations: ["get", "list", "configure"],
        dimensions: RESOURCE_BUDGET_DIMENSIONS,
        defaultHardLimits: RESOURCE_BUDGET_DEFAULT_HARD_LIMITS,
        retryPerExecutionLimit: RESOURCE_BUDGET_RETRY_PER_EXECUTION_LIMIT,
        defaultDurationMs: RESOURCE_BUDGET_DEFAULT_DURATION_MS,
        defaultListLimit: RESOURCE_BUDGET_DEFAULT_LIST_LIMIT,
        maxListLimit: RESOURCE_BUDGET_MAX_LIST_LIMIT,
        meteredUsage: ["tokens", "monetary_cost", "provider_usage"],
        constraints: [
          "Token, monetary cost and provider usage are metered observations, not hard-limit dimensions.",
          "Increasing a root hard limit or the per-execution retry limit requires trusted user or issuer authority.",
          "Delegation budget enforcement is introduced with the later delegation capability slice.",
          "Child allocations must set storageBytes to zero; storage is enforced only by the shared root account.",
          "Provider paths without a canonical executionId, including auxiliary and companion executions, are outside the root Turn, retry and generation ledger.",
          "Direct SessionFolder writes bypass pre-reservation; storage is reconciled before dispatch, and unknown or exceeded usage blocks new dispatch.",
        ],
      },
      validationGaps: [
        "Provider-native shell, Git and external tools can bypass the Session Runtime API; grants and resource budgets do not enforce those paths. Provider approval and sandbox policies remain separate boundaries.",
      ],
    },
    sessionRoleContractRevision: SESSION_ROLE_CONTRACT_REVISION,
    supportedSessionRoles: [...SESSION_ROLE_VALUES],
    baselineChildSessionRoleTemplates: {
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
      mutations: ["create", "revise", "reassign", "move", "clone", "reopen", "archive", "restore", "delete", "transition", "result", "result.correct", "cancel", "history.append"],
      history: { events: ["created", "migration_baseline", "contract_revised", "progress", "handoff", "state_transitioned", "result_reported", "assignment_changed", "parent_changed", "archived", "restored", "deleted"], operations: ["append", "list"], defaultListLimit: WORK_ITEM_DEFAULT_LIST_LIMIT, maxListLimit: WORK_ITEM_MAX_LIST_LIMIT },
      defaultListLimit: WORK_ITEM_DEFAULT_LIST_LIMIT,
      maxListLimit: WORK_ITEM_MAX_LIST_LIMIT,
      maxListResponseBytes: SESSION_RUNTIME_MAX_RESPONSE_BYTES,
      maxEventPayloadBytes: WORK_ITEM_MAX_EVENT_PAYLOAD_BYTES,
      maxMigrationBaselinePayloadBytes: WORK_ITEM_MAX_MIGRATION_BASELINE_PAYLOAD_BYTES,
      maxResultBytes: WORK_ITEM_MAX_RESULT_BYTES,
      aggregation: {
        contractRevision: WORK_ITEM_AGGREGATION_CONTRACT_REVISION,
        decisions: WORK_ITEM_AGGREGATION_DECISIONS,
        operations: ["get", "list", "decide", "retry", "correct"],
        defaultListLimit: WORK_ITEM_AGGREGATION_DEFAULT_LIST_LIMIT,
        maxListLimit: WORK_ITEM_AGGREGATION_MAX_LIST_LIMIT,
      },
    },
    sessionLifecycle: {
      operations: ["create", "configure", "rename", "move.manifest", "move", "clone", "restore", "archive", "delete.manifest", "delete"],
      placement: ["root", "child"],
      moveKinds: ["same_root", "cross_root"],
      restoreKinds: ["root", "child"],
        capabilities: ["root.create", "child.create", "configure", "rename", "move.same_root", "move.cross_root", "clone", "restore", "archive", "delete"],
      constraints: [
        "Root WorkItem successor creation is supported by the lifecycle owner; active WorkItem root moves are rejected.",
        "Cross-root transfer is limited to idle resources with a complete transfer manifest.",
          "Delete records a permanent tombstone and retains history, budget ledgers and replay identity; physical purge is not supported.",
      ],
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
  if (operation === "session.create" || operation === "session.rename"
        || operation === "session.configure"
        || operation === "session.move"
        || operation === "session.clone"
        || operation === "session.restore"
        || operation === "session.archive"
        || operation === "session.delete" || ["session.configure", "session.move", "session.clone", "session.restore", "session.archive", "session.delete"].includes(operation)) {
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
    expectedRevision: input.expectedRevision,
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
    includeArchived: input.includeArchived ?? false,
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
      || value.includeArchived !== (input.includeArchived ?? false)
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
    state: input.state ?? null,
    depth: input.depth ?? 1,
    fields: input.fields ?? null,
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
      || value.decision !== (input.decision ?? null) || value.state !== (input.state ?? null)
      || value.depth !== (input.depth ?? 1)
      || JSON.stringify(value.fields ?? null) !== JSON.stringify(input.fields ?? null)
      || !Number.isSafeInteger(value.afterSequence)
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
  if (error instanceof SessionLifecycleRecoveryError) {
    return createSessionRuntimeError({ code: error.code, message: error.message, retryable: true, effect: error.effect,
      details: { operationId: error.operationId, ...(error.sessionId ? { sessionId: error.sessionId } : {}) } });
  }
  if (error instanceof ResourceBudgetError) {
    return createSessionRuntimeError({
      code: error.code,
      message: error.message,
      retryable: error.code === "BUDGET_REVISION_CONFLICT" || error.code === "BUDGET_STORAGE_UNKNOWN",
      effect: "not_applied",
      details: { ...error.details },
    });
  }
  if (error instanceof SessionExecutionIdempotencyResponseUnavailableError
    || error instanceof SessionCrudIdempotencyResponseUnavailableError
    || error instanceof SessionFileWriteIdempotencyResponseUnavailableError
    || error instanceof SessionTranscriptIdempotencyResponseUnavailableError
    || error instanceof CoordinationEventIdempotencyResponseUnavailableError) {
    return createSessionRuntimeError({ code: error.code, message: error.message, effect: error.effect,
      details: {
        operation,
        reason: "legacy_principal_unavailable",
        ...(error instanceof CoordinationEventIdempotencyResponseUnavailableError ? { eventId: error.eventId } : {}),
        ...(error instanceof SessionExecutionIdempotencyResponseUnavailableError ? { executionId: error.executionId } : {}),
      } });
  }
  if (error instanceof SessionExecutionRevisionConflictError) {
    return createSessionRuntimeError({ code: error.code, message: error.message, effect: "not_applied",
      details: { executionId: error.executionId, expectedRevision: error.expectedRevision, currentRevision: error.actualRevision } });
  }
  if (error instanceof SessionResourceRevisionConflictError) {
    return createSessionRuntimeError({ code: error.code, message: error.message, effect: "not_applied",
      details: { sessionId: error.sessionId, expectedRevision: error.expectedRevision, currentRevision: error.actualRevision } });
  }
  if (error instanceof CoordinationEventRevisionConflictError) {
    return createSessionRuntimeError({ code: error.code, message: error.message, effect: "not_applied",
      details: { eventId: error.eventId, expectedRevision: error.expectedRevision, currentRevision: error.currentRevision } });
  }
  if (error instanceof SessionInteractionRevisionConflictError) {
    return createSessionRuntimeError({ code: error.code, message: error.message, effect: "not_applied",
      details: { interactionId: error.interactionId, currentRevision: error.currentRevision } });
  }
  if (error instanceof SessionInteractionAuthorityError) {
    return createSessionRuntimeError({ code: error.code, message: error.message, effect: "not_applied" });
  }
  if (error instanceof SessionInteractionContinuationSettlementError) {
    return createSessionRuntimeError({
      code: error.code,
      message: error.message,
      effect: "applied",
      details: { interactionId: error.interactionId, revision: error.revision, continuationEffect: error.continuationEffect },
    });
  }
  if (error instanceof SessionAuthorityError) {
    return createSessionRuntimeError({ code: error.code, message: error.message, details: Object.fromEntries(Object.entries(error.details).filter((entry): entry is [string, string | number] => entry[1] !== null)), effect: "not_applied" });
  }
  if (error instanceof SessionLifecycleOperationConflictError || error instanceof SessionLifecycleOperationRevisionConflictError) {
    return createSessionRuntimeError({ code: error.code, message: error.message, effect: "not_applied", retryable: error instanceof SessionLifecycleOperationRevisionConflictError });
  }
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
        || operation === "session.configure"
        || operation === "session.move"
        || operation === "session.clone"
        || operation === "session.restore"
        || operation === "session.archive"
        || operation === "session.delete"
        || operation === "turn.run"
        || operation === "turn.enqueue"
        || operation === "turn.cancel"
        || operation === "work.create"
        || operation === "work.reassign" || operation === "work.move" || operation === "work.clone"
        || operation === "work.reopen" || operation === "work.archive" || operation === "work.restore" || operation === "work.delete"
        || operation === "work.transition"
        || operation === "work.result"
        || operation === "work.result.correct"
        || operation === "work.cancel"
        || operation === "work.aggregation.decide"
        || operation === "work.aggregation.retry"
        || operation === "work.aggregation.correct"
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
  if (error instanceof WorkItemIdempotencyResponseUnavailableError) {
    return createSessionRuntimeError({
      code: error.code,
      message: "The original idempotent Work Item response is unavailable after migration.",
      effect: "applied",
      details: {
        operation: error.operation,
        workItemId: error.workItemId,
      },
    });
  }
  if (error instanceof WorkItemResultTooLargeError) {
    return createSessionRuntimeError({
      code: error.code,
      message: error.message,
      details: { actualBytes: error.actualBytes, maxBytes: WORK_ITEM_MAX_RESULT_BYTES },
    });
  }
  if (error instanceof WorkItemEventPayloadTooLargeError) {
    return createSessionRuntimeError({
      code: error.code,
      message: error.message,
      details: { eventType: error.eventType, actualBytes: error.actualBytes, maxBytes: error.maxBytes },
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
  return operation === "budget.configure"
    || operation === "session.create"
    || operation === "session.rename"
        || operation === "session.configure"
        || operation === "session.move"
        || operation === "session.clone"
        || operation === "session.restore"
        || operation === "session.archive"
        || operation === "session.delete"
    || operation === "turn.run"
    || operation === "turn.enqueue"
    || operation === "turn.cancel"
    || operation === "work.create"
    || operation === "work.reassign" || operation === "work.move" || operation === "work.clone"
    || operation === "work.reopen" || operation === "work.archive" || operation === "work.restore" || operation === "work.delete"
    || operation === "work.revise"
    || operation === "work.history.append"
    || operation === "work.transition"
    || operation === "work.result"
    || operation === "work.result.correct"
    || operation === "work.cancel"
    || operation === "work.aggregation.decide"
    || operation === "work.aggregation.retry"
    || operation === "work.aggregation.correct"
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
