import { assertValidAffectEvent } from "../src/character-affect/affect-contract.js";
import type { CharacterRuntimeSnapshot } from "../src/character/character-catalog.js";
import {
  CHARACTER_CONTEXT_SCHEMA_VERSION,
  createCharacterContextError,
  isCharacterContextError,
  type CharacterAffectAppraiseResponse,
  type CharacterContextErrorResponse,
  type CharacterContextResponse,
  type CharacterContextServiceResult,
  type CharacterMemoryMutationResponse,
  type CharacterMemorySearchResponse,
  type CharacterOperationAuthority,
} from "../src/character-context/character-context-contract.js";
import {
  CharacterContextValidationError,
  validateCharacterAffectAppraiseRequest,
  validateCharacterAffectCorrectRequest,
  validateCharacterAffectInspectRequest,
  validateCharacterAffectResetRequest,
  validateCharacterContextGetRequest,
  validateCharacterMemoryAppendEpisodeRequest,
  validateCharacterMemoryCorrectRequest,
  validateCharacterMemoryForgetRequest,
  validateCharacterMemorySearchRequest,
} from "../src/character-context/character-context-validation.js";
import { MEMORY_V6_SCHEMA_VERSION, type MemoryTargetSelector } from "../src/memory-v6/memory-contract.js";
import type { MemoryErrorResponse } from "../src/memory-v6/memory-response-contract.js";
import type { MemoryEntrySummary } from "../src/memory-v6/memory-state.js";
import {
  CharacterAffectEpisodePersistenceError,
  CharacterAffectService,
} from "./character-affect-service.js";
import {
  CharacterAffectIdempotencyConflictError,
  CharacterAffectVersionConflictError,
} from "./character-affect-storage.js";
import type { MemoryV6Service } from "./memory-v6-service.js";
import { countMemorySearchQueryTerms } from "./memory-v6-storage.js";
import { createLocalUserMemoryPrincipal } from "./memory-v6-permission.js";

const LOCAL_USER_ID = "local-user" as const;

export type CharacterContextTransport = "lifecycle" | "cli" | "mcp" | "internal";

type OperationMetric = {
  calls: number;
  successes: number;
  rejections: number;
  failures: number;
  idempotentReplays: number;
  versionConflicts: number;
  totalLatencyMs: number;
  rejectionsByCode: Record<string, number>;
};

export type CharacterContextApplicationServiceDeps = {
  memoryService: MemoryV6Service;
  affectService: CharacterAffectService;
  resolveCharacterRuntimeSnapshot(characterId: string): CharacterRuntimeSnapshot | null;
  onUnexpectedError?(diagnostic: CharacterContextUnexpectedErrorDiagnostic): void;
};

export type CharacterContextUnexpectedErrorDiagnostic = {
  operation: "character_context.get";
  transport: CharacterContextTransport;
  stage: "affect_state" | "memory_search" | "response_assembly";
  errorName: string;
  safeMessage: string;
  durationMs: number;
  queryLength: number;
  searchTermCount: number;
};

class CharacterContextStageError extends Error {
  constructor(
    readonly stage: CharacterContextUnexpectedErrorDiagnostic["stage"],
    readonly original: unknown,
  ) {
    super(`Character context ${stage} failed.`);
    this.name = "CharacterContextStageError";
  }
}

function errorName(error: unknown): string {
  return error instanceof Error && error.name.trim() ? error.name : "UnknownError";
}

function withFailureStage(
  response: CharacterContextErrorResponse,
  stage: CharacterContextUnexpectedErrorDiagnostic["stage"],
): CharacterContextErrorResponse {
  return {
    ...response,
    error: {
      ...response.error,
      details: { failureStage: stage },
    },
  };
}

function characterTarget(characterId: string): MemoryTargetSelector {
  return {
    owner: "character",
    scope: "character",
    character: { type: "id", id: characterId },
  };
}

function memoryError(value: unknown): value is MemoryErrorResponse {
  return Boolean(value && typeof value === "object" && "error" in value);
}

