import { workerData } from "node:worker_threads";

import { CharacterAffectStorage } from "./character-affect-storage.js";
import { createMemoryV6ProjectResolver, listMemoryV6ProjectScopes } from "./memory-v6-project-resolver.js";
import { MemoryV6Storage } from "./memory-v6-storage.js";
import type { StorageWorkerCommandHandlers } from "./storage-worker-dispatcher.js";
import type { StorageWorkerRequestContext } from "./storage-worker-protocol.js";

type MemoryWorkerData = {
  dbPath?: unknown;
  nowIso?: unknown;
};

let activeMemory: MemoryV6Storage | null = null;
let activeAffect: CharacterAffectStorage | null = null;

function requireDbPath(): string {
  const dbPath = (workerData as MemoryWorkerData).dbPath;
  if (typeof dbPath !== "string" || !dbPath) {
    throw new Error("Memory worker database path is invalid.");
  }
  return dbPath;
}

function requireObjectPayload(payload: unknown): Record<string, unknown> {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("Memory worker command payload must be an object.");
  }
  return payload as Record<string, unknown>;
}

function setObservedAt(affect: CharacterAffectStorage, payload: unknown): Record<string, unknown> {
  const value = requireObjectPayload(payload);
  if (typeof value.__observedAt === "string") {
    const observedAt = value.__observedAt;
    affect.setNow(() => new Date(observedAt));
    delete value.__observedAt;
  }
  return value;
}

