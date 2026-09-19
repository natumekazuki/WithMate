import { AuxiliarySessionStorage, type AuxiliarySessionStorage as AuxiliarySessionStorageType } from "./auxiliary-session-storage.js";
import type { WorkerOptions } from "node:worker_threads";
import { AuditLogStorageV6 } from "./audit-log-storage-v6.js";
import { CharacterAffectTurnSettlementStorage } from "./character-affect-turn-settlement-storage.js";
import { CharacterStorage } from "./character-storage.js";
import { CompanionStorage } from "./companion-storage.js";
import { AppSettingsStorage } from "./app-settings-storage.js";
import { MateStorage } from "./mate-storage.js";
import { ModelCatalogStorage } from "./model-catalog-storage.js";
import { PromptTemplateStorage } from "./prompt-template-storage.js";
import { SessionStorageV6 } from "./session-storage-v6.js";
import { sessionSummariesToSessions } from "./session-summary-adapter.js";
import { ensureV6Schema, isValidV6Database } from "./database-schema-v6.js";
import { openAppDatabase, truncateAppDatabaseWalIfLargerThan } from "./sqlite-connection.js";
import { StorageWorkerClient } from "./storage-worker-client.js";
import type { StorageWorkerEntryData } from "./storage-worker-protocol.js";
import type { StorageOperationDiagnosticSink } from "./storage-operation-diagnostics.js";

type AnyMethod = (...args: any[]) => any;
type AsyncStore<T extends object> = {
  [K in keyof T as T[K] extends AnyMethod ? K : never]: T[K] extends (...args: infer A) => infer R
    ? (...args: A) => Promise<Awaited<R>>
    : never;
};

const STORE_METHODS = {
  session: [
    "listSessions", "listSessionSummaries", "listSessionSummaryPage", "listSessionCharacterUsage",
    "getLatestSessionSummaryForProvider", "getSession", "setSessionPinned", "getSessionMessageArtifact",
    "listSessionIdsLastActiveBefore", "upsertSession", "updateSessionThreadIfMatches",
    "updateSessionRuntimeMetadataIfMatches", "updateSession", "upsertTerminalSession", "updateTerminalSession",
    "clearCharacterAuthoringRuntimeState", "appendRunningTurnStart", "insertSession", "replaceSessions",
    "deleteSession", "deleteSessions", "clearSessions",
  ],
  audit: [
    "createAuditLog", "updateAuditLog", "listSessionAuditLogs", "getConversationTimingSnapshot",
    "listSessionAuditLogSummaries", "listSessionAuditLogSummaryPage", "getSessionAuditLogDetail",
    "getSessionAuditLogDetailSection", "getSessionAuditLogOperationDetail", "clearAuditLogs",
  ],
  auxiliary: [
    "listAllAuxiliarySessions", "listAuxiliarySessions", "listAuxiliarySessionSummaries",
    "listActiveAuxiliarySessionSummaries", "listRunningActiveAuxiliarySessions", "getActiveAuxiliarySession",
    "getAuxiliarySession", "updateAuxiliarySessionThreadIfMatches", "updateAuxiliarySessionRuntimeMetadataIfMatches",
    "updateAuxiliarySessionIfMatches", "upsertAuxiliarySession", "backfillAuxiliarySessionSummaries", "deleteAuxiliarySessionsForParent", "deleteAuxiliarySessionsExceptParents",
  ],
  character: [
    "getCharacterDirectory", "listCharacters", "getCharacterCatalogEntry", "getCharacter", "createCharacter",
    "updateCharacterMetadata", "updateCharacterDefinition", "archiveCharacter", "resolveLaunchCharacter",
    "createRuntimeSnapshot", "deleteCharacterRootDirectory",
  ],
  settings: ["getSettings", "updateSettings", "updateChatLayoutPreference", "resetSettings"],
  catalog: ["ensureSeeded", "getActiveCatalog", "getCatalog", "getProviderCatalog", "importCatalogDocument", "resetToBundled", "exportCatalogDocument"],
  mate: [
    "initializeSchema", "getMateState", "getUserDataPath", "getMateProfile", "verifyMateProfileFiles",
    "getMateGrowthSettings", "updateMateGrowthApplyIntervalMinutes", "updateMateGrowthSettings", "createMate",
    "updateMate", "setMateAvatar", "recoverMateProfileFilesFromActiveRevision", "resetMate", "deleteMateProjectionDirectory",
    "applyProfileFiles",
  ],
  prompt: ["listPromptTemplates", "createPromptTemplate", "updatePromptTemplate", "deletePromptTemplate"],
  settlement: [
    "enqueue", "listPending", "listReadyPending", "listDueReadyPending", "hasRecoverablePending", "listQuarantined",
    "listUnreadyPendingBefore", "markReady", "getPending", "saveEvaluation", "recordAppraisalFailure", "recordAttempt",
    "recoverInterruptedAttempts", "recordFailure", "releaseQuarantined", "markSettled", "markDiscarded",
  ],
  companion: [
    "ensureGroup", "createSession", "listSessionSummaries", "listActiveSessionSummaries", "getSession",
    "getMessageArtifact", "updateSession", "updateRuntimeMetadataIfMatches", "deleteSession",
    "updateSessionBaseSnapshot", "createMergeRun", "listMergeRunsForSession", "listMergeRunSummariesForSession", "clearCompanions",
  ],
} as const;