function sourceVersion(items: readonly { updatedAt: string }[]): string | null {
  return items.map((item) => item.updatedAt).sort().at(-1) ?? null;
}

function requireExplicitAuthority(authority: CharacterOperationAuthority): CharacterContextErrorResponse | null {
  if (authority.kind === "explicit_user_instruction" || authority.kind === "operator") {
    return null;
  }
  return createCharacterContextError(
    "authority_denied",
    "This operation requires an explicit user instruction or operator authority.",
    {
      field: "authority",
      retryable: false,
      conversationMayContinue: true,
      effect: "none",
    },
  );
}

function memoryErrorToContext(
  error: MemoryErrorResponse,
  failureEffect: "none" | "unknown",
): CharacterContextErrorResponse {
  const code = error.error.code;
  if (code === "MEMORY_TARGET_NOT_FOUND" || code === "MEMORY_ENTRY_NOT_FOUND") {
    return createCharacterContextError("unknown_scope", error.error.message, {
      field: error.error.field,
      retryable: false,
      conversationMayContinue: true,
      effect: "none",
    });
  }
  if (code === "MEMORY_UNAUTHORIZED" || code === "MEMORY_FORBIDDEN") {
    return createCharacterContextError("authority_denied", error.error.message, {
      field: error.error.field,
      retryable: false,
      conversationMayContinue: true,
      effect: "none",
    });
  }
  if (code === "MEMORY_IDEMPOTENCY_CONFLICT") {
    return createCharacterContextError("invalid_input", error.error.message, {
      field: "idempotencyKey",
      retryable: false,
      conversationMayContinue: true,
      effect: "none",
    });
  }
  if (code.includes("INVALID")) {
    return createCharacterContextError("invalid_input", error.error.message, {
      field: error.error.field,
      retryable: false,
      conversationMayContinue: true,
      effect: "none",
    });
  }
  return createCharacterContextError("storage_unavailable", error.error.message, {
    field: error.error.field,
    retryable: true,
    conversationMayContinue: true,
    effect: failureEffect,
  });
}

export class CharacterContextApplicationService {
  private readonly principal = createLocalUserMemoryPrincipal();
  private readonly metrics = new Map<string, OperationMetric>();
  private readonly fallbackMetrics = new Map<string, number>();

  constructor(private readonly deps: CharacterContextApplicationServiceDeps) {}

