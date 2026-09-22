import type { MemoryV6StorageAccess } from "./memory-v6-service.js";
import type { CharacterAffectStorageAccess } from "../character/character-affect-service.js";
import type {
  MemoryV6WorkerInput,
  MemoryV6WorkerOperation,
  MemoryV6WorkerResultFor,
} from "./memory-v6-worker-protocol.js";
import type { MemoryV6TargetResolverDeps } from "./memory-v6-context-resolver.js";
import { StorageWorkerClient } from "../storage/storage-worker-client.js";

export type MemoryV6WorkerClientOptions = {
  workerUrl: URL | string;
  dbPath: string;
  diagnosticSink?: import("../storage/storage-operation-diagnostics.js").StorageOperationDiagnosticSink;
  now?: () => Date;
};

/** Async Main-side facade for the fixed Memory worker command set. */
export class MemoryV6WorkerClient {
  private readonly client: StorageWorkerClient;
  private readonly now?: () => Date;
  readonly storage: MemoryV6StorageAccess;
  readonly affectStorage: CharacterAffectStorageAccess;
  readonly resolveProjectById: (id: string) => Promise<Awaited<ReturnType<NonNullable<MemoryV6TargetResolverDeps["resolveProjectById"]>>>>;
  readonly resolveProjectByPath: (projectPath: string) => Promise<Awaited<ReturnType<NonNullable<MemoryV6TargetResolverDeps["resolveProjectByPath"]>>>>;
  readonly resolveKnownProjectByPath: (projectPath: string) => Promise<Awaited<ReturnType<NonNullable<MemoryV6TargetResolverDeps["resolveKnownProjectByPath"]>>>>;

  constructor(options: MemoryV6WorkerClientOptions) {
    this.now = options.now;
    const sourceTypeScript = import.meta.url.endsWith(".ts");
    this.client = new StorageWorkerClient(options.workerUrl, {
      ...(sourceTypeScript ? { execArgv: ["--import", "tsx"] } : {}),
      ...(options.diagnosticSink ? { diagnosticSink: options.diagnosticSink } : {}),
      workerData: {
        dbPath: options.dbPath,
        ...(options.now ? { nowIso: options.now().toISOString() } : {}),
        handlerModule: new URL(sourceTypeScript ? "./memory-v6-worker-handlers.ts" : "./memory-v6-worker-handlers.js", import.meta.url).href,
      },
    });
    const call = <Operation extends MemoryV6WorkerOperation>(
      command: Operation,
      payload: MemoryV6WorkerInput<Operation>,
      mutation = false,
    ): Promise<MemoryV6WorkerResultFor<Operation>> => {
      const observedAt = command.startsWith("affect.") && this.now ? this.now().toISOString() : undefined;
      const commandPayload: unknown = observedAt && payload && typeof payload === "object" && !Array.isArray(payload)
        ? { ...(payload as Record<string, unknown>), __observedAt: observedAt }
        : payload;
      return this.client.call<MemoryV6WorkerResultFor<Operation>>(command, commandPayload, { mutation });
    };
    this.storage = {
      appendEntry: (input) => call("memory.appendEntry", input, true),
      resolveAppendIdempotencyReplay: (input) => call("memory.resolveAppendIdempotencyReplay", input),
      settleAppendCleanupObligation: (input) => call("memory.settleAppendCleanupObligation", input, true),
      getEntry: (entryId) => call("memory.getEntry", { entryId }),
      listTargets: (input) => call("memory.listTargets", input),
      listEntries: (input) => call("memory.listEntries", input),
      searchEntries: (input) => call("memory.searchEntries", input),
      searchEntriesForReview: (input) => call("memory.searchEntriesForReview", input),
      getFileUsage: () => call("memory.getFileUsage", undefined),
      listLargestFileEntries: (input) => call("memory.listLargestFileEntries", input),
      getProtectedObjectForExport: (input) => call("memory.getProtectedObjectForExport", input),
      listProtectedObjectsForEntryExport: (input) => call("memory.listProtectedObjectsForEntryExport", input),
      listDeletePendingProtectedObjectsForGc: (input) => call("memory.listDeletePendingProtectedObjectsForGc", input),
      listProtectedObjectIdsForGc: (input) => call("memory.listProtectedObjectIdsForGc", input),
      markProtectedObjectDeletedForGc: (input) => call("memory.markProtectedObjectDeletedForGc", input, true),
      listTags: (targets) => call("memory.listTags", { targets }),
      listTagsPage: (targets, input) => call("memory.listTagsPage", { targets, options: input }),
      listTagStatistics: (targets, sampleLimit) => call("memory.listTagStatistics", { targets, sampleLimit }),
      listTagStatisticsPage: (targets, input) => call("memory.listTagStatisticsPage", { targets, options: input }),
      forgetEntries: (input) => call("memory.forgetEntries", input, true),
      previewForgetEntries: (input) => call("memory.previewForgetEntries", input),
      moveEntry: (input) => call("memory.moveEntry", input, true),
      forgetEntryForReview: (input) => call("memory.forgetEntryForReview", input, true),
    };
    this.affectStorage = {
      recordEvent: (event, options) => call("affect.recordEvent", { event, ...options }, true),
      correctEvent: (event, options) => call("affect.correctEvent", { event, ...options }, true),
      reset: (reset, options) => call("affect.reset", { reset, ...options }, true),
      linkMemoryEpisode: (eventId, memoryEntryId) => call("affect.linkMemoryEpisode", { eventId, memoryEntryId }, true),
      recordEpisodeCandidate: (eventId) => call("affect.recordEpisodeCandidate", { eventId }, true),
      recordRejection: (input) => call("affect.recordRejection", input, true),
      getEvent: (input) => call("affect.getEvent", input),
      getEffectiveState: (input) => call("affect.getEffectiveState", input),
      getStateVersion: (input) => call("affect.getStateVersion", input),
      inspect: (input) => call("affect.inspect", input),
      getMetrics: () => call("affect.getMetrics", undefined),
    };
    this.resolveProjectById = (id) => call("project.resolveById", { id });
    this.resolveProjectByPath = (projectPath) => call("project.resolveByPath", { projectPath });
    this.resolveKnownProjectByPath = (projectPath) => call("project.resolveKnownByPath", { projectPath });
  }

  close(): Promise<void> {
    return this.client.close();
  }

}