const MUTATIONS = new Set([
  "setSessionPinned", "upsertSession", "updateSessionThreadIfMatches", "updateSessionRuntimeMetadataIfMatches", "updateSession",
  "upsertTerminalSession", "updateTerminalSession", "clearCharacterAuthoringRuntimeState", "appendRunningTurnStart", "insertSession",
  "replaceSessions", "deleteSession", "deleteSessions", "clearSessions", "createAuditLog", "updateAuditLog", "clearAuditLogs",
  "updateAuxiliarySessionThreadIfMatches", "updateAuxiliarySessionRuntimeMetadataIfMatches", "updateAuxiliarySessionIfMatches", "upsertAuxiliarySession", "deleteAuxiliarySessionsForParent",
  "backfillAuxiliarySessionSummaries", "deleteAuxiliarySessionsExceptParents", "createCharacter", "updateCharacterMetadata", "updateCharacterDefinition", "archiveCharacter",
  "deleteCharacterRootDirectory", "updateSettings", "updateChatLayoutPreference", "resetSettings", "importCatalogDocument", "resetToBundled",
  "ensureSeeded", "initializeSchema", "recoverMateProfileFilesFromActiveRevision",
  "updateMateGrowthApplyIntervalMinutes", "updateMateGrowthSettings", "createMate", "updateMate", "setMateAvatar", "resetMate",
  "deleteMateProjectionDirectory", "applyProfileFiles", "createPromptTemplate", "updatePromptTemplate", "deletePromptTemplate",
  "enqueue", "markReady", "saveEvaluation",
  "recordAppraisalFailure", "recordAttempt", "recoverInterruptedAttempts", "recordFailure", "releaseQuarantined", "markSettled", "markDiscarded",
  "ensureGroup", "createSession", "updateSession", "updateRuntimeMetadataIfMatches", "deleteSession", "updateSessionBaseSnapshot",
  "createMergeRun", "clearCompanions",
]);

type StorageInstances = Record<keyof typeof STORE_METHODS, object>;

let instances: StorageInstances | null = null;

