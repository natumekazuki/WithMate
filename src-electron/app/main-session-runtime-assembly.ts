import type { Session } from "../../src-shared/session/session-state.js";
import type { CharacterContextResponse, CharacterContextErrorResponse } from "../../src-shared/character-context/character-context-contract.js";
import { isCharacterContextError } from "../../src-shared/character-context/character-context-contract.js";
import { CHARACTER_CONTEXT_SCHEMA_VERSION } from "../../src-shared/character-context/character-context-contract.js";
import { SessionRuntimeService, type SessionRuntimeServiceDeps } from "../session/session-runtime-service.js";
import type { CharacterAffectTurnSettlementStorage } from "../character/character-affect-turn-settlement-storage.js";
import { getSessionIncarnationId } from "../../src-shared/session/session-state.js";
import { createDefaultSessionMemory } from "../../src-shared/memory/session-memory-state.js";
import { resolveConversationTimingContext, type ConversationTimingContext, type ConversationTimingStorageSnapshot } from "../session/conversation-timing.js";
import type { CharacterContextApplicationService } from "../character/character-context-application-service.js";

type CreateAuditLogInput = Parameters<NonNullable<SessionRuntimeServiceDeps["createAuditLog"]>>[0];
type AppraisalInput = Parameters<NonNullable<SessionRuntimeServiceDeps["queueCompletedTurnAppraisal"]>>[0];

export type MainSessionRuntimeAssemblyDeps = {
  owner: {
    assertActive(operation: string): void;
    isActive(): boolean;
  };
  admission: Required<Pick<SessionRuntimeServiceDeps, "runSessionAdmissionExclusive">>;
  sessions: Required<Pick<SessionRuntimeServiceDeps, "getSession" | "upsertSession" | "persistRunningTurnStart" | "clearCharacterAuthoringRuntimeState" | "upsertTerminalSession">>;
  resolution: Pick<SessionRuntimeServiceDeps, "resolveRuntimeSessionForTurn" | "resolveComposerPreview" | "resolveProviderSession" | "resolveSessionFolderPath" | "resolveProviderCatalog"> & {
    resolveRuntimeSessionForTurn: NonNullable<SessionRuntimeServiceDeps["resolveRuntimeSessionForTurn"]>;
    resolveComposerPreview: SessionRuntimeServiceDeps["resolveComposerPreview"];
    resolveProviderSession: NonNullable<SessionRuntimeServiceDeps["resolveProviderSession"]>;
    resolveSessionFolderPath: NonNullable<SessionRuntimeServiceDeps["resolveSessionFolderPath"]>;
    resolveProviderCatalog: SessionRuntimeServiceDeps["resolveProviderCatalog"];
  };
  provider: Pick<SessionRuntimeServiceDeps, "getProviderCodingAdapter" | "resetProviderSessionThread" | "getProviderAgentRuntimeBinding" | "beginProviderAgentRuntimeTurn" | "endProviderAgentRuntimeTurn">;
  memory: {
    resolveProjectMemoryEntriesForPrompt: SessionRuntimeServiceDeps["resolveProjectMemoryEntriesForPrompt"];
    getAppSettings: SessionRuntimeServiceDeps["getAppSettings"];
    getCharacterContextService?: () => Pick<CharacterContextApplicationService, "getContext"> | null;
    onCharacterContextFailure: (session: Session, error: CharacterContextErrorResponse) => void;
    getConversationTimingSnapshot?: (sessionId: string, observedAt: string) => Promise<ConversationTimingStorageSnapshot | null>;
  };
  character: {
    getSettlementStorage: () => CharacterAffectTurnSettlementStorage;
    requestAppraisal?: () => void;
  };
  audit: Pick<SessionRuntimeServiceDeps, "createAuditLog" | "updateAuditLog">;
  live: Pick<SessionRuntimeServiceDeps, "setLiveSessionRun" | "getLiveSessionRun" | "setProviderQuotaTelemetry" | "setSessionContextTelemetry" | "scheduleProviderQuotaTelemetryRefresh" | "broadcastLiveSessionRun">;
  interaction: Pick<SessionRuntimeServiceDeps, "waitForApprovalDecision" | "waitForElicitationResponse" | "resolvePendingApprovalRequest" | "resolvePendingElicitationRequest" | "invalidateProviderSessionThread">;
  notification: Pick<SessionRuntimeServiceDeps, "notifySessionTurnTerminal">;
  timing: {
    currentTimestampLabel?: () => string;
  };
  resolveSessionMemory?: SessionRuntimeServiceDeps["getSessionMemory"];
};

