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
  };
  runtime: Pick<SessionPersistenceServiceDeps, "isSessionRunInFlight" | "listRunningActiveAuxiliaryParentIds">;
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
    runCharacterAffectTurnOwnershipExclusive: NonNullable<SessionPersistenceServiceDeps["runCharacterAffectTurnOwnershipExclusive"]>;
  };
};

export function createSessionPersistenceAssembly(deps: SessionPersistenceAssemblyDeps): SessionPersistenceService {
  const assertOwner = (operation: string) => deps.owner.assertActive(`Session persistence ${operation}`);
  const storageCommands = createSessionStorageCommandAdapter(() => {
    assertOwner("storage command");
    return deps.storage;
  });

  const assembled: SessionPersistenceServiceDeps = {
    getSessions: () => { assertOwner("cache read"); return deps.cache.getSessions(); },
    setSessions: (nextSessions) => { assertOwner("cache write"); deps.cache.setSessions(nextSessions); },
    getSession: (sessionId) => { assertOwner("session read"); return deps.cache.getSession(sessionId); },
    getStoredSession: async (sessionId) => {
      assertOwner("stored session read");
      const stored = await deps.storage.getSession(sessionId);
      assertOwner("stored session read");
      return stored;
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
    updateStoredSessionThreadIfMatches: async (input) => {
      assertOwner("thread update");
      if (!deps.storage.updateSessionThreadIfMatches) throw new Error("Session thread の条件付き更新storageが利用できないよ。");
      const stored = await deps.storage.updateSessionThreadIfMatches(input);
      assertOwner("thread update");
      return stored;
    },
    updateStoredSessionRuntimeMetadataIfMatches: async (input) => {
      assertOwner("runtime metadata update");
      if (!deps.storage.updateSessionRuntimeMetadataIfMatches) throw new Error("Session runtime metadata の条件付き更新storageが利用できません。");
      const stored = await deps.storage.updateSessionRuntimeMetadataIfMatches(input);
      assertOwner("runtime metadata update");
      return stored;
    },
    appendStoredRunningTurnStart: async (input) => {
      assertOwner("running turn start");
      if (!deps.storage.appendRunningTurnStart) throw new Error("running turn 開始のincremental storageが利用できないよ。");
      const result = await deps.storage.appendRunningTurnStart(input);
      assertOwner("running turn start");
      return result;
    },
    clearStoredCharacterAuthoringRuntimeState: async (input) => {
      assertOwner("Character authoring runtime clear");
      if (!deps.storage.clearCharacterAuthoringRuntimeState) throw new Error("Character authoring runtime clearのstorageが利用できないよ。");
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
      if (typeof deps.pinStorage.setSessionPinned !== "function") throw new Error("このセッション保存形式ではピン止めを利用できないよ。");
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
    getAppSettings: async () => { assertOwner("settings read"); const result = await deps.settings.getAppSettings(); assertOwner("settings read"); return result; },
    getModelCatalogSnapshot: async () => { assertOwner("catalog read"); const result = await deps.settings.getModelCatalogSnapshot(); assertOwner("catalog read"); return result; },
    createCharacterRuntimeSnapshot: async (characterId) => { assertOwner("character snapshot"); const result = await deps.character.createCharacterRuntimeSnapshot(characterId); assertOwner("character snapshot"); return result; },
    syncSessionDependencies: (session) => { assertOwner("session dependency sync"); deps.effects.syncSessionDependencies(session); },
    clearSessionContextTelemetry: (sessionId) => { assertOwner("context telemetry clear"); deps.effects.clearSessionContextTelemetry(sessionId); },
    clearSessionBackgroundActivities: (sessionId) => { assertOwner("background activity clear"); deps.effects.clearSessionBackgroundActivities(sessionId); },
    invalidateProviderSessionThread: async (providerId, sessionId) => { assertOwner("provider thread invalidation"); await deps.effects.invalidateProviderSessionThread(providerId, sessionId); assertOwner("provider thread invalidation"); },
    revokeSessionAgentRuntimeBindings: (sessionId) => { assertOwner("agent runtime revoke"); deps.effects.revokeSessionAgentRuntimeBindings(sessionId); },
    closeSessionWindow: (sessionId) => { assertOwner("session window close"); deps.effects.closeSessionWindow(sessionId); },
    discardSessionWindow: (sessionId) => { assertOwner("session window discard"); deps.effects.discardSessionWindow(sessionId); },
    upsertStoredTerminalSession: storageCommands.upsertStoredTerminalSession,
    broadcastSessions: (sessionIds) => { assertOwner("broadcast"); deps.effects.broadcastSessions(sessionIds); },
    runCharacterAffectTurnOwnershipExclusive: (operation) => deps.effects.runCharacterAffectTurnOwnershipExclusive(async () => { assertOwner("Character affect ownership"); const result = await operation(); assertOwner("Character affect ownership"); return result; }),
  };
  return new SessionPersistenceService(assembled);
}