  async getContext(
    request: unknown,
    transport: CharacterContextTransport = "internal",
  ): Promise<CharacterContextServiceResult<CharacterContextResponse>> {
    return this.measure("character_context.get", transport, "none", async () => {
      const input = validateCharacterContextGetRequest(request);
      const snapshot = this.deps.resolveCharacterRuntimeSnapshot(input.characterId);
      if (!snapshot) {
        return createCharacterContextError("unknown_character", "Character was not found.", {
          field: "characterId",
          retryable: false,
          conversationMayContinue: true,
          effect: "none",
        });
      }
      try {
        const queryLength = input.query?.length ?? 0;
        const searchTermCount = input.query ? countMemorySearchQueryTerms(input.query) : 0;
        const { state, version } = await this.runContextStage(
          "affect_state",
          transport,
          queryLength,
          searchTermCount,
          () => ({
            state: this.deps.affectService.getEffectiveState({
              characterId: input.characterId,
              userId: LOCAL_USER_ID,
              sessionId: input.sessionId,
            }),
            version: this.deps.affectService.getStateVersion({
              characterId: input.characterId,
              userId: LOCAL_USER_ID,
              sessionId: input.sessionId,
            }),
          }),
        );
        const memory = input.query && (input.memoryLimit ?? 0) > 0
          ? await this.runContextStage(
              "memory_search",
              transport,
              queryLength,
              searchTermCount,
              () => this.deps.memoryService.search(this.principal, {
                schemaVersion: MEMORY_V6_SCHEMA_VERSION,
                targets: [characterTarget(input.characterId)],
                query: input.query!,
                limit: input.memoryLimit,
              }),
            )
          : { schemaVersion: MEMORY_V6_SCHEMA_VERSION, items: [] };
        if (memoryError(memory)) {
          return withFailureStage(memoryErrorToContext(memory, "none"), "memory_search");
        }
        return await this.runContextStage(
          "response_assembly",
          transport,
          queryLength,
          searchTermCount,
          () => ({
          schemaVersion: CHARACTER_CONTEXT_SCHEMA_VERSION,
          characterId: input.characterId,
          sessionId: input.sessionId,
          baseline: {
            definitionSha256: snapshot.definitionSha256,
            snapshotAt: snapshot.snapshotAt,
          },
          affect: {
            mode: state.mode,
            effective: state.components.map((component) => ({
              contributingLayers: [...component.contributingLayers].sort((left, right) => {
                const layerOrder = { baseline: 0, relationship: 1, session: 2 } as const;
                return layerOrder[left] - layerOrder[right];
              }),
              targetType: component.targetType,
              targetId: component.targetId,
              label: component.label,
              valence: component.valence,
              ...(component.arousal === undefined ? {} : { arousal: component.arousal }),
              ...(Object.keys(component.dimensions).length === 0 ? {} : { dimensions: { ...component.dimensions } }),
              intensity: component.intensity,
            })),
            version: version.version,
            updatedAt: version.updatedAt,
          },
          memory: {
            items: memory.items,
            ...(memory.relatedTags ? { relatedTags: memory.relatedTags } : {}),
            updatedAt: sourceVersion(memory.items),
          },
          scope: {
            userId: LOCAL_USER_ID,
            characterId: input.characterId,
            sessionId: input.sessionId,
          },
          }),
        );
      } catch (error) {
        const stage = error instanceof CharacterContextStageError ? error.stage : "response_assembly";
        const original = error instanceof CharacterContextStageError ? error.original : error;
        return withFailureStage(this.mapThrownError(original, "context read", "none"), stage);
      }
    });
  }

  async appraise(
    request: unknown,
    transport: CharacterContextTransport = "internal",
  ): Promise<CharacterContextServiceResult<CharacterAffectAppraiseResponse>> {
    return this.measure("character_affect.appraise", transport, "unknown", async () => {
      const input = validateCharacterAffectAppraiseRequest(request);
      if (!this.deps.resolveCharacterRuntimeSnapshot(input.characterId)) {
        return createCharacterContextError("unknown_character", "Character was not found.", {
          field: "characterId",
          retryable: false,
          conversationMayContinue: true,
          effect: "none",
        });
      }
      const saved: CharacterAffectAppraiseResponse["saved"] = [];
      const rejected: CharacterAffectAppraiseResponse["rejected"] = [];
      let expectedVersion = input.expectedVersion;
      for (let index = 0; index < input.candidates.length; index += 1) {
        const candidate = input.candidates[index]!;
        try {
          assertValidAffectEvent(candidate);
        } catch (error) {
          rejected.push({
            candidateIndex: index,
            code: "invalid_input",
            message: error instanceof Error ? error.message : "Affect candidate is invalid.",
          });
          continue;
        }
        try {
          const result = await this.deps.affectService.recordAppraisal(candidate, { expectedVersion });
          saved.push({
            candidateIndex: index,
            eventId: result.event.id,
            memoryEntryId: result.event.memoryEntryId,
            replayed: !result.created,
          });
          expectedVersion = this.deps.affectService.getStateVersion({
            characterId: input.characterId,
            userId: LOCAL_USER_ID,
            sessionId: input.sessionId,
          }).version;
        } catch (error) {
          if (error instanceof CharacterAffectEpisodePersistenceError) {
            return createCharacterContextError(
              "partial_failure",
              "Character affect was saved, but its Memory episode did not converge.",
              {
                retryable: true,
                conversationMayContinue: true,
                effect: "committed",
                details: {
                  saved,
                  failedCandidateIndex: index,
                  eventId: error.eventId,
                  memoryEpisodeLinked: false,
                },
              },
            );
          }
          if (saved.length > 0) {
            return createCharacterContextError("partial_failure", "Some affect candidates were saved before the operation failed.", {
              retryable: true,
              conversationMayContinue: true,
              effect: "partial",
              details: { saved, failedCandidateIndex: index },
            });
          }
          return this.mapThrownError(error, "affect write", "unknown");
        }
      }
      const version = this.deps.affectService.getStateVersion({
        characterId: input.characterId,
        userId: LOCAL_USER_ID,
        sessionId: input.sessionId,
      });
      return {
        schemaVersion: CHARACTER_CONTEXT_SCHEMA_VERSION,
        characterId: input.characterId,
        sessionId: input.sessionId,
        saved,
        rejected,
        version: version.version,
        updatedAt: version.updatedAt,
      };
    });
  }

