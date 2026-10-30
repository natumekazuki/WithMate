import { AuxiliarySessionStorage, type AuxiliarySessionStorage as AuxiliarySessionStorageType } from "../auxiliary/auxiliary-session-storage.js";
import type { WorkerOptions } from "node:worker_threads";
import { SessionTurnStorageV6 } from "../session/session-turn-storage-v6.js";
import { SessionTurnQueueStorageV6 } from "../session/session-turn-queue-storage-v6.js";
import { SessionGraphStorageV6 } from "../session-graph/session-graph-storage-v6.js";
import type { SessionGraphOwner, SessionGraphIdentity } from "../../src-shared/session-graph/session-graph-contract.js";
import type { SessionGraphStorageOperation, SessionGraphStorageRequest, SessionGraphStorageResult } from "../../src-shared/session-graph/session-graph-ui-read-contract.js";
import { assertRuntimeTurnAdmission, currentRuntimeTurnAdmissionState, runWithRuntimeTurnAdmission } from "../platform/memory/runtime-turn-admission.js";
import { CharacterStorage } from "../character/character-storage.js";
import { AppSettingsStorage } from "../app/app-settings-storage.js";
import { MateStorage } from "../mate/mate-storage.js";
import { ModelCatalogStorage } from "../settings/model-catalog-storage.js";
import { PromptTemplateStorage } from "../prompt-templates/prompt-template-storage.js";
import { SessionStorageV6 } from "../session/session-storage-v6.js";
import { sessionSummariesToSessions } from "../session/session-summary-adapter.js";
import { ensureV6Schema, isValidV6Database } from "./database-schema-v6.js";
import { openAppDatabase, truncateAppDatabaseWalIfLargerThan } from "./sqlite-connection.js";
import { StorageWorkerClient } from "./storage-worker-client.js";
import type { StorageWorkerEntryData } from "./storage-worker-protocol.js";
import type { StorageOperationDiagnosticSink } from "./storage-operation-diagnostics.js";
import { ConversationQueryCoordinator } from "./conversation-query-coordinator.js";
import type { StorageWorkerHandlerContext } from "./storage-worker-dispatcher.js";
import type { ConversationSearchRequest, ConversationNavigatorRequest, ConversationSearchMatch, ConversationNavigatorEntry,
  ConversationQueryOutcome, ConversationQueryCancelRequest } from "../../src-shared/session/conversation-page.js";

export type ConversationQueryStore = {
  searchConversation(id: string, request: ConversationSearchRequest): Promise<ConversationQueryOutcome<ConversationSearchMatch>>;
  listConversationNavigator(id: string, request: ConversationNavigatorRequest): Promise<ConversationQueryOutcome<ConversationNavigatorEntry>>;
  cancelConversationQuery(request: ConversationQueryCancelRequest): Promise<void>;
};

type AnyMethod = (...args: any[]) => any;
type AsyncStore<T extends object> = {
  [K in keyof T as T[K] extends AnyMethod ? K : never]: T[K] extends (...args: infer A) => infer R
    ? (...args: A) => Promise<Awaited<R>>
    : never;
};