function createStoreHandlers(data: StorageWorkerEntryData) {
  if (!data.dbPath || !data.bundledModelCatalogPath || !data.userDataPath) {
    throw new Error("V6 storage worker requires dbPath, bundledModelCatalogPath, and userDataPath.");
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
  const session = new SessionStorageV6(data.dbPath);
  const audit = new AuditLogStorageV6(data.dbPath);
  const auxiliary = new AuxiliarySessionStorage(data.dbPath);
  const character = new CharacterStorage(data.dbPath, data.userDataPath);
  const settings = new AppSettingsStorage(data.dbPath);
  const catalog = new ModelCatalogStorage(data.dbPath, data.bundledModelCatalogPath);
  const mate = new MateStorage(data.dbPath, data.userDataPath);
  const prompt = new PromptTemplateStorage(data.dbPath);
  const settlement = new CharacterAffectTurnSettlementStorage(data.dbPath);
  const companion = new CompanionStorage(data.dbPath);
  instances = { session, audit, auxiliary, character, settings, catalog, mate, prompt, settlement, companion };
  const currentInstances = instances;
  catalog.ensureSeeded();

  return {
    "bundle.initialize": async () => ({
      activeModelCatalog: await catalog.ensureSeeded(),
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
      const input = payload as { store?: string; method?: string; args?: unknown[] };
      if (!(input.store && input.method && Array.isArray(input.args)) || !Object.prototype.hasOwnProperty.call(STORE_METHODS, input.store)) {
        throw new Error("Storage worker store command is invalid.");
      }
      const methods = STORE_METHODS[input.store as keyof typeof STORE_METHODS] as readonly string[];
      if (!methods.includes(input.method)) throw new Error(`Storage worker method is not allowed: ${input.store}.${input.method}`);
      const store = currentInstances[input.store as keyof StorageInstances] as Record<string, AnyMethod>;
      const method = store[input.method];
      if (typeof method !== "function") throw new Error(`Storage worker method is unavailable: ${input.store}.${input.method}`);
      return method.apply(store, input.args);
    },
  };
}

export async function createStorageWorkerCommandHandlers(data: StorageWorkerEntryData) {
  return createStoreHandlers(data);
}

export async function closeStorageWorker(): Promise<void> {
  for (const store of Object.values(instances ?? {})) {
    (store as { close?: () => void }).close?.();
  }
  instances = null;
}

export function createV6StorageWorkerBundle(options: {
  dbPath: string;
  bundledModelCatalogPath: string;
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
      bundledModelCatalogPath: options.bundledModelCatalogPath,
      userDataPath: options.userDataPath,
    },
  });
  const stores = Object.fromEntries(Object.entries(STORE_METHODS).map(([store, methods]) => [
    store,
    new Proxy({}, {
      get: (_target, property: string) => {
        if (!methods.includes(property as never)) return undefined;
        return (...args: unknown[]) => client.call("store.call", { store, method: property, args }, {
          mutation: MUTATIONS.has(property),
          operation: `${store}.${property}`,
        });
      },
    }),
  ])) as V6StorageWorkerBundle["stores"];
  const runAuxiliarySummaryMaintenance = async (batchSize = 100): Promise<AuxiliarySummaryMaintenanceResult> => {
    let processed = 0;
    let updated = 0;
    let remaining = 0;
    for (;;) {
      const result = await client.call<AuxiliarySummaryMaintenanceResult>(
        "store.call",
        { store: "auxiliary", method: "backfillAuxiliarySessionSummaries", args: [{ batchSize }] },
        { mutation: true, operation: "auxiliary.backfillAuxiliarySessionSummaries" },
      );
      processed += result.processed;
      updated += result.updated;
      remaining = result.remaining;
      if (result.error) {
        return { processed, updated, remaining, error: result.error, stopped: "malformed" };
      }
      if (remaining === 0) return { processed, updated, remaining };
      if (result.processed === 0 || result.updated === 0) {
        return { processed, updated, remaining, stopped: "no-progress" };
      }
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  };
  return {
    client,
    stores,
    initialize: () => client.call("bundle.initialize", null, { mutation: true, operation: "bundle.initialize" }),
    truncateWal: () => client.call<boolean>("maintenance.truncateWal", null, { mutation: true, operation: "maintenance.truncateWal" }),
    runAuxiliarySummaryMaintenance,
  };
}

export type AuxiliarySummaryMaintenanceResult = {
  processed: number;
  updated: number;
  remaining: number;
  error?: { id: string; message: string };
  stopped?: "malformed" | "no-progress";
};

export type V6StorageWorkerBundle = {
  client: StorageWorkerClient;
  initialize(): Promise<unknown>;
  truncateWal(): Promise<boolean>;
  runAuxiliarySummaryMaintenance(batchSize?: number): Promise<AuxiliarySummaryMaintenanceResult>;
  stores: {
    session: AsyncStore<SessionStorageV6>;
    audit: AsyncStore<AuditLogStorageV6>;
    auxiliary: AsyncStore<AuxiliarySessionStorageType>;
    character: AsyncStore<CharacterStorage>;
    settings: AsyncStore<AppSettingsStorage>;
    catalog: AsyncStore<ModelCatalogStorage>;
    mate: AsyncStore<MateStorage>;
    prompt: AsyncStore<PromptTemplateStorage>;
    settlement: AsyncStore<CharacterAffectTurnSettlementStorage>;
    companion: AsyncStore<CompanionStorage>;
  };
};