  async inspectAffect(request: unknown, transport: CharacterContextTransport = "internal"): Promise<unknown> {
    return this.measure("character_affect.inspect", transport, "none", async () => {
      const input = validateCharacterAffectInspectRequest(request);
      try {
        const inspection = this.deps.affectService.inspect({
          characterId: input.characterId,
          userId: LOCAL_USER_ID,
          sessionId: input.sessionId,
        });
        const version = this.deps.affectService.getStateVersion({
          characterId: input.characterId,
          userId: LOCAL_USER_ID,
          sessionId: input.sessionId,
        });
        return {
          schemaVersion: CHARACTER_CONTEXT_SCHEMA_VERSION,
          characterId: input.characterId,
          sessionId: input.sessionId,
          version,
          ...inspection,
        };
      } catch (error) {
        return this.mapThrownError(error, "affect inspect", "none");
      }
    });
  }

  async correctAffect(request: unknown, transport: CharacterContextTransport = "internal"): Promise<unknown> {
    return this.measure("character_affect.correct", transport, "unknown", async () => {
      const input = validateCharacterAffectCorrectRequest(request);
      const authorityError = requireExplicitAuthority(input.authority);
      if (authorityError) {
        return authorityError;
      }
      try {
        assertValidAffectEvent(input.replacement);
        const result = await this.deps.affectService.correctEvent({
          eventId: input.eventId,
          replacement: input.replacement,
          reason: input.reason,
        }, { expectedVersion: input.expectedVersion });
        const version = this.deps.affectService.getStateVersion({
          characterId: input.characterId,
          userId: LOCAL_USER_ID,
          sessionId: input.sessionId,
        });
        return {
          schemaVersion: CHARACTER_CONTEXT_SCHEMA_VERSION,
          characterId: input.characterId,
          sessionId: input.sessionId,
          event: result.event,
          replayed: !result.created,
          ...version,
        };
      } catch (error) {
        return this.mapThrownError(error, "affect correction", "unknown");
      }
    });
  }

  async resetAffect(request: unknown, transport: CharacterContextTransport = "internal"): Promise<unknown> {
    return this.measure("character_affect.reset", transport, "unknown", async () => {
      const input = validateCharacterAffectResetRequest(request);
      const authorityError = requireExplicitAuthority(input.authority);
      if (authorityError) {
        return authorityError;
      }
      try {
        const result = this.deps.affectService.reset({
          characterId: input.characterId,
          userId: LOCAL_USER_ID,
          layer: input.layer,
          ...(input.layer === "session" ? { sessionId: input.sessionId } : {}),
          reason: input.reason,
          resetAt: input.resetAt,
          idempotencyKey: input.idempotencyKey,
        }, {
          expectedVersion: input.expectedVersion,
          versionSessionId: input.sessionId,
        });
        const version = this.deps.affectService.getStateVersion({
          characterId: input.characterId,
          userId: LOCAL_USER_ID,
          sessionId: input.sessionId,
        });
        return {
          schemaVersion: CHARACTER_CONTEXT_SCHEMA_VERSION,
          characterId: input.characterId,
          sessionId: input.sessionId,
          resetId: result.resetId,
          replayed: !result.created,
          ...version,
        };
      } catch (error) {
        return this.mapThrownError(error, "affect reset", "unknown");
      }
    });
  }

