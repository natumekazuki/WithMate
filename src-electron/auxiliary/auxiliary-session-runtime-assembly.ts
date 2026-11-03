import { getSessionIncarnationId, type Session } from "../../src-shared/session/session-state.js";
import type { AuxiliarySession } from "../../src-shared/auxiliary/auxiliary-session-state.js";
import { createDefaultSessionMemory } from "../../src-shared/memory/session-memory-state.js";
import type { LiveApprovalDecision, LiveApprovalRequest, LiveElicitationResponse, LiveElicitationRequest, LiveSessionRunState, ProviderQuotaTelemetry, SessionContextTelemetry } from "../../src-shared/session/runtime-state.js";
import type { ModelCatalogProvider } from "../../src-shared/settings/model-catalog.js";
import type { SessionTurnNotificationTarget } from "../session/session-turn-notification-service.js";
import type { ProviderAgentRuntimeBindingProjection } from "../providers/agent-runtime-binding.js";
import { SessionRuntimeService, type SessionRuntimeServiceDeps } from "../session/session-runtime-service.js";
import type { CharacterContextApplicationService } from "../character/character-context-application-service.js";
import type { CharacterContextErrorResponse } from "../../src-shared/character-context/character-context-contract.js";
import { resolveRuntimeCharacterContext } from "../character/character-context-runtime.js";

type AuxiliaryRuntimeOwner = {
  assertActive(operation: string): void;
};

export type AuxiliarySessionRuntimeAssemblyDeps = {
  owner: AuxiliaryRuntimeOwner;
  admission: Required<Pick<SessionRuntimeServiceDeps, "runSessionAdmissionExclusive">>;
  auxiliary: {
    getRuntimeSession(sessionId: string): Promise<Session | null>;
    getSession(sessionId: string): Promise<AuxiliarySession | null>;
    appendRunningInput: SessionRuntimeServiceDeps["appendRunningInput"];
    appendTerminalSession: SessionRuntimeServiceDeps["appendTerminalSession"];
    checkpointRuntimeMetadata: SessionRuntimeServiceDeps["checkpointRuntimeMetadata"];
    persistRunningTurnStart(session: Session, expectedMessageCount: number): Promise<Session>;
    persistQueuedTurnStart?: SessionRuntimeServiceDeps["persistQueuedTurnStart"];
    isAuxiliarySession(sessionId: string): Promise<boolean>;
  };
  parent: {
    getSession(sessionId: string): Promise<Session | null>;
  };
  resolution: {
    resolveRuntimeSessionForTurn: NonNullable<SessionRuntimeServiceDeps["resolveRuntimeSessionForTurn"]>;
    resolveComposerPreview: SessionRuntimeServiceDeps["resolveComposerPreview"];
    resolveProviderCatalog: SessionRuntimeServiceDeps["resolveProviderCatalog"];
    assertCapturedComposerAttachmentsAvailable?: SessionRuntimeServiceDeps["assertCapturedComposerAttachmentsAvailable"];
  };
  provider: {
    getProviderCodingAdapter: NonNullable<SessionRuntimeServiceDeps["getProviderCodingAdapter"]>;
    resetProviderSessionThread: NonNullable<SessionRuntimeServiceDeps["resetProviderSessionThread"]>;
    endProviderAgentRuntimeTurn?: SessionRuntimeServiceDeps["endProviderAgentRuntimeTurn"];
    resolveProviderSession(session: Session, parentSessionId: string): Session;
    resolveSessionFolderPath(parentSessionId: string): string;
    issueRuntimeBinding(session: Session, provider: ModelCatalogProvider): Promise<ProviderAgentRuntimeBindingProjection>;
    beginRuntimeTurn?: SessionRuntimeServiceDeps["beginProviderAgentRuntimeTurn"];
  };
  memory: {
    getAppSettings: SessionRuntimeServiceDeps["getAppSettings"];
    getCharacterContextService?: () => Pick<CharacterContextApplicationService, "getContext"> | null;
    onCharacterContextFailure?: (session: Session, error: CharacterContextErrorResponse) => void;
  };
  turn: Pick<SessionRuntimeServiceDeps, "createSessionTurn" | "updateSessionTurn">;
  live: {
    setLiveSessionRun(sessionId: string, state: LiveSessionRunState | null): void;
    getLiveSessionRun(sessionId: string): LiveSessionRunState | null;
    setProviderQuotaTelemetry(telemetry: ProviderQuotaTelemetry): void;
    setSessionContextTelemetry(telemetry: SessionContextTelemetry): void;
    scheduleProviderQuotaTelemetryRefresh(providerId: string, delaysMs: number[]): void;
    broadcastLiveSessionRun(sessionId: string): void;
  };
  interaction: {
    waitForApprovalDecision(sessionId: string, request: LiveApprovalRequest, signal: AbortSignal): Promise<LiveApprovalDecision> | LiveApprovalDecision;
    waitForElicitationResponse(sessionId: string, request: LiveElicitationRequest, signal: AbortSignal): Promise<LiveElicitationResponse> | LiveElicitationResponse;
    cancelApprovals(sessionId: string): void;
    cancelElicitations(sessionId: string): void;
    invalidateProviderSessionThread(providerId: string | null | undefined, sessionId: string): Promise<void>;
  };
  notification(notification: Parameters<NonNullable<SessionRuntimeServiceDeps["notifySessionTurnTerminal"]>>[0], target: SessionTurnNotificationTarget): void | Promise<void>;
  currentTimestampLabel?: () => string;
  getQueuedInputReceipt?: SessionRuntimeServiceDeps["getQueuedInputReceipt"];
  onSessionRunReleased?: SessionRuntimeServiceDeps["onSessionRunReleased"];
  onBackgroundEvent?: SessionRuntimeServiceDeps["onBackgroundEvent"];
};

