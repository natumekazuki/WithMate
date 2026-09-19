import type { AffectEventInput } from "../src/character-affect/affect-contract.js";
import type { AffectResetInput } from "./character-affect-storage.js";
import type { MemoryV6Storage } from "./memory-v6-storage.js";
import type { MemoryV6ResolvedTarget } from "./memory-v6-schema.js";
import type { CharacterAffectStorage } from "./character-affect-storage.js";
import type { MemoryV6TargetResolverDeps } from "./memory-v6-context-resolver.js";

/**
 * Fixed SQL operations exposed by the Memory worker.
 *
 * This is deliberately a closed command set.  The worker does not accept SQL,
 * callbacks, or arbitrary method names from Main.
 */
export type MemoryV6WorkerCommand =
  | { operation: "memory.appendEntry"; input: Parameters<MemoryV6Storage["appendEntry"]>[0] }
  | { operation: "memory.resolveAppendIdempotencyReplay"; input: Parameters<MemoryV6Storage["resolveAppendIdempotencyReplay"]>[0] }
  | { operation: "memory.getEntry"; input: { entryId: string } }
  | { operation: "memory.listTargets"; input: Parameters<MemoryV6Storage["listTargets"]>[0] }
  | { operation: "memory.listEntries"; input: Parameters<MemoryV6Storage["listEntries"]>[0] }
  | { operation: "memory.searchEntries"; input: Parameters<MemoryV6Storage["searchEntries"]>[0] }
  | { operation: "memory.searchEntriesForReview"; input: Parameters<MemoryV6Storage["searchEntriesForReview"]>[0] }
  | { operation: "memory.getFileUsage"; input: undefined }
  | { operation: "memory.listLargestFileEntries"; input: Parameters<MemoryV6Storage["listLargestFileEntries"]>[0] }
  | { operation: "memory.listProtectedObjectsForEntryExport"; input: Parameters<MemoryV6Storage["listProtectedObjectsForEntryExport"]>[0] }
  | { operation: "memory.getProtectedObjectForExport"; input: Parameters<MemoryV6Storage["getProtectedObjectForExport"]>[0] }
  | { operation: "memory.listDeletePendingProtectedObjectsForGc"; input: Parameters<MemoryV6Storage["listDeletePendingProtectedObjectsForGc"]>[0] }
  | { operation: "memory.listProtectedObjectIdsForGc"; input: Parameters<MemoryV6Storage["listProtectedObjectIdsForGc"]>[0] }
  | { operation: "memory.markProtectedObjectDeletedForGc"; input: Parameters<MemoryV6Storage["markProtectedObjectDeletedForGc"]>[0] }
  | { operation: "memory.listTags"; input: { targets: readonly MemoryV6ResolvedTarget[] } }
  | { operation: "memory.listTagStatistics"; input: { targets: readonly MemoryV6ResolvedTarget[]; sampleLimit?: number } }
  | { operation: "memory.forgetEntries"; input: Parameters<MemoryV6Storage["forgetEntries"]>[0] }
  | { operation: "memory.previewForgetEntries"; input: Parameters<MemoryV6Storage["previewForgetEntries"]>[0] }
  | { operation: "memory.settleAppendCleanupObligation"; input: Parameters<MemoryV6Storage["settleAppendCleanupObligation"]>[0] }
  | { operation: "memory.listTagsPage"; input: { targets: readonly MemoryV6ResolvedTarget[]; options: Parameters<MemoryV6Storage["listTagsPage"]>[1] } }
  | { operation: "memory.listTagStatisticsPage"; input: { targets: readonly MemoryV6ResolvedTarget[]; options: Parameters<MemoryV6Storage["listTagStatisticsPage"]>[1] } }
  | { operation: "memory.moveEntry"; input: Parameters<MemoryV6Storage["moveEntry"]>[0] }
  | { operation: "memory.forgetEntryForReview"; input: Parameters<MemoryV6Storage["forgetEntryForReview"]>[0] }
  | { operation: "affect.recordEvent"; input: { event: AffectEventInput; expectedVersion?: string } }
  | { operation: "affect.correctEvent"; input: { event: Parameters<CharacterAffectStorage["correctEvent"]>[0]; expectedVersion?: string } }
  | { operation: "affect.reset"; input: { reset: AffectResetInput; expectedVersion?: string } }
  | { operation: "affect.linkMemoryEpisode"; input: { eventId: string; memoryEntryId: string } }
  | { operation: "affect.recordEpisodeCandidate"; input: { eventId: string } }
  | { operation: "affect.recordRejection"; input: Parameters<CharacterAffectStorage["recordRejection"]>[0] }
  | { operation: "affect.getEvent"; input: Parameters<CharacterAffectStorage["getEvent"]>[0] }
  | { operation: "affect.getEffectiveState"; input: Parameters<CharacterAffectStorage["getEffectiveState"]>[0] }
  | { operation: "affect.getStateVersion"; input: Parameters<CharacterAffectStorage["getStateVersion"]>[0] }
  | { operation: "affect.inspect"; input: Parameters<CharacterAffectStorage["inspect"]>[0] }
  | { operation: "affect.getMetrics"; input: undefined }
  | { operation: "project.resolveById"; input: { id: string } }
  | { operation: "project.resolveByPath"; input: { projectPath: string } }
  | { operation: "project.resolveKnownByPath"; input: { projectPath: string } }
  | { operation: "project.listScopes"; input: undefined };

export type MemoryV6WorkerOperation = MemoryV6WorkerCommand["operation"];
export type MemoryV6WorkerInput<Operation extends MemoryV6WorkerOperation> =
  Extract<MemoryV6WorkerCommand, { operation: Operation }>["input"];

type MethodResult<T, K extends keyof T> = T[K] extends (...args: never[]) => infer Result
  ? Awaited<Result>
  : never;

/** Result type corresponding to each closed worker operation. */
export type MemoryV6WorkerResultFor<Operation extends MemoryV6WorkerOperation> =
  Operation extends `memory.${infer Method}`
    ? Method extends keyof MemoryV6Storage ? MethodResult<MemoryV6Storage, Method> : never
    : Operation extends `affect.${infer Method}`
      ? Method extends keyof CharacterAffectStorage ? MethodResult<CharacterAffectStorage, Method> : never
    : Operation extends "project.resolveById" ? Awaited<ReturnType<NonNullable<MemoryV6TargetResolverDeps["resolveProjectById"]>>>
    : Operation extends "project.resolveByPath" ? Awaited<ReturnType<NonNullable<MemoryV6TargetResolverDeps["resolveProjectByPath"]>>>
    : Operation extends "project.resolveKnownByPath" ? Awaited<ReturnType<NonNullable<MemoryV6TargetResolverDeps["resolveKnownProjectByPath"]>>>
    : Operation extends "project.listScopes" ? ReturnType<typeof import("./memory-v6-project-resolver.js").listMemoryV6ProjectScopes>
    : never;