  async searchMemory(
    request: unknown,
    transport: CharacterContextTransport = "internal",
  ): Promise<CharacterContextServiceResult<CharacterMemorySearchResponse>> {
    return this.measure("character_memory.search", transport, "none", async () => {
      const input = validateCharacterMemorySearchRequest(request);
      if (!this.deps.resolveCharacterRuntimeSnapshot(input.characterId)) {
        return createCharacterContextError("unknown_character", "Character was not found.", {
          field: "characterId",
          retryable: false,
          conversationMayContinue: true,
          effect: "none",
        });
      }
      const target = input.scope.scope === "character"
        ? characterTarget(input.characterId)
        : {
            owner: "character" as const,
            scope: "project" as const,
            character: { type: "id" as const, id: input.characterId },
            project: input.scope.project,
          };
      const result = await this.deps.memoryService.search(this.principal, {
        schemaVersion: MEMORY_V6_SCHEMA_VERSION,
        targets: [target],
        query: input.query,
        limit: input.limit,
      });
      if (memoryError(result)) {
        return memoryErrorToContext(result, "none");
      }
      return {
        schemaVersion: CHARACTER_CONTEXT_SCHEMA_VERSION,
        characterId: input.characterId,
        scope: input.scope,
        items: result.items,
        ...(result.relatedTags ? { relatedTags: result.relatedTags } : {}),
        sourceVersion: sourceVersion(result.items),
      };
    });
  }

  async appendEpisode(
    request: unknown,
    transport: CharacterContextTransport = "internal",
  ): Promise<CharacterContextServiceResult<CharacterMemoryMutationResponse>> {
    return this.measure("character_memory.append_episode", transport, "unknown", async () => {
      const input = validateCharacterMemoryAppendEpisodeRequest(request);
      if (!this.deps.resolveCharacterRuntimeSnapshot(input.characterId)) {
        return createCharacterContextError("unknown_character", "Character was not found.", {
          field: "characterId",
          retryable: false,
          conversationMayContinue: true,
          effect: "none",
        });
      }
      try {
        this.deps.affectService.getStateVersion({
          characterId: input.characterId,
          userId: LOCAL_USER_ID,
          sessionId: input.sessionId,
        });
      } catch (error) {
        return this.mapThrownError(error, "episode scope validation", "none");
      }
      return this.appendMemoryEpisode({
        characterId: input.characterId,
        idempotencyKey: input.idempotencyKey,
        episode: input.episode,
        operation: "append_episode",
      });
    });
  }

  async correctMemory(
    request: unknown,
    transport: CharacterContextTransport = "internal",
  ): Promise<CharacterContextServiceResult<CharacterMemoryMutationResponse>> {
    return this.measure("character_memory.correct", transport, "unknown", async () => {
      const input = validateCharacterMemoryCorrectRequest(request);
      const authorityError = requireExplicitAuthority(input.authority);
      if (authorityError) {
        return authorityError;
      }
      return this.appendMemoryEpisode({
        characterId: input.characterId,
        idempotencyKey: input.idempotencyKey,
        episode: input.replacement,
        operation: "correct",
        supersedes: input.entryId,
        mutationReason: input.reason,
      });
    });
  }

  async forgetMemory(
    request: unknown,
    transport: CharacterContextTransport = "internal",
  ): Promise<CharacterContextServiceResult<CharacterMemoryMutationResponse>> {
    return this.measure("character_memory.forget", transport, "unknown", async () => {
      const input = validateCharacterMemoryForgetRequest(request);
      const authorityError = requireExplicitAuthority(input.authority);
      if (authorityError) {
        return authorityError;
      }
      const result = this.deps.memoryService.forget(this.principal, {
        schemaVersion: MEMORY_V6_SCHEMA_VERSION,
        target: characterTarget(input.characterId),
        entryIds: [input.entryId],
        reason: input.reason,
        idempotencyKey: input.idempotencyKey,
      });
      if (memoryError(result)) {
        return memoryErrorToContext(result, "unknown");
      }
      const outcome = result.results[0];
      return {
        schemaVersion: CHARACTER_CONTEXT_SCHEMA_VERSION,
        characterId: input.characterId,
        operation: "forget",
        entry: outcome?.entry ?? null,
        replayed: outcome?.status === "already_forgotten",
        readBack: outcome?.status === "not_found" ? "not_found" : "forgotten",
        sourceVersion: outcome?.entry?.updatedAt ?? null,
      };
    });
  }