export function createStorageWorkerCommandHandlers(): StorageWorkerCommandHandlers {
  const dbPath = requireDbPath();
  const memory = new MemoryV6Storage(dbPath);
  const nowIso = (workerData as MemoryWorkerData).nowIso;
  const affect = new CharacterAffectStorage(dbPath, typeof nowIso === "string" ? { now: () => new Date(nowIso) } : {});
  activeMemory = memory;
  activeAffect = affect;
  const project = createMemoryV6ProjectResolver(dbPath);

  const input = <T>(payload: unknown): T => payload as T;
  const noPayload = (payload: unknown): void => {
    if (payload !== undefined) {
      throw new Error("Memory worker command does not accept a payload.");
    }
  };

  const handlers: Record<string, (payload: unknown, context: StorageWorkerRequestContext) => unknown> = {
    "memory.appendEntry": (payload) => memory.appendEntry(input(payload)),
    "memory.resolveAppendIdempotencyReplay": (payload) => memory.resolveAppendIdempotencyReplay(input(payload)),
    "memory.getEntry": (payload) => memory.getEntry(String(requireObjectPayload(payload).entryId ?? "")),
    "memory.listTargets": (payload) => memory.listTargets(input(payload)),
    "memory.listEntries": (payload) => memory.listEntries(input(payload)),
    "memory.searchEntries": (payload) => memory.searchEntries(input(payload)),
    "memory.searchEntriesForReview": (payload) => memory.searchEntriesForReview(input(payload)),
    "memory.getFileUsage": (payload) => {
      noPayload(payload);
      return memory.getFileUsage();
    },
    "memory.listLargestFileEntries": (payload) => memory.listLargestFileEntries(input(payload)),
    "memory.listProtectedObjectsForEntryExport": (payload) => memory.listProtectedObjectsForEntryExport(input(payload)),
    "memory.getProtectedObjectForExport": (payload) => memory.getProtectedObjectForExport(input(payload)),
    "memory.listDeletePendingProtectedObjectsForGc": (payload) => memory.listDeletePendingProtectedObjectsForGc(input(payload)),
    "memory.listProtectedObjectIdsForGc": (payload) => memory.listProtectedObjectIdsForGc(input(payload)),
    "memory.markProtectedObjectDeletedForGc": (payload) => memory.markProtectedObjectDeletedForGc(input(payload)),
    "memory.listTags": (payload) => memory.listTags(input<{ targets: Parameters<MemoryV6Storage["listTags"]>[0] }>(payload).targets),
    "memory.listTagStatistics": (payload) => {
      const value = input<{ targets: Parameters<MemoryV6Storage["listTagStatistics"]>[0]; sampleLimit?: number }>(payload);
      return memory.listTagStatistics(value.targets, value.sampleLimit);
    },
    "memory.forgetEntries": (payload) => memory.forgetEntries(input(payload)),
    "memory.previewForgetEntries": (payload) => memory.previewForgetEntries(input(payload)),
    "memory.settleAppendCleanupObligation": (payload) => memory.settleAppendCleanupObligation(input(payload)),
    "memory.listTagsPage": (payload) => {
      const value = input<{ targets: Parameters<MemoryV6Storage["listTagsPage"]>[0]; options: Parameters<MemoryV6Storage["listTagsPage"]>[1] }>(payload);
      return memory.listTagsPage(value.targets, value.options);
    },
    "memory.listTagStatisticsPage": (payload) => {
      const value = input<{ targets: Parameters<MemoryV6Storage["listTagStatisticsPage"]>[0]; options: Parameters<MemoryV6Storage["listTagStatisticsPage"]>[1] }>(payload);
      return memory.listTagStatisticsPage(value.targets, value.options);
    },
    "memory.moveEntry": (payload) => memory.moveEntry(input(payload)),
    "memory.forgetEntryForReview": (payload) => memory.forgetEntryForReview(input(payload)),
    "affect.recordEvent": (payload) => {
      const value = input<{ event: Parameters<CharacterAffectStorage["recordEvent"]>[0]; expectedVersion?: string }>(setObservedAt(affect, payload));
      return affect.recordEvent(value.event, value.expectedVersion ? { expectedVersion: value.expectedVersion } : {});
    },
    "affect.correctEvent": (payload) => {
      const value = input<{ event: Parameters<CharacterAffectStorage["correctEvent"]>[0]; expectedVersion?: string }>(setObservedAt(affect, payload));
      return affect.correctEvent(value.event, value.expectedVersion ? { expectedVersion: value.expectedVersion } : {});
    },
    "affect.reset": (payload) => {
      const value = input<{ reset: Parameters<CharacterAffectStorage["reset"]>[0]; expectedVersion?: string }>(setObservedAt(affect, payload));
      return affect.reset(value.reset, value.expectedVersion ? { expectedVersion: value.expectedVersion } : {});
    },
    "affect.linkMemoryEpisode": (payload) => {
      const value = input<{ eventId: string; memoryEntryId: string }>(setObservedAt(affect, payload));
      return affect.linkMemoryEpisode(value.eventId, value.memoryEntryId);
    },
    "affect.recordEpisodeCandidate": (payload) => affect.recordEpisodeCandidate(String(setObservedAt(affect, payload).eventId ?? "")),
    "affect.recordRejection": (payload) => affect.recordRejection(input(setObservedAt(affect, payload))),
    "affect.getEvent": (payload) => affect.getEvent(input(setObservedAt(affect, payload))),
    "affect.getEffectiveState": (payload) => affect.getEffectiveState(input(setObservedAt(affect, payload))),
    "affect.getStateVersion": (payload) => affect.getStateVersion(input(setObservedAt(affect, payload))),
    "affect.inspect": (payload) => affect.inspect(input(setObservedAt(affect, payload))),
    "affect.getMetrics": (payload) => {
      noPayload(payload);
      return affect.getMetrics();
    },
    "project.resolveById": (payload) => project.resolveProjectById!(String(requireObjectPayload(payload).id ?? "")),
    "project.resolveByPath": (payload) => project.resolveProjectByPath!(String(requireObjectPayload(payload).projectPath ?? "")),
    "project.resolveKnownByPath": (payload) => project.resolveKnownProjectByPath!(String(requireObjectPayload(payload).projectPath ?? "")),
    "project.listScopes": (payload) => {
      noPayload(payload);
      return listMemoryV6ProjectScopes(dbPath);
    },
  };

  return handlers;
}

export function closeStorageWorker(): void {
  activeMemory?.close();
  activeAffect?.close();
  activeMemory = null;
  activeAffect = null;
}