const STORE_METHODS = {
  sessionGraph: ["execute"],
  session: [
    "getSessionView", "getConversationPage", "searchConversation", "listConversationNavigator", "cancelConversationQuery",
    "listSessionFilePins", "pinSessionFile", "unpinSessionFile",
    "listSessions", "listSessionSummaries", "listSessionSummaryPage", "listSessionCharacterUsage",
    "getLatestSessionSummaryForProvider", "getSession", "getSessionSummary", "getSessionMetadata", "getSessionMessageIdentity", "setSessionPinned", "getSessionMessageArtifact",
    "listSessionIdsLastActiveBefore", "upsertSession", "updateSessionThreadIfMatches",
    "listSessionCredentialThreads", "setSessionTitle", "setSessionMessageBookmark", "setSessionExecutionOptions",
    "updateSessionRuntimeMetadataIfMatches", "updateSession", "upsertTerminalSession", "updateTerminalSession",
    "clearCharacterAuthoringRuntimeState", "appendRunningTurnStart", "appendSessionSteer", "appendSessionTerminal", "checkpointSessionRunMetadata", "insertSession", "replaceSessions",
    "deleteSession", "deleteSessions", "clearSessions",
  ],
  turn: ["createSessionTurn", "updateSessionTurn", "getLatestSessionTurn", "getConversationTimingSnapshot"],
  queue: ["enqueue", "getReceipt", "listActive", "listReceipts", "listPendingOwners", "claimNext", "claimForInput", "restoreQueuedInput", "markStarted", "settle", "cancelQueued", "reorderQueued", "recoverInterrupted", "releaseInterrupted"],
  auxiliary: [
    "getAuxiliarySessionView", "getConversationPage", "searchConversation", "listConversationNavigator", "cancelConversationQuery",
    "listAllAuxiliarySessions", "listAuxiliarySessions", "listAuxiliarySessionSummaries",
    "listActiveAuxiliarySessionSummaries", "listRunningActiveAuxiliarySessions", "getActiveAuxiliarySession",
    "getAuxiliarySession", "getAuxiliarySessionSummary", "getAuxiliarySessionMetadata", "listAuxiliaryCredentialThreads", "getAuxiliaryMessageArtifactDetail",
    "appendAuxiliaryRunningTurnStart", "appendAuxiliarySteer", "appendAuxiliaryTerminal", "checkpointAuxiliaryRuntimeMetadata",
    "updateAuxiliarySessionThreadIfMatches", "updateAuxiliarySessionRuntimeMetadataIfMatches",
    "updateAuxiliarySessionIfMatches", "updateTerminalAuxiliarySessionIfMatches", "upsertAuxiliarySession", "deleteAuxiliarySessionsForParent", "deleteAuxiliarySessionsExceptParents",
    "updateAuxiliaryTitleIfMatches", "updateAuxiliaryMessageBookmarkIfMatches", "updateAuxiliaryExecutionOptionsIfMatches",
    "updateAuxiliaryDisplayAnchorIfMatches",
    "getAuxiliaryDraft", "saveAuxiliaryDraft", "consumeAuxiliaryDraft",
    "getAuxiliarySessionStatus",
  ],
  character: [
    "getCharacterDirectory", "listCharacters", "getCharacterCatalogEntry", "getCharacter", "createCharacter",
    "updateCharacterMetadata", "updateCharacterDefinition", "archiveCharacter", "resolveLaunchCharacter",
    "createRuntimeSnapshot", "refreshRuntimeSnapshot", "deleteCharacterRootDirectory",
  ],
  settings: ["getSettings", "updateSettings", "updateChatLayoutPreference", "resetSettings"],
  catalog: ["getCachedProviders", "getCatalog", "upsertProvider", "clear"],
  mate: [
    "initializeSchema", "getMateState", "getUserDataPath", "getMateProfile", "verifyMateProfileFiles",
    "getMateGrowthSettings", "updateMateGrowthApplyIntervalMinutes", "updateMateGrowthSettings", "createMate",
    "updateMate", "setMateAvatar", "recoverMateProfileFilesFromActiveRevision", "resetMate", "deleteMateProjectionDirectory",
    "applyProfileFiles",
  ],
  prompt: ["listPromptTemplates", "createPromptTemplate", "updatePromptTemplate", "deletePromptTemplate"],
} as const;

const MUTATIONS = new Set([
  "reorderQueued",
  "claimNext", "claimForInput", "restoreQueuedInput", "markStarted", "settle", "cancelQueued", "recoverInterrupted", "releaseInterrupted",
  "pinSessionFile", "unpinSessionFile",
  "setSessionTitle", "setSessionMessageBookmark", "setSessionExecutionOptions",
  "setSessionPinned", "upsertSession", "updateSessionThreadIfMatches", "updateSessionRuntimeMetadataIfMatches", "updateSession",
  "upsertTerminalSession", "updateTerminalSession", "clearCharacterAuthoringRuntimeState", "appendRunningTurnStart", "appendSessionSteer", "appendSessionTerminal", "checkpointSessionRunMetadata", "insertSession",
  "appendAuxiliaryRunningTurnStart", "appendAuxiliarySteer", "appendAuxiliaryTerminal", "checkpointAuxiliaryRuntimeMetadata",
  "replaceSessions", "deleteSession", "deleteSessions", "clearSessions", "createSessionTurn", "updateSessionTurn",
  "updateAuxiliarySessionThreadIfMatches", "updateAuxiliarySessionRuntimeMetadataIfMatches", "updateAuxiliarySessionIfMatches", "updateTerminalAuxiliarySessionIfMatches", "upsertAuxiliarySession", "deleteAuxiliarySessionsForParent",
  "deleteAuxiliarySessionsExceptParents", "saveAuxiliaryDraft", "consumeAuxiliaryDraft",
  "updateAuxiliaryTitleIfMatches", "updateAuxiliaryMessageBookmarkIfMatches", "updateAuxiliaryExecutionOptionsIfMatches", "updateAuxiliaryDisplayAnchorIfMatches",
  "createCharacter", "updateCharacterMetadata", "updateCharacterDefinition", "archiveCharacter",
  "deleteCharacterRootDirectory", "updateSettings", "updateChatLayoutPreference", "resetSettings", "upsertProvider", "clear",
  "initializeSchema", "recoverMateProfileFilesFromActiveRevision",
  "updateMateGrowthApplyIntervalMinutes", "updateMateGrowthSettings", "createMate", "updateMate", "setMateAvatar", "resetMate",
  "deleteMateProjectionDirectory", "applyProfileFiles", "createPromptTemplate", "updatePromptTemplate", "deletePromptTemplate",
  "enqueue",
]);