  recordFallback(from: "mcp", to: "cli"): void {
    const key = `${from}->${to}`;
    this.fallbackMetrics.set(key, (this.fallbackMetrics.get(key) ?? 0) + 1);
  }

  getMetrics(): {
    operations: Record<string, OperationMetric>;
    fallbacks: Record<string, number>;
  } {
    return {
      operations: Object.fromEntries([...this.metrics.entries()].map(([key, value]) => [key, {
        ...value,
        rejectionsByCode: { ...value.rejectionsByCode },
      }])),
      fallbacks: Object.fromEntries(this.fallbackMetrics.entries()),
    };
  }

  private async appendMemoryEpisode(input: {
    characterId: string;
    idempotencyKey: string;
    episode: {
      title: string;
      body: string;
      preview: string;
      motif?: string;
      observedFact?: string;
      characterObservation?: string;
    };
    operation: "append_episode" | "correct";
    supersedes?: string;
    mutationReason?: string;
  }): Promise<CharacterContextServiceResult<CharacterMemoryMutationResponse>> {
    const tags = [
      ...(input.episode.motif ? [{ type: "motif", value: input.episode.motif }] : []),
      ...(input.episode.observedFact ? [{ type: "evidence", value: "user-stated" }] : []),
      ...(input.episode.characterObservation ? [{ type: "evidence", value: "character-observation" }] : []),
    ];
    const result = await this.deps.memoryService.append(this.principal, {
      schemaVersion: MEMORY_V6_SCHEMA_VERSION,
      target: characterTarget(input.characterId),
      kind: "context",
      title: input.episode.title,
      body: input.episode.body,
      preview: input.episode.preview,
      tags,
      ...(input.supersedes ? { supersedes: [input.supersedes] } : {}),
      ...(input.mutationReason ? { mutationReason: input.mutationReason } : {}),
      idempotencyKey: input.idempotencyKey,
    });
    if (memoryError(result)) {
      return memoryErrorToContext(result, "unknown");
    }
    return {
      schemaVersion: CHARACTER_CONTEXT_SCHEMA_VERSION,
      characterId: input.characterId,
      operation: input.operation,
      entry: result.entry,
      ...(input.supersedes ? { previousEntryId: input.supersedes } : {}),
      created: result.created,
      replayed: !result.created,
      readBack: "active",
      sourceVersion: result.entry.updatedAt,
    };
  }

  private mapThrownError(
    error: unknown,
    operation: string,
    effect: "none" | "unknown",
  ): CharacterContextErrorResponse {
    if (error instanceof CharacterAffectVersionConflictError) {
      return createCharacterContextError("version_conflict", error.message, {
        field: "expectedVersion",
        retryable: true,
        conversationMayContinue: true,
        effect: "none",
        details: { expectedVersion: error.expectedVersion, actualVersion: error.actualVersion },
      });
    }
    if (error instanceof CharacterAffectEpisodePersistenceError) {
      return createCharacterContextError("partial_failure", "Character affect was saved, but its Memory episode did not converge.", {
        retryable: true,
        conversationMayContinue: true,
        effect: "committed",
        details: { eventId: error.eventId, memoryEpisodeLinked: false },
      });
    }
    if (error instanceof CharacterAffectIdempotencyConflictError) {
      return createCharacterContextError("invalid_input", error.message, {
        field: "idempotencyKey",
        retryable: false,
        conversationMayContinue: true,
        effect: "none",
      });
    }
    const message = error instanceof Error ? error.message : `${operation} failed.`;
    if (/not found|does not belong|owner|scope/i.test(message)) {
      return createCharacterContextError("unknown_scope", message, {
        retryable: false,
        conversationMayContinue: true,
        effect: "none",
      });
    }
    return createCharacterContextError("storage_unavailable", `${operation} failed.`, {
      retryable: true,
      conversationMayContinue: true,
      effect,
    });
  }

