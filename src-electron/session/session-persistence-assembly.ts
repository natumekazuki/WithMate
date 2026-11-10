import { SessionPersistenceService, type SessionPersistenceServiceDeps } from "./session-persistence-service.js";
import { createSessionStorageCommandAdapter } from "./session-storage-command-adapter.js";
import type { SessionStorageWrite, SessionPinStorage } from "../storage/persistent-store-lifecycle-service.js";

export type SessionPersistenceAssemblyDeps = {
  owner: { assertActive(operation: string): void };
  storage: SessionStorageWrite;
  pinStorage: SessionPinStorage;
  cache: {
    getSessions(): Parameters<SessionPersistenceServiceDeps["setSessions"]>[0];
    setSessions(nextSessions: Parameters<SessionPersistenceServiceDeps["setSessions"]>[0]): void;
    getSession: SessionPersistenceServiceDeps["getSession"];
    overlayCurrentExecutionOptions?: NonNullable<SessionPersistenceServiceDeps["overlayCurrentExecutionOptions"]>;
    rememberExecutionOptions?: NonNullable<SessionPersistenceServiceDeps["rememberExecutionOptions"]>;
  };
  runtime: Pick<SessionPersistenceServiceDeps, "isSessionRunInFlight" | "listRunningActiveAuxiliaryParentIds" | "runProviderRuntimeOperationExclusive">;
  auxiliary: {
    listAuxiliarySessionRuntimeIdentities(parentSessionId: string): ReturnType<NonNullable<SessionPersistenceServiceDeps["listAuxiliarySessionRuntimeIdentities"]>>;
  };
  settings: Pick<SessionPersistenceServiceDeps, "getAppSettings" | "getModelCatalogSnapshot">;
  character: {
    createCharacterRuntimeSnapshot(characterId: string): ReturnType<NonNullable<SessionPersistenceServiceDeps["createCharacterRuntimeSnapshot"]>>;
  };
  effects: {
    syncSessionDependencies: SessionPersistenceServiceDeps["syncSessionDependencies"];
    clearSessionContextTelemetry: SessionPersistenceServiceDeps["clearSessionContextTelemetry"];
    clearSessionBackgroundActivities: SessionPersistenceServiceDeps["clearSessionBackgroundActivities"];
    invalidateProviderSessionThread: SessionPersistenceServiceDeps["invalidateProviderSessionThread"];
    revokeSessionAgentRuntimeBindings(sessionId: string): void;
    closeSessionWindow: SessionPersistenceServiceDeps["closeSessionWindow"];
    discardSessionWindow: NonNullable<SessionPersistenceServiceDeps["discardSessionWindow"]>;
    broadcastSessions: SessionPersistenceServiceDeps["broadcastSessions"];
  };
};