type StorageInstances = Record<keyof typeof STORE_METHODS, object>;

let instances: StorageInstances | null = null;
let conversationQueries: ConversationQueryCoordinator | null = null;

function createStoreHandlers(data: StorageWorkerEntryData) {
  if (!data.dbPath || !data.userDataPath) {
    throw new Error("V6 storage worker requires dbPath and userDataPath.");
  }
  const dbPath = data.dbPath;
  const schemaDb = openAppDatabase(dbPath);
  try {
    ensureV6Schema(schemaDb);
  } finally {
    schemaDb.close();
  }
  if (!isValidV6Database(dbPath)) {
    throw new Error("V6 storage worker database schema validation failed.");
  }
  const changed: import("./conversation-query.js").ConversationMutationSink = (table, id) => conversationQueries?.invalidate(table, id);
  const session = new SessionStorageV6(data.dbPath, changed);
  const turn = new SessionTurnStorageV6(data.dbPath);
  const queue = new SessionTurnQueueStorageV6(data.dbPath);
  const sessionGraph = new SessionGraphStorageV6(data.dbPath);
  const auxiliary = new AuxiliarySessionStorage(data.dbPath, changed);
  conversationQueries = new ConversationQueryCoordinator(data.generationId, { session_messages_v6: session, auxiliary_session_messages: auxiliary });
  const queries = conversationQueries;
  const character = new CharacterStorage(data.dbPath, data.userDataPath);
  const settings = new AppSettingsStorage(data.dbPath);
  const catalog = new ModelCatalogStorage(data.dbPath);
  const mate = new MateStorage(data.dbPath, data.userDataPath);
  const prompt = new PromptTemplateStorage(data.dbPath);
  instances = { session, turn, queue, sessionGraph, auxiliary, character, settings, catalog, mate, prompt };
  const currentInstances = instances;

  return {
    "conversation.query": (payload: unknown, context: StorageWorkerHandlerContext) => {
      const input = payload as { store?: string; method?: string; args?: unknown[] };
      if (!input || (input.store !== "session" && input.store !== "auxiliary") || !Array.isArray(input.args)
        || typeof input.args[0] !== "string" || (input.method !== "searchConversation" && input.method !== "listConversationNavigator")) throw new TypeError("Conversation query command is invalid.");
      return queries.request(input.store === "session" ? "session_messages_v6" : "auxiliary_session_messages", input.args[0],
        input.args[1] as ConversationSearchRequest | ConversationNavigatorRequest, input.method === "searchConversation" ? "search" : "navigator", context.scheduleDb);
    },
    "conversation.cancel": (payload: unknown) => queries.cancel(payload as ConversationQueryCancelRequest),
    "bundle.initialize": async () => ({
      activeModelCatalog: catalog.getCatalog(),
      sessions: sessionSummariesToSessions(await session.listSessionSummaries()),
    }),
    "maintenance.truncateWal": (payload: unknown) => {
      const maxWalBytes = payload && typeof payload === "object" && typeof (payload as { maxWalBytes?: unknown }).maxWalBytes === "number"
        ? (payload as { maxWalBytes: number }).maxWalBytes
        : undefined;
      return truncateAppDatabaseWalIfLargerThan(dbPath, maxWalBytes);
    },
    "store.call": (payload: unknown) => {
      if (!payload || typeof payload !== "object") throw new Error("Storage worker payload is invalid.");
      const input = payload as { store?: string; method?: string; args?: unknown[]; runtimeTurnAdmissionState?: SharedArrayBuffer };
      if (!(input.store && input.method && Array.isArray(input.args)) || !Object.prototype.hasOwnProperty.call(STORE_METHODS, input.store)) {
        throw new Error("Storage worker store command is invalid.");
      }
      const methods = STORE_METHODS[input.store as keyof typeof STORE_METHODS] as readonly string[];
      if (!methods.includes(input.method)) throw new Error(`Storage worker method is not allowed: ${input.store}.${input.method}`);
      if (["searchConversation", "listConversationNavigator", "cancelConversationQuery"].includes(input.method)) throw new Error("Conversation queries require their isolated command.");
      const store = currentInstances[input.store as keyof StorageInstances] as Record<string, AnyMethod>;
      const method = store[input.method];
      if (typeof method !== "function") throw new Error(`Storage worker method is unavailable: ${input.store}.${input.method}`);
      if (input.store === "sessionGraph" && input.runtimeTurnAdmissionState !== undefined) {
        if (!(input.runtimeTurnAdmissionState instanceof SharedArrayBuffer) || input.runtimeTurnAdmissionState.byteLength !== Int32Array.BYTES_PER_ELEMENT) throw new Error("Session Graph turn admission state is invalid.");
        return runWithRuntimeTurnAdmission({ state: input.runtimeTurnAdmissionState }, () => method.apply(store, input.args!));
      }
      return method.apply(store, input.args);
    },
  };
}