  private async runContextStage<T>(
    stage: CharacterContextUnexpectedErrorDiagnostic["stage"],
    transport: CharacterContextTransport,
    queryLength: number,
    searchTermCount: number,
    run: () => T | Promise<T>,
  ): Promise<T> {
    const startedAt = Date.now();
    try {
      return await run();
    } catch (error) {
      const diagnostic: CharacterContextUnexpectedErrorDiagnostic = {
        operation: "character_context.get",
        transport,
        stage,
        errorName: errorName(error),
        safeMessage: `Character context ${stage} failed.`,
        durationMs: Math.max(0, Date.now() - startedAt),
        queryLength,
        searchTermCount,
      };
      try {
        this.deps.onUnexpectedError?.(diagnostic);
      } catch {
        // Diagnostic reporting must not change the public error contract.
      }
      throw new CharacterContextStageError(stage, error);
    }
  }

  private async measure<T>(
    operation: string,
    transport: CharacterContextTransport,
    unexpectedFailureEffect: "none" | "unknown",
    run: () => Promise<CharacterContextServiceResult<T>>,
  ): Promise<CharacterContextServiceResult<T>> {
    const key = `${transport}:${operation}`;
    const metric = this.metrics.get(key) ?? {
      calls: 0,
      successes: 0,
      rejections: 0,
      failures: 0,
      idempotentReplays: 0,
      versionConflicts: 0,
      totalLatencyMs: 0,
      rejectionsByCode: {},
    };
    metric.calls += 1;
    const startedAt = Date.now();
    try {
      const result = await run();
      if (isCharacterContextError(result)) {
        if (result.error.code === "version_conflict") {
          metric.versionConflicts += 1;
        }
        if (result.error.code === "authority_denied" || result.error.code === "invalid_input") {
          metric.rejections += 1;
          metric.rejectionsByCode[result.error.code] = (metric.rejectionsByCode[result.error.code] ?? 0) + 1;
        } else {
          metric.failures += 1;
        }
      } else {
        metric.successes += 1;
        if ("replayed" in (result as object) && (result as { replayed?: boolean }).replayed) {
          metric.idempotentReplays += 1;
        }
        if ("saved" in (result as object) && Array.isArray((result as { saved?: unknown }).saved)) {
          metric.idempotentReplays += (result as CharacterAffectAppraiseResponse).saved
            .filter((candidate) => candidate.replayed).length;
        }
        if ("rejected" in (result as object) && Array.isArray((result as { rejected?: unknown }).rejected)) {
          for (const rejection of (result as CharacterAffectAppraiseResponse).rejected) {
            metric.rejections += 1;
            metric.rejectionsByCode[rejection.code] = (metric.rejectionsByCode[rejection.code] ?? 0) + 1;
          }
        }
      }
      return result;
    } catch (error) {
      const result = error instanceof CharacterContextValidationError
        ? createCharacterContextError("invalid_input", error.message, {
            field: error.field,
            retryable: false,
            conversationMayContinue: true,
            effect: "none",
          })
        : this.mapThrownError(error, operation, unexpectedFailureEffect);
      if (result.error.code === "invalid_input") {
        metric.rejections += 1;
        metric.rejectionsByCode[result.error.code] = (metric.rejectionsByCode[result.error.code] ?? 0) + 1;
      } else {
        metric.failures += 1;
      }
      return result;
    } finally {
      metric.totalLatencyMs += Date.now() - startedAt;
      this.metrics.set(key, metric);
    }
  }
}