export function createAuxiliarySessionRuntime(deps: AuxiliarySessionRuntimeAssemblyDeps): SessionRuntimeService {
  const assertOwner = (operation: string): void => deps.owner.assertActive(`Auxiliary session runtime ${operation}`);
  const guarded = async <T>(operation: string, callback: () => T | Promise<T>): Promise<T> => {
    assertOwner(operation);
    const result = await callback();
    assertOwner(operation);
    return result;
  };

  const runtime: SessionRuntimeServiceDeps = {
    runSessionAdmissionExclusive: (sessionId, operation, signal) =>
      deps.admission.runSessionAdmissionExclusive(sessionId, () => guarded("admission", operation), signal),
    getSession: (sessionId) => guarded("session read", () => deps.auxiliary.getRuntimeSession(sessionId)),
    appendRunningInput: (session, text, turnId, queuedInput) => guarded("Session input append", () => deps.auxiliary.appendRunningInput(session, text, turnId, queuedInput)),
    appendTerminalSession: (session, commit, options) => guarded("terminal Session append", () => deps.auxiliary.appendTerminalSession(session, commit, options)),
    checkpointRuntimeMetadata: (session, expected) => guarded("runtime metadata checkpoint", () => deps.auxiliary.checkpointRuntimeMetadata(session, expected)),
    persistRunningTurnStart: (session, expectedMessageCount) => guarded("running turn start", () => deps.auxiliary.persistRunningTurnStart(session, expectedMessageCount)),
    persistQueuedTurnStart: deps.auxiliary.persistQueuedTurnStart ? (session, count, queueId, turn) => guarded("queued turn start", () => deps.auxiliary.persistQueuedTurnStart!(session, count, queueId, turn)) : undefined,
    assertCapturedComposerAttachmentsAvailable: deps.resolution.assertCapturedComposerAttachmentsAvailable ? (session, attachments) => guarded("captured attachments", () => deps.resolution.assertCapturedComposerAttachmentsAvailable!(session, attachments)) : undefined,
    getQueuedInputReceipt: deps.getQueuedInputReceipt ? (receipt) => guarded("queued input receipt", () => deps.getQueuedInputReceipt!(receipt)) : undefined,
    onSessionRunReleased: deps.onSessionRunReleased,
    onBackgroundEvent: deps.onBackgroundEvent,
    resolveRuntimeSessionForTurn: (session) => guarded("runtime session resolution", () => deps.resolution.resolveRuntimeSessionForTurn(session)),
    resolveComposerPreview: (session, userMessage) => guarded("composer preview", () => deps.resolution.resolveComposerPreview(session, userMessage)),
    resolveProviderSession: (session) => guarded("provider session path", async () => {
      const auxiliary = await deps.auxiliary.getSession(session.id);
      return deps.provider.resolveProviderSession(session, auxiliary?.parentSessionId ?? session.id);
    }),
    resolveSessionFolderPath: (sessionId) => guarded("session folder path", async () => {
      const auxiliary = await deps.auxiliary.getSession(sessionId);
      return deps.provider.resolveSessionFolderPath(auxiliary?.parentSessionId ?? sessionId);
    }),
    getAppSettings: () => guarded("settings read", deps.memory.getAppSettings),
    resolveProviderCatalog: (providerId, revision) => guarded("provider catalog", () => deps.resolution.resolveProviderCatalog(providerId, revision)),
    getProviderCodingAdapter: (providerId) => { assertOwner("provider coding adapter"); return deps.provider.getProviderCodingAdapter(providerId); },
    getProviderAgentRuntimeBinding: ({ session, provider }) => guarded("provider runtime binding", () => deps.provider.issueRuntimeBinding(session, provider)),
    beginProviderAgentRuntimeTurn: ({ session, provider, binding, signal }) => binding && deps.provider.beginRuntimeTurn
      ? guarded("provider runtime turn", () => deps.provider.beginRuntimeTurn!({ session, provider, binding, signal }))
      : undefined,
    endProviderAgentRuntimeTurn: deps.provider.endProviderAgentRuntimeTurn,
    resetProviderSessionThread: (providerId, sessionId) => guarded("provider thread reset", () => deps.provider.resetProviderSessionThread!(providerId, sessionId)),
    isAuxiliarySession: (sessionId) => guarded("Auxiliary session check", () => deps.auxiliary.isAuxiliarySession(sessionId)),
    getSessionMemory: (session) => createDefaultSessionMemory({ id: session.id, workspacePath: session.workspacePath, threadId: session.threadId, taskTitle: session.taskTitle }),
    resolveCharacterContext: (session, query) => guarded("character context", async () => {
      const service = deps.memory.getCharacterContextService?.();
      if (session.sessionKind !== "default" || !session.characterId || !service) return null;
      const auxiliary = await deps.auxiliary.getSession(session.id);
      const parent = auxiliary && await deps.parent.getSession(auxiliary.parentSessionId);
      if (!auxiliary || !parent) throw new Error("Auxiliary Character context owner is unavailable.");
      return resolveRuntimeCharacterContext({
        session, query, service,
        sessionSource: {
          kind: "auxiliary", sessionId: session.id, incarnationId: getSessionIncarnationId(session),
          parent: { sessionId: parent.id, incarnationId: getSessionIncarnationId(parent) },
        },
        onFailure: (owner, error) => deps.memory.onCharacterContextFailure?.(owner, error),
      });
    }),
    resolveProjectMemoryEntriesForPrompt: () => [],
    createSessionTurn: (entry) => guarded("turn create", () => deps.turn.createSessionTurn(entry)),
    updateSessionTurn: (id, entry) => guarded("turn update", () => deps.turn.updateSessionTurn(id, entry)),
    setLiveSessionRun: (id, state) => { assertOwner("live session projection"); deps.live.setLiveSessionRun(id, state); },
    getLiveSessionRun: (id) => { assertOwner("live session read"); return deps.live.getLiveSessionRun(id); },
    waitForApprovalDecision: deps.interaction.waitForApprovalDecision,
    waitForElicitationResponse: deps.interaction.waitForElicitationResponse,
    setProviderQuotaTelemetry: (telemetry) => { assertOwner("provider quota projection"); deps.live.setProviderQuotaTelemetry(telemetry); },
    setSessionContextTelemetry: (telemetry) => { assertOwner("session context projection"); deps.live.setSessionContextTelemetry(telemetry); },
    invalidateProviderSessionThread: (providerId, sessionId) => guarded("provider thread invalidation", () => deps.interaction.invalidateProviderSessionThread(providerId, sessionId)),
    scheduleProviderQuotaTelemetryRefresh: (id, delays) => { assertOwner("provider quota schedule"); deps.live.scheduleProviderQuotaTelemetryRefresh(id, delays); },
    broadcastLiveSessionRun: (id) => { assertOwner("live session broadcast"); deps.live.broadcastLiveSessionRun(id); },
    resolvePendingApprovalRequest: (sessionId) => { assertOwner("pending approval cancellation"); deps.interaction.cancelApprovals(sessionId); },
    resolvePendingElicitationRequest: (sessionId) => { assertOwner("pending elicitation resolution"); deps.interaction.cancelElicitations(sessionId); },
    notifySessionTurnTerminal: async (notification) => guarded("terminal notification", async () => {
      const auxiliary = await deps.auxiliary.getSession(notification.session.id);
      if (!auxiliary || !await deps.parent.getSession(auxiliary.parentSessionId)) return;
      await deps.notification(notification, { kind: "auxiliary", parentSessionId: auxiliary.parentSessionId, auxiliarySessionId: auxiliary.id });
    }),
    currentTimestampLabel: deps.currentTimestampLabel,
  };
  return new SessionRuntimeService(runtime);
}