/** Creates the main-process runtime with its owner guard and domain callback assembly. */
export function createMainSessionRuntime(deps: MainSessionRuntimeAssemblyDeps): SessionRuntimeService {
  const assertOwner = (operation: string): void => deps.owner.assertActive(`Session runtime ${operation}`);
  const guarded = async <T>(operation: string, callback: () => T | Promise<T>): Promise<T> => {
    assertOwner(operation);
    const result = await callback();
    assertOwner(operation);
    return result;
  };

  const getSessionMemory: SessionRuntimeServiceDeps["getSessionMemory"] = deps.resolveSessionMemory ?? ((session: Session) => createDefaultSessionMemory({
    id: session.id,
    workspacePath: session.workspacePath,
    threadId: session.threadId,
    taskTitle: session.taskTitle,
  }));

  const resolveCharacterContext = async (session: Session, query: string): Promise<CharacterContextResponse | null> => {
    assertOwner("character context");
    const service = deps.memory.getCharacterContextService?.();
    if (session.sessionKind !== "default" || !session.characterId || !service) return null;
    const result = await service.getContext({
      schemaVersion: CHARACTER_CONTEXT_SCHEMA_VERSION,
      characterId: session.characterId,
      sessionId: session.id,
      query,
      memoryLimit: 3,
    }, "lifecycle");
    assertOwner("character context");
    if (isCharacterContextError(result)) {
      deps.memory.onCharacterContextFailure(session, result);
      return null;
    }
    return result;
  };

  const queueCompletedTurnAppraisal = async (input: AppraisalInput): Promise<void> => {
    assertOwner("appraisal enqueue");
    if (input.session.sessionKind === "default" && input.session.characterId) {
      await deps.character.getSettlementStorage().enqueue({
        correlationId: input.correlationId,
        characterId: input.session.characterId,
        sessionId: input.session.id,
        sessionIncarnationId: getSessionIncarnationId(input.session),
        userMessage: input.userMessage,
        assistantMessage: input.assistantMessage,
        assistantMessageIndex: input.assistantMessageIndex,
        occurredAt: input.occurredAt,
      });
    }
    assertOwner("appraisal enqueue");
  };

  const markCompletedTurnAppraisalReady = async (correlationId: string): Promise<"ready" | "absent" | void> => {
    if (!deps.owner.isActive()) return "absent";
    assertOwner("appraisal ready");
    try {
      const result = await deps.character.getSettlementStorage().markReady(correlationId);
      if (!deps.owner.isActive()) return "absent";
      assertOwner("appraisal ready");
      return result.updated ? "ready" : "absent";
    } catch (error) {
      if (!deps.owner.isActive()) return "absent";
      throw error;
    }
  };

  const assembled: SessionRuntimeServiceDeps = {
    runSessionAdmissionExclusive: (sessionId, operation, signal) =>
      deps.admission.runSessionAdmissionExclusive(sessionId, () => guarded("admission", operation), signal),
    getSession: (sessionId) => { assertOwner("session read"); return deps.sessions.getSession(sessionId); },
    upsertSession: (session, options) => guarded("session upsert", () => deps.sessions.upsertSession(session, options)),
    persistRunningTurnStart: (session, count) => guarded("running turn start", () => deps.sessions.persistRunningTurnStart(session, count)),
    clearCharacterAuthoringRuntimeState: (session) => guarded("authoring runtime clear", () => deps.sessions.clearCharacterAuthoringRuntimeState(session)),
    upsertTerminalSession: (session, commit, options) => guarded("terminal session", () => deps.sessions.upsertTerminalSession(session, commit, options)),
    resolveRuntimeSessionForTurn: (session) => guarded("runtime session resolution", () => deps.resolution.resolveRuntimeSessionForTurn(session)),
    resolveComposerPreview: (session, message) => guarded("composer preview", () => deps.resolution.resolveComposerPreview(session, message)),
    resolveProviderSession: (session) => guarded("provider session path", () => deps.resolution.resolveProviderSession(session)),
    resolveSessionFolderPath: (id) => guarded("session folder path", () => deps.resolution.resolveSessionFolderPath(id)),
    getAppSettings: () => guarded("settings read", deps.memory.getAppSettings),
    resolveProviderCatalog: (providerId, revision) => guarded("provider catalog", () => deps.resolution.resolveProviderCatalog(providerId, revision)),
    getProviderCodingAdapter: deps.provider.getProviderCodingAdapter,
    resetProviderSessionThread: deps.provider.resetProviderSessionThread,
    getProviderAgentRuntimeBinding: deps.provider.getProviderAgentRuntimeBinding,
    beginProviderAgentRuntimeTurn: deps.provider.beginProviderAgentRuntimeTurn,
    endProviderAgentRuntimeTurn: deps.provider.endProviderAgentRuntimeTurn,
    getSessionMemory,
    resolveProjectMemoryEntriesForPrompt: deps.memory.resolveProjectMemoryEntriesForPrompt,
    resolveConversationTimingContext: deps.memory.getConversationTimingSnapshot
      ? async (session, observedAt): Promise<ConversationTimingContext | null> => {
        assertOwner("conversation timing");
        if (session.sessionKind !== "default") return null;
        const snapshot = await deps.memory.getConversationTimingSnapshot!(session.id, observedAt.toISOString());
        assertOwner("conversation timing");
        if (!snapshot) return null;
        return resolveConversationTimingContext(snapshot, observedAt);
      }
      : undefined,
    resolveCharacterContext,
    queueCompletedTurnAppraisal,
    markCompletedTurnAppraisalReady,
    requireDurableCompletedTurnAppraisal: true,
    appraiseCompletedTurn: deps.character.requestAppraisal ? () => { deps.character.requestAppraisal!(); } : undefined,
    createAuditLog: (entry: CreateAuditLogInput) => guarded("audit create", () => deps.audit.createAuditLog(entry)),
    updateAuditLog: (id, entry) => guarded("audit update", () => deps.audit.updateAuditLog(id, entry)),
    setLiveSessionRun: (id, state) => { assertOwner("live session projection"); deps.live.setLiveSessionRun(id, state); },
    getLiveSessionRun: (id) => { assertOwner("live session read"); return deps.live.getLiveSessionRun(id); },
    waitForApprovalDecision: deps.interaction.waitForApprovalDecision,
    waitForElicitationResponse: deps.interaction.waitForElicitationResponse,
    setProviderQuotaTelemetry: (telemetry) => { assertOwner("provider quota projection"); deps.live.setProviderQuotaTelemetry(telemetry); },
    setSessionContextTelemetry: (telemetry) => { assertOwner("session context projection"); deps.live.setSessionContextTelemetry(telemetry); },
    invalidateProviderSessionThread: (providerId, sessionId) => guarded("provider thread invalidation", () => deps.interaction.invalidateProviderSessionThread(providerId, sessionId)),
    scheduleProviderQuotaTelemetryRefresh: (id, delays) => { assertOwner("provider quota schedule"); deps.live.scheduleProviderQuotaTelemetryRefresh(id, delays); },
    broadcastLiveSessionRun: (id) => { assertOwner("live session broadcast"); deps.live.broadcastLiveSessionRun(id); },
    resolvePendingApprovalRequest: deps.interaction.resolvePendingApprovalRequest,
    resolvePendingElicitationRequest: deps.interaction.resolvePendingElicitationRequest,
    notifySessionTurnTerminal: deps.notification.notifySessionTurnTerminal,
    currentTimestampLabel: deps.timing.currentTimestampLabel,
  };
  return new SessionRuntimeService(assembled);
}
