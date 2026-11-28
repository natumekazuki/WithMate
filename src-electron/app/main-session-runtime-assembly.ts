import { getSessionIncarnationId, type Session } from "../../src-shared/session/session-state.js";
import type { MainSessionTarget } from "../../src-shared/session/session-target.js";
import { SessionRuntimeService, type SessionRuntimeServiceDeps } from "../session/session-runtime-service.js";

type CreateSessionTurnInput = Parameters<NonNullable<SessionRuntimeServiceDeps["createSessionTurn"]>>[0];

export type MainSessionRuntimeAssemblyDeps = {
  owner: {
    assertActive(operation: string): void;
    isActive(): boolean;
  };
  admission: Required<Pick<SessionRuntimeServiceDeps, "runSessionAdmissionExclusive">>;
  sessions: Required<Pick<SessionRuntimeServiceDeps, "getSession" | "persistRunningTurnStart" | "clearCharacterAuthoringRuntimeState" | "appendRunningInput" | "appendTerminalSession" | "checkpointRuntimeMetadata">> & Pick<SessionRuntimeServiceDeps, "persistQueuedTurnStart" | "getQueuedInputReceipt" | "beginRunningInput" | "settleRunningInput" | "beginSourceDisplayTurn">;
  resolution: Pick<SessionRuntimeServiceDeps, "resolveRuntimeSessionForTurn" | "resolveComposerPreview" | "resolveProviderSession" | "resolveSessionFolderPath" | "resolveProviderCatalog"> & {
    resolveRuntimeSessionForTurn: NonNullable<SessionRuntimeServiceDeps["resolveRuntimeSessionForTurn"]>;
    resolveComposerPreview: SessionRuntimeServiceDeps["resolveComposerPreview"];
    resolveProviderSession: NonNullable<SessionRuntimeServiceDeps["resolveProviderSession"]>;
    resolveSessionFolderPath: NonNullable<SessionRuntimeServiceDeps["resolveSessionFolderPath"]>;
    resolveCrewFolderPath?: SessionRuntimeServiceDeps["resolveCrewFolderPath"];
    resolveProviderCatalog: SessionRuntimeServiceDeps["resolveProviderCatalog"];
    assertCapturedComposerAttachmentsAvailable?: SessionRuntimeServiceDeps["assertCapturedComposerAttachmentsAvailable"];
  };
  provider: Pick<SessionRuntimeServiceDeps, "getProviderCodingAdapter" | "resetProviderSessionThread" | "getProviderAgentRuntimeBinding" | "beginProviderAgentRuntimeTurn" | "endProviderAgentRuntimeTurn">;
  context: {
    getAppSettings: SessionRuntimeServiceDeps["getAppSettings"];
    readSessionInstructions(target: MainSessionTarget): Promise<string>;
    assertSavedReplyTo?: SessionRuntimeServiceDeps["assertSavedReplyTo"];
    readMainMessageThread?: SessionRuntimeServiceDeps["readMainMessageThread"];
  };
  turn: Pick<SessionRuntimeServiceDeps, "createSessionTurn" | "updateSessionTurn">;
  live: Pick<SessionRuntimeServiceDeps, "setLiveSessionRun" | "getLiveSessionRun" | "setProviderQuotaTelemetry" | "setSessionContextTelemetry" | "scheduleProviderQuotaTelemetryRefresh" | "broadcastLiveSessionRun">;
  interaction: Pick<SessionRuntimeServiceDeps, "waitForApprovalDecision" | "startWithMateApprovalReview" | "waitForElicitationResponse" | "resolvePendingApprovalRequest" | "resolvePendingElicitationRequest" | "invalidateProviderSessionThread">;
  notification: Pick<SessionRuntimeServiceDeps, "notifySessionTurnTerminal" | "onSessionRunReleased" | "onSentInputChanged">;
  timing: {
    currentTimestampLabel?: () => string;
  };
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

  const assembled: SessionRuntimeServiceDeps = {
    runSessionAdmissionExclusive: (sessionId, operation, signal) =>
      deps.admission.runSessionAdmissionExclusive(sessionId, () => guarded("admission", operation), signal),
    getSession: (sessionId) => { assertOwner("session read"); return deps.sessions.getSession(sessionId); },
    readSessionInstructions: (session) => guarded("instructions read", () => deps.context.readSessionInstructions({
      kind: "main", sessionId: session.id, incarnationId: getSessionIncarnationId(session),
    })),
    appendRunningInput: (...args) => guarded("Session input append", () => deps.sessions.appendRunningInput(...args)),
    beginRunningInput: deps.sessions.beginRunningInput ? (...args) => guarded("Session input begin", () => deps.sessions.beginRunningInput!(...args)) : undefined,
    settleRunningInput: deps.sessions.settleRunningInput ? (...args) => guarded("Session input settle", () => deps.sessions.settleRunningInput!(...args)) : undefined,
    getQueuedInputReceipt: deps.sessions.getQueuedInputReceipt
      ? (receipt) => guarded("queued input receipt", () => deps.sessions.getQueuedInputReceipt!(receipt))
      : undefined,
    appendTerminalSession: (session, commit, options) => guarded("terminal Session append", () => deps.sessions.appendTerminalSession(session, commit, options)),
    beginSourceDisplayTurn: deps.sessions.beginSourceDisplayTurn,
    checkpointRuntimeMetadata: (session, expected) => guarded("runtime metadata checkpoint", () => deps.sessions.checkpointRuntimeMetadata(session, expected)),
    persistRunningTurnStart: (session, count) => guarded("running turn start", () => deps.sessions.persistRunningTurnStart(session, count)),
    persistQueuedTurnStart: deps.sessions.persistQueuedTurnStart
      ? (session, count, queueId, turn) => guarded("queued turn start", () => deps.sessions.persistQueuedTurnStart!(session, count, queueId, turn))
      : undefined,
    clearCharacterAuthoringRuntimeState: (session) => guarded("authoring runtime clear", () => deps.sessions.clearCharacterAuthoringRuntimeState(session)),
    resolveRuntimeSessionForTurn: (session) => guarded("runtime session resolution", () => deps.resolution.resolveRuntimeSessionForTurn(session)),
    resolveComposerPreview: (session, message) => guarded("composer preview", () => deps.resolution.resolveComposerPreview(session, message)),
    assertSavedReplyTo: deps.context.assertSavedReplyTo,
    readMainMessageThread: deps.context.readMainMessageThread,
    assertCapturedComposerAttachmentsAvailable: deps.resolution.assertCapturedComposerAttachmentsAvailable
      ? (session, attachments) => guarded("captured attachments", () => deps.resolution.assertCapturedComposerAttachmentsAvailable!(session, attachments))
      : undefined,
    resolveProviderSession: (session) => guarded("provider session path", () => deps.resolution.resolveProviderSession(session)),
    resolveSessionFolderPath: (id) => guarded("session folder path", () => deps.resolution.resolveSessionFolderPath(id)),
    resolveCrewFolderPath: deps.resolution.resolveCrewFolderPath
      ? (id) => guarded("crew folder path", () => deps.resolution.resolveCrewFolderPath!(id))
      : undefined,
    getAppSettings: () => guarded("settings read", deps.context.getAppSettings),
    resolveProviderCatalog: (providerId, revision) => guarded("provider catalog", () => deps.resolution.resolveProviderCatalog(providerId, revision)),
    getProviderCodingAdapter: deps.provider.getProviderCodingAdapter,
    resetProviderSessionThread: deps.provider.resetProviderSessionThread,
    getProviderAgentRuntimeBinding: deps.provider.getProviderAgentRuntimeBinding,
    beginProviderAgentRuntimeTurn: deps.provider.beginProviderAgentRuntimeTurn,
    endProviderAgentRuntimeTurn: deps.provider.endProviderAgentRuntimeTurn,
    createSessionTurn: (entry: CreateSessionTurnInput) => guarded("turn create", () => deps.turn.createSessionTurn(entry)),
    updateSessionTurn: (id, entry) => guarded("turn update", () => deps.turn.updateSessionTurn(id, entry)),
    setLiveSessionRun: (id, state) => { assertOwner("live session projection"); deps.live.setLiveSessionRun(id, state); },
    getLiveSessionRun: (id) => { assertOwner("live session read"); return deps.live.getLiveSessionRun(id); },
    waitForApprovalDecision: deps.interaction.waitForApprovalDecision,
    startWithMateApprovalReview: deps.interaction.startWithMateApprovalReview,
    waitForElicitationResponse: deps.interaction.waitForElicitationResponse,
    setProviderQuotaTelemetry: (telemetry) => { assertOwner("provider quota projection"); deps.live.setProviderQuotaTelemetry(telemetry); },
    setSessionContextTelemetry: (telemetry) => { assertOwner("session context projection"); deps.live.setSessionContextTelemetry(telemetry); },
    invalidateProviderSessionThread: (providerId, sessionId) => guarded("provider thread invalidation", () => deps.interaction.invalidateProviderSessionThread(providerId, sessionId)),
    scheduleProviderQuotaTelemetryRefresh: (id, delays) => { assertOwner("provider quota schedule"); deps.live.scheduleProviderQuotaTelemetryRefresh(id, delays); },
    broadcastLiveSessionRun: (id) => { assertOwner("live session broadcast"); deps.live.broadcastLiveSessionRun(id); },
    resolvePendingApprovalRequest: deps.interaction.resolvePendingApprovalRequest,
    resolvePendingElicitationRequest: deps.interaction.resolvePendingElicitationRequest,
    notifySessionTurnTerminal: deps.notification.notifySessionTurnTerminal,
    onSentInputChanged: (origin) => {
      if (deps.owner.isActive()) deps.notification.onSentInputChanged?.(origin);
    },
    onSessionRunReleased: (sessionId) => {
      if (deps.owner.isActive()) deps.notification.onSessionRunReleased?.(sessionId);
    },
    currentTimestampLabel: deps.timing.currentTimestampLabel,
  };
  return new SessionRuntimeService(assembled);
}