export function createSessionPersistenceAssembly(deps: SessionPersistenceAssemblyDeps): SessionPersistenceService {
  const assertOwner = (operation: string) => deps.owner.assertActive(`Session persistence ${operation}`);
  const storageCommands = createSessionStorageCommandAdapter(() => {
    assertOwner("storage command");
    return deps.storage;
  });

  const assembled: SessionPersistenceServiceDeps = {
    runProviderRuntimeOperationExclusive: deps.runtime.runProviderRuntimeOperationExclusive
      ? (operation) => deps.runtime.runProviderRuntimeOperationExclusive!(async () => {
        assertOwner("provider runtime operation");
        const result = await operation();
        assertOwner("provider runtime operation");
        return result;
      })
      : undefined,
    getSessions: () => { assertOwner("cache read"); return deps.cache.getSessions(); },
    setSessions: (nextSessions) => { assertOwner("cache write"); deps.cache.setSessions(nextSessions); },
    getSession: (sessionId) => { assertOwner("session read"); return deps.cache.getSession(sessionId); },
    overlayCurrentExecutionOptions: (session) => { assertOwner("selection overlay"); return deps.cache.overlayCurrentExecutionOptions?.(session) ?? session; },
    rememberExecutionOptions: (session, options) => { assertOwner("selection remember"); deps.cache.rememberExecutionOptions?.(session, options); },
    getStoredSession: async (sessionId) => {
      assertOwner("stored session read");
      const stored = await deps.storage.getSession(sessionId);
      assertOwner("stored session read");
      return stored;
    },
    getStoredSessionSummary: async (sessionId) => {
      assertOwner("stored Session summary read");
      if (!deps.storage.getSessionSummary) throw new Error("Session summary storage is unavailable.");
      const result = await deps.storage.getSessionSummary(sessionId);
      assertOwner("stored Session summary read");
      return result;
    },
    isSessionRunInFlight: deps.runtime.isSessionRunInFlight,
    listRunningActiveAuxiliaryParentIds: deps.runtime.listRunningActiveAuxiliaryParentIds,
    listAuxiliarySessionRuntimeIdentities: async (parentSessionIds) => (await Promise.all(parentSessionIds.map(async (parentSessionId) => {
      assertOwner("Auxiliary identity read");
      const identities = await deps.auxiliary.listAuxiliarySessionRuntimeIdentities(parentSessionId);
      assertOwner("Auxiliary identity read");
      return identities;
    }))).flat(),
    upsertStoredSession: storageCommands.upsertStoredSession,
    setStoredSessionAdditionalDirectories: (sessionId, incarnationId, directories) => {
      assertOwner("additional directory update");
      if (!deps.storage.setSessionAdditionalDirectories) throw new Error("Session additional directory storage is unavailable.");
      return deps.storage.setSessionAdditionalDirectories(sessionId, incarnationId, directories);
    },
    appendStoredSessionSteer: (input) => {
      assertOwner("Session steer append");
      if (!deps.storage.appendSessionSteer) throw new Error("Incremental Session input storage is unavailable.");
      return deps.storage.appendSessionSteer(input);
    },
    beginStoredSessionSteer: (input) => {
      assertOwner("Session steer begin");
      if (!deps.storage.beginSessionSteer) throw new Error("Durable Session input storage is unavailable.");
      return deps.storage.beginSessionSteer(input);
    },
    settleStoredSessionSteer: (input) => {
      assertOwner("Session steer settle");
      if (!deps.storage.settleSessionSteer) throw new Error("Durable Session input storage is unavailable.");
      return deps.storage.settleSessionSteer(input);
    },
    appendStoredSessionTerminal: (input) => {
      assertOwner("Session terminal append");
      if (!deps.storage.appendSessionTerminal) throw new Error("Incremental terminal Session storage is unavailable.");
      return deps.storage.appendSessionTerminal(input);
    },
    checkpointStoredSessionRunMetadata: (input) => {
      assertOwner("Session runtime checkpoint");
      if (!deps.storage.checkpointSessionRunMetadata) throw new Error("Session runtime checkpoint storage is unavailable.");
      return deps.storage.checkpointSessionRunMetadata(input);
    },
    setStoredSessionTitle: async (sessionId, incarnationId, title) => {
      assertOwner("title update");
      if (!deps.storage.setSessionTitle) throw new Error("Session title storage is unavailable.");
      await deps.storage.setSessionTitle(sessionId, incarnationId, title);
    },
    patchStoredSessionMetadata: async (sessionId, incarnationId, patch) => {
      assertOwner("metadata update");
      if (!deps.storage.patchSessionMetadata) throw new Error("Session metadata storage is unavailable.");
      const result = await deps.storage.patchSessionMetadata(sessionId, incarnationId, patch);
      assertOwner("metadata update");
      return result;
    },
    promoteStoredSessionToOverallCoordinator: async (sessionId, incarnationId) => {
      assertOwner("Role update");
      if (!deps.storage.promoteSessionToOverallCoordinator) throw new Error("Session Role storage is unavailable.");
      const result = await deps.storage.promoteSessionToOverallCoordinator(sessionId, incarnationId);
      assertOwner("Role update");
      return result;
    },
    setStoredSessionMessageBookmark: async (sessionId, incarnationId, messageIndex, isBookmarked) => {
      assertOwner("bookmark update");
      if (!deps.storage.setSessionMessageBookmark) throw new Error("Session bookmark storage is unavailable.");
      await deps.storage.setSessionMessageBookmark(sessionId, incarnationId, messageIndex, isBookmarked);
      assertOwner("bookmark update");
    },
    setStoredSessionExecutionOptions: async (sessionId, incarnationId, options) => {
      assertOwner("execution options update");
      if (!deps.storage.setSessionExecutionOptions) throw new Error("Session execution option storage is unavailable.");
      await deps.storage.setSessionExecutionOptions(sessionId, incarnationId, options);
      assertOwner("execution options update");
    },
    updateStoredSessionThreadIfMatches: async (input) => {
      assertOwner("thread update");
      if (!deps.storage.updateSessionThreadIfMatches) throw new Error("Conditional Session thread update storage is unavailable.");
      const stored = await deps.storage.updateSessionThreadIfMatches(input);
      assertOwner("thread update");
      return stored;
    },
    updateStoredSessionRuntimeMetadataIfMatches: async (input) => {
      assertOwner("runtime metadata update");
      if (!deps.storage.updateSessionRuntimeMetadataIfMatches) throw new Error("Conditional Session runtime metadata update storage is unavailable.");
      const stored = await deps.storage.updateSessionRuntimeMetadataIfMatches(input);
      assertOwner("runtime metadata update");
      return stored;
    },
    appendStoredRunningTurnStart: async (input) => {
      assertOwner("running turn start");
      if (!deps.storage.appendRunningTurnStart) throw new Error("Incremental storage for starting a running turn is unavailable.");
      const result = await deps.storage.appendRunningTurnStart(input);
      assertOwner("running turn start");
      return result;
    },
    clearStoredCharacterAuthoringRuntimeState: async (input) => {
      assertOwner("Character authoring runtime clear");
      if (!deps.storage.clearCharacterAuthoringRuntimeState) throw new Error("Storage for clearing Character authoring runtime state is unavailable.");
      const result = await deps.storage.clearCharacterAuthoringRuntimeState(input);
      assertOwner("Character authoring runtime clear");
      return result;
    },
    replaceStoredSessions: async (nextSessions) => {
      assertOwner("session replacement");
      await deps.storage.replaceSessions(nextSessions);
      assertOwner("session replacement");
    },
    setStoredSessionPinned: async (sessionId, isPinned) => {
      assertOwner("session pin update");
      if (typeof deps.pinStorage.setSessionPinned !== "function") throw new Error("Session pinning is unavailable for this storage format.");
      const result = await deps.pinStorage.setSessionPinned(sessionId, isPinned);
      assertOwner("session pin update");
      return result;
    },
    listStoredSessions: async () => {
      assertOwner("session list");
      const result = await deps.storage.listSessions();
      assertOwner("session list");
      return result;
    },
    listStoredSessionSummaries: async () => {
      assertOwner("Session summaries");
      const result = await deps.storage.listSessionSummaries();
      assertOwner("Session summaries");
      return result;
    },
    getSessionLifecycleOperation: async (operationId) => {
      assertOwner("lifecycle read");
      if (!deps.storage.getSessionLifecycleOperation) throw new Error("Session lifecycle storage is unavailable.");
      const result = await deps.storage.getSessionLifecycleOperation(operationId);
      assertOwner("lifecycle read");
      return result;
    },
    listPendingSessionLifecycleOperations: async () => {
      assertOwner("lifecycle list");
      if (!deps.storage.listPendingSessionLifecycleOperations) throw new Error("Session lifecycle storage is unavailable.");
      const result = await deps.storage.listPendingSessionLifecycleOperations();
      assertOwner("lifecycle list");
      return result;
    },
    beginSessionLifecycleOperation: async (input) => {
      assertOwner("lifecycle begin");
      if (!deps.storage.beginSessionLifecycleOperation) throw new Error("Session lifecycle storage is unavailable.");
      const result = await deps.storage.beginSessionLifecycleOperation(input);
      assertOwner("lifecycle begin");
      return result;
    },
    advanceSessionLifecycleOperation: async (operationId, phase, resources) => {
      assertOwner("lifecycle advance");
      if (!deps.storage.advanceSessionLifecycleOperation) throw new Error("Session lifecycle storage is unavailable.");
      const result = await deps.storage.advanceSessionLifecycleOperation(operationId, phase, resources);
      assertOwner("lifecycle advance");
      return result;
    },
    deleteSessionCrewForLifecycle: async (operationId) => {
      assertOwner("Crew lifecycle deletion");
      if (!deps.storage.deleteSessionCrewForLifecycle) throw new Error("Crew lifecycle deletion storage is unavailable.");
      const result = await deps.storage.deleteSessionCrewForLifecycle(operationId);
      assertOwner("Crew lifecycle deletion");
      return result;
    },
    listStoredSessionIdsLastActiveBefore: async (cutoff) => {
      assertOwner("session cutoff list");
      const result = await deps.storage.listSessionIdsLastActiveBefore(cutoff);
      assertOwner("session cutoff list");
      return result;
    },
    deleteStoredSessions: async (sessionIds) => {
      assertOwner("session deletion");
      await deps.storage.deleteSessions(sessionIds);
      assertOwner("session deletion");
    },
    getStoredCrewDeletionStatus: async (sessionId, incarnationId) => {
      assertOwner("Crew deletion status");
      if (!deps.storage.getCrewDeletionStatus) throw new Error("Crew deletion status storage is unavailable.");
      const result = await deps.storage.getCrewDeletionStatus(sessionId, incarnationId);
      assertOwner("Crew deletion status");
      return result;
    },
    prepareSessionLifecycleCreation: async (operationId, input) => {
      assertOwner("Session lifecycle preparation");
      if (!deps.storage.prepareSessionLifecycleCreation) throw new Error("Session lifecycle preparation storage is unavailable.");
      const result = await deps.storage.prepareSessionLifecycleCreation(operationId, input);
      assertOwner("Session lifecycle preparation");
      return result;
    },
    getAppSettings: async () => { assertOwner("settings read"); const result = await deps.settings.getAppSettings(); assertOwner("settings read"); return result; },
    getModelCatalogSnapshot: async (workspacePath, providerId) => { assertOwner("catalog read"); const result = await deps.settings.getModelCatalogSnapshot(workspacePath, providerId); assertOwner("catalog read"); return result; },
    createCharacterRuntimeSnapshot: async (characterId) => { assertOwner("character snapshot"); const result = await deps.character.createCharacterRuntimeSnapshot(characterId); assertOwner("character snapshot"); return result; },
    syncSessionDependencies: (session) => { assertOwner("session dependency sync"); deps.effects.syncSessionDependencies(session); },
    clearSessionContextTelemetry: (sessionId) => { assertOwner("context telemetry clear"); deps.effects.clearSessionContextTelemetry(sessionId); },
    clearSessionBackgroundActivities: (sessionId) => { assertOwner("background activity clear"); deps.effects.clearSessionBackgroundActivities(sessionId); },
    invalidateProviderSessionThread: async (providerId, sessionId) => { assertOwner("provider thread invalidation"); await deps.effects.invalidateProviderSessionThread(providerId, sessionId); assertOwner("provider thread invalidation"); },
    revokeSessionAgentRuntimeBindings: (sessionId) => { assertOwner("agent runtime revoke"); deps.effects.revokeSessionAgentRuntimeBindings(sessionId); },
    closeSessionWindow: (sessionId) => { assertOwner("session window close"); deps.effects.closeSessionWindow(sessionId); },
    discardSessionWindow: (sessionId) => { assertOwner("session window discard"); deps.effects.discardSessionWindow(sessionId); },
    upsertStoredTerminalSession: storageCommands.upsertStoredTerminalSession,
    broadcastSessions: (sessionIds, detailChanged) => { assertOwner("broadcast"); deps.effects.broadcastSessions(sessionIds, detailChanged); },
  };
  return new SessionPersistenceService(assembled);
}