export async function createStorageWorkerCommandHandlers(data: StorageWorkerEntryData) {
  return createStoreHandlers(data);
}

export async function closeStorageWorker(): Promise<void> {
  await stopStorageConversationQueries();
  for (const store of Object.values(instances ?? {})) {
    (store as { close?: () => void }).close?.();
  }
  instances = null;
}

export async function stopStorageConversationQueries(): Promise<void> {
  await conversationQueries?.close();
  conversationQueries = null;
}

export function createV6StorageWorkerBundle(options: {
  dbPath: string;
  userDataPath: string;
  workerUrl?: URL | string;
  handlerModule?: URL | string;
  workerOptions?: Omit<WorkerOptions, "workerData">;
  diagnosticSink?: StorageOperationDiagnosticSink;
}): V6StorageWorkerBundle {
  const sourceTypeScript = import.meta.url.endsWith(".ts");
  const workerUrl = options.workerUrl ?? new URL(sourceTypeScript ? "./storage-worker-entry.ts" : "./storage-worker-entry.js", import.meta.url);
  const handlerModule = options.handlerModule
    ? String(options.handlerModule)
    : new URL(sourceTypeScript ? "./storage-worker-bundle.ts" : "./storage-worker-bundle.js", import.meta.url).href;
  const workerOptions = options.workerOptions ?? (sourceTypeScript ? { execArgv: ["--import", "tsx"] } : undefined);
  const client = new StorageWorkerClient(workerUrl, {
    ...workerOptions,
    ...(options.diagnosticSink ? { diagnosticSink: options.diagnosticSink } : {}),
    workerData: {
      handlerModule,
      dbPath: options.dbPath,
      userDataPath: options.userDataPath,
    },
  });
  const stores = Object.fromEntries(Object.entries(STORE_METHODS).map(([store, methods]) => [
    store,
    new Proxy({}, {
      get: (_target, property: string) => {
        if (!methods.includes(property as never)) return undefined;
        return (...args: unknown[]) => {
          const graphMutation = store === "sessionGraph" && args[1] === "apply";
          if (graphMutation) assertRuntimeTurnAdmission();
          const runtimeTurnAdmissionState = graphMutation ? currentRuntimeTurnAdmissionState() : undefined;
          return client.call(property === "cancelConversationQuery" ? "conversation.cancel"
            : property === "searchConversation" || property === "listConversationNavigator" ? "conversation.query" : "store.call",
            property === "cancelConversationQuery" ? args[0] : { store, method: property, args, ...(runtimeTurnAdmissionState ? { runtimeTurnAdmissionState } : {}) }, {
            mutation: store === "sessionGraph" ? args[1] === "apply" : MUTATIONS.has(property),
            operation: `${store}.${property}`,
          });
        };
      },
    }),
  ])) as V6StorageWorkerBundle["stores"];
  return {
    client,
    stores,
    initialize: () => client.call("bundle.initialize", null, { mutation: true, operation: "bundle.initialize" }),
    truncateWal: () => client.call<boolean>("maintenance.truncateWal", null, { mutation: true, operation: "maintenance.truncateWal" }),
  };
}

export type V6StorageWorkerBundle = {
  client: StorageWorkerClient;
  initialize(): Promise<unknown>;
  truncateWal(): Promise<boolean>;
  stores: {
    sessionGraph: {
      execute<K extends SessionGraphStorageOperation>(owner: SessionGraphOwner, operation: K, request: SessionGraphStorageRequest<K>, identity?: SessionGraphIdentity, actorSnapshots?: SessionGraphIdentity[]): Promise<SessionGraphStorageResult<K>>;
    };
    session: AsyncStore<Omit<SessionStorageV6, "getConversationQuerySnapshot" | "readConversationQueryBatch">> & ConversationQueryStore;
    turn: AsyncStore<SessionTurnStorageV6>;
    queue: AsyncStore<SessionTurnQueueStorageV6>;
    auxiliary: AsyncStore<Omit<AuxiliarySessionStorageType, "getConversationQuerySnapshot" | "readConversationQueryBatch">> & ConversationQueryStore;
    character: AsyncStore<CharacterStorage>;
    settings: AsyncStore<AppSettingsStorage>;
    catalog: AsyncStore<ModelCatalogStorage>;
    mate: AsyncStore<MateStorage>;
    prompt: AsyncStore<PromptTemplateStorage>;
  };
};
