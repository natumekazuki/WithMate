import type { Session } from "../../src-shared/session/session-state.js";
import type { AuxiliarySession } from "../../src-shared/auxiliary/auxiliary-session-state.js";
import { createDefaultSessionMemory } from "../../src-shared/memory/session-memory-state.js";
import type { LiveApprovalDecision, LiveApprovalRequest, LiveElicitationResponse, LiveElicitationRequest, LiveSessionRunState, ProviderQuotaTelemetry, SessionContextTelemetry } from "../../src-shared/session/runtime-state.js";
import type { ModelCatalogProvider } from "../../src-shared/settings/model-catalog.js";
import type { SessionTurnNotificationTarget } from "../session/session-turn-notification-service.js";
import type { ProviderAgentRuntimeBindingProjection } from "../providers/agent-runtime-binding.js";
import { SessionRuntimeService, type SessionRuntimeServiceDeps } from "../session/session-runtime-service.js";

type AuxiliaryRuntimeOwner = {
  assertActive(operation: string): void;
};

export type AuxiliarySessionRuntimeAssemblyDeps = {
  owner: AuxiliaryRuntimeOwner;
  admission: Required<Pick<SessionRuntimeServiceDeps, "runSessionAdmissionExclusive">>;
  auxiliary: {
    getRuntimeSession(sessionId: string): Promise<Session | null>;
    getSession(sessionId: string): Promise<AuxiliarySession | null>;
    upsertRuntimeSession(session: Session, options?: { confirmedFinalAssistantText?: string | null }): Promise<Session>;
    isAuxiliarySession(sessionId: string): Promise<boolean>;
  };
  parent: {
    getSession(sessionId: string): Promise<Session | null>;
  };
  resolution: {
    resolveComposerPreview: SessionRuntimeServiceDeps["resolveComposerPreview"];
    resolveProviderCatalog: SessionRuntimeServiceDeps["resolveProviderCatalog"];
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
  };
  audit: Pick<SessionRuntimeServiceDeps, "createAuditLog" | "updateAuditLog">;
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
    resolveApproval(sessionId: string, requestId: string, decision: LiveApprovalDecision): void;
    resolveElicitation(sessionId: string, requestId: string, response: LiveElicitationResponse): void;
    invalidateProviderSessionThread(providerId: string | null | undefined, sessionId: string): Promise<void>;
  };
  notification(notification: Parameters<NonNullable<SessionRuntimeServiceDeps["notifySessionTurnTerminal"]>>[0], target: SessionTurnNotificationTarget): void | Promise<void>;
  currentTimestampLabel?: () => string;
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
    upsertSession: (session, options) => guarded("session upsert", () => deps.auxiliary.upsertRuntimeSession(session, options)),
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
    beginProviderAgentRuntimeTurn: ({ session, provider, binding }) => binding && deps.provider.beginRuntimeTurn
      ? guarded("provider runtime turn", () => deps.provider.beginRuntimeTurn!({ session, provider, binding }))
      : undefined,
    endProviderAgentRuntimeTurn: deps.provider.endProviderAgentRuntimeTurn,
    resetProviderSessionThread: (providerId, sessionId) => guarded("provider thread reset", () => deps.provider.resetProviderSessionThread!(providerId, sessionId)),
    isAuxiliarySession: (sessionId) => guarded("Auxiliary session check", () => deps.auxiliary.isAuxiliarySession(sessionId)),
    getSessionMemory: (session) => createDefaultSessionMemory({ id: session.id, workspacePath: session.workspacePath, threadId: session.threadId, taskTitle: session.taskTitle }),
    resolveProjectMemoryEntriesForPrompt: () => [],
    createAuditLog: (entry) => guarded("audit create", () => deps.audit.createAuditLog(entry)),
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
    resolvePendingApprovalRequest: (sessionId, decision) => { assertOwner("pending approval resolution"); const requestId = deps.live.getLiveSessionRun(sessionId)?.approvalRequest?.requestId; if (requestId) deps.interaction.resolveApproval(sessionId, requestId, decision); },
    resolvePendingElicitationRequest: (sessionId, response) => { assertOwner("pending elicitation resolution"); const requestId = deps.live.getLiveSessionRun(sessionId)?.elicitationRequest?.requestId; if (requestId) deps.interaction.resolveElicitation(sessionId, requestId, response); },
    notifySessionTurnTerminal: async (notification) => guarded("terminal notification", async () => {
      const auxiliary = await deps.auxiliary.getSession(notification.session.id);
      if (!auxiliary || !await deps.parent.getSession(auxiliary.parentSessionId)) return;
      await deps.notification(notification, { kind: "auxiliary", parentSessionId: auxiliary.parentSessionId, auxiliarySessionId: auxiliary.id });
    }),
    currentTimestampLabel: deps.currentTimestampLabel,
  };
  return new SessionRuntimeService(runtime);
}
