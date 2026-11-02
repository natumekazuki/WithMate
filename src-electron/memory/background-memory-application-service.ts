import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { ZodError } from "zod";
import type { BackgroundExecutionScope } from "../../src-shared/agent-runtime/background-execution-scope.js";
import { CHARACTER_CONTEXT_SCHEMA_VERSION } from "../../src-shared/character-context/character-context-contract.js";
import { MEMORY_V6_SCHEMA_VERSION, type MemoryEntryContent, type MemoryTargetSelector } from "../../src-shared/memory/memory-contract.js";
import { validateCharacterMemoryFinal, validateTargetMemoryFinal, type CharacterEpisodeCandidate,
  type MemoryRecordingEvidenceContext } from "../../src-shared/memory-recording/memory-recording-candidates.js";
import { getSessionIncarnationId, isReadOnlySession, type Session } from "../../src-shared/session/session-state.js";
import { matchesSessionHistorySource, type SessionHistoryReadScope } from "../../src-shared/session/session-history-read-scope.js";
import type { CharacterContextApplicationService } from "../character/character-context-application-service.js";
import { RuntimeTurnInactiveError, assertRuntimeTurnAdmission, runWithRuntimeTurnAdmission } from "../platform/memory/runtime-turn-admission.js";
import type { AgentRuntimeBindingRegistry } from "../providers/agent-runtime-binding.js";
import type { BackgroundExecution } from "../providers/background-execution-service.js";
import type { BackgroundSaveResult } from "../providers/background-call-service.js";
import type { ProviderAgentRuntimeTurnCoordinator } from "../providers/provider-agent-runtime-turn-coordinator.js";
import { StorageWorkerGenerationError, StorageWorkerRemoteError } from "../storage/storage-worker-client.js";
import type { MemoryV6SessionBindingPrincipal } from "./memory-v6-permission.js";
import type { MemoryV6Service } from "./memory-v6-service.js";

/** Captured by the app's authorized read, never assembled from model output. */
export type BackgroundMemoryContext = MemoryRecordingEvidenceContext & Readonly<{
  history: SessionHistoryReadScope;
  processing: BackgroundExecutionScope["processing"];
  allowedTargets: ReadonlyMap<string, MemoryTargetSelector>;
}>;

export type BackgroundMemoryMainSource = {
  session: Pick<Session, "id" | "incarnationId" | "characterId" | "accessMode" | "sourceSchemaVersion" | "sessionKind">;
  ownerIdentity: string;
};

export type BackgroundMemorySaved = {
  candidateIndex: number;
  entryId: string;
  created?: boolean;
  replayed?: boolean;
};

type Failure = { code: string; cause: "rejected" | "failed" | "unknown" | "canceled" | "revoked";
  candidateIndex: number | null; effect: "none" | "unknown" };
export type BackgroundMemoryResult =
  | { kind: "no_candidates" }
  | { kind: "saved"; saved: BackgroundMemorySaved[] }
  | { kind: "stopped"; saved: BackgroundMemorySaved[]; failure: Failure; unattemptedCandidateIndexes: number[] | null };

type Candidate = { target: MemoryTargetSelector } & (
  | { kind: "episode"; episode: CharacterEpisodeCandidate["episode"] }
  | { kind: "entry"; content: MemoryEntryContent }
);

class ScopeError extends Error {
  constructor(readonly code: string) { super(code); }
}

function errorCode(error: unknown): string {
  return error && typeof error === "object" && "code" in error && typeof error.code === "string"
    ? error.code : "MEMORY_SAVE_FAILED";
}

function responseFailure(error: { code: string; effect?: string }, candidateIndex: number): Failure {
  const knownRejection = /^(MEMORY_INVALID|MEMORY_UNAUTHORIZED|MEMORY_FORBIDDEN|MEMORY_PRINCIPAL_REQUIRED|MEMORY_TARGET_NOT_FOUND)/.test(error.code);
  const effect = error.effect === "none" || (error.effect === undefined && knownRejection) ? "none" : "unknown";
  return { candidateIndex, code: error.code, effect,
    cause: effect === "unknown" ? "unknown" : knownRejection || error.code === "authority_denied" || error.code === "invalid_input" ? "rejected" : "failed" };
}

export function toBackgroundMemorySaveResult(result: BackgroundMemoryResult): BackgroundSaveResult {
  if (result.kind === "no_candidates") return { kind: "none" };
  if (result.kind === "saved") return { kind: "saved", confirmedSavedCount: result.saved.length };
  return { kind: "stopped", confirmedSavedCount: result.saved.length, cause: result.failure.cause, code: result.failure.code };
}

/** Main-only trusted save orchestration. The caller retains ownership of the execution lifetime. */
export class BackgroundMemoryApplicationService {
  constructor(private readonly deps: {
    bindings: Pick<AgentRuntimeBindingRegistry, "resolveIdentity">;
    turns: Pick<ProviderAgentRuntimeTurnCoordinator, "admit">;
    readMainSource(scope: SessionHistoryReadScope): Promise<BackgroundMemoryMainSource | null>;
    characterService: Pick<CharacterContextApplicationService, "appendEpisode">;
    memoryService: Pick<MemoryV6Service, "append">;
  }) {}

  async apply(execution: BackgroundExecution, final: unknown, context: BackgroundMemoryContext): Promise<BackgroundMemoryResult> {
    let candidates: Candidate[] = [];
    let indexes: number[] | null = null;
    let principal: MemoryV6SessionBindingPrincipal;
    try {
      principal = await runWithRuntimeTurnAdmission(execution.admission, async () => {
        execution.signal.throwIfAborted();
        const resolved = this.deps.bindings.resolveIdentity(execution.binding.bindingReference);
        const binding = resolved.ok ? resolved.binding : null;
        const admitted = this.deps.turns.admit({ actorSessionId: execution.handle.actorSessionId,
          providerId: execution.handle.providerId, bindingId: execution.handle.bindingId,
          turnCapability: execution.handle.capability });
        if (!binding || binding.bindingId !== execution.binding.bindingId || binding.bindingId !== execution.handle.bindingId
          || binding.executionGeneration !== execution.binding.executionGeneration
          || binding.actorSessionId !== execution.handle.actorSessionId || binding.providerId !== execution.handle.providerId
          || !admitted.ok || admitted.handle !== execution.handle || execution.admission.state !== execution.handle.revocationState
          || binding.authoritySnapshot.userId !== "local-user" || typeof binding.authoritySnapshot.characterId !== "string"
          || !binding.authoritySnapshot.characterId || !binding.backgroundScope
          || (binding.backgroundScope.purpose !== "character-memory" && binding.backgroundScope.purpose !== "target-memory")) {
          throw new ScopeError("MEMORY_BACKGROUND_AUTHORITY_DENIED");
        }
        const scope = binding.backgroundScope;
        if (scope.history.source.kind !== "main") throw new ScopeError("MEMORY_BACKGROUND_UNSUPPORTED_SOURCE");
        if (!isDeepStrictEqual(context.history, scope.history) || !isDeepStrictEqual(context.processing, scope.processing)
          || [...context.allowedTargets.values()].some((target) => target.owner === "character" && target.character.id !== binding.authoritySnapshot.characterId
            || !scope.memoryTargets.some((allowed) => isDeepStrictEqual(target, allowed)))) {
          throw new ScopeError("MEMORY_BACKGROUND_CONTEXT_DENIED");
        }
        const characterId = binding.authoritySnapshot.characterId;
        if (scope.purpose === "character-memory") {
          const target = { owner: "character", scope: "character", character: { type: "id", id: characterId } } as const;
          if (!scope.memoryTargets.some((allowed) => isDeepStrictEqual(target, allowed))) throw new ScopeError("MEMORY_BACKGROUND_TARGET_DENIED");
          const output = validateCharacterMemoryFinal(final, { ...context, target }).final;
          if (output.outcome === "candidates") candidates = output.episodes.map(({ episode }) => ({ kind: "episode", episode, target }));
        } else {
          const output = validateTargetMemoryFinal(final, context);
          if (output.outcome === "candidates") candidates = output.entries.map(({ target, ...content }) => ({ kind: "entry", content, target }));
        }
        indexes = candidates.map((_, index) => index);
        const source = await this.deps.readMainSource(scope.history);
        assertRuntimeTurnAdmission();
        if (!source) throw new ScopeError("MEMORY_BACKGROUND_SOURCE_UNAVAILABLE");
        const session = source.session;
        if (session.id !== binding.actorSessionId || session.id !== scope.history.source.sessionId
          || !matchesSessionHistorySource(scope.history.source, { incarnationId: getSessionIncarnationId(session), ownerIdentity: source.ownerIdentity })
          || session.characterId !== characterId || isReadOnlySession(session) || session.sessionKind === "character-authoring") {
          throw new ScopeError("MEMORY_BACKGROUND_SOURCE_DENIED");
        }
        return { type: "session_binding", bindingIdHash: binding.bindingIdHash, sessionId: session.id,
          providerId: binding.providerId, characterId, permissions: ["memory.append"] };
      });
    } catch (error) {
      const canceled = execution.signal.aborted || error instanceof RuntimeTurnInactiveError;
      return { kind: "stopped", saved: [], failure: { candidateIndex: null, effect: "none",
        code: canceled ? "RUNTIME_TURN_INACTIVE" : error instanceof ZodError ? "MEMORY_BACKGROUND_INVALID_OUTPUT"
          : error instanceof ScopeError ? error.code : "MEMORY_BACKGROUND_SOURCE_UNAVAILABLE",
        cause: canceled ? execution.signal.aborted ? "canceled" : "revoked" : error instanceof ZodError || error instanceof ScopeError ? "rejected" : "failed" },
      unattemptedCandidateIndexes: indexes };
    }
    if (candidates.length === 0) return { kind: "no_candidates" };
    const saved: BackgroundMemorySaved[] = [];
    for (const [candidateIndex, candidate] of candidates.entries()) {
      let saveStarted = false;
      try {
        const result = await runWithRuntimeTurnAdmission(execution.admission, () => {
          execution.signal.throwIfAborted();
          saveStarted = true;
          const idempotencyKey = randomUUID();
          return candidate.kind === "episode"
            ? this.deps.characterService.appendEpisode({ schemaVersion: CHARACTER_CONTEXT_SCHEMA_VERSION,
              characterId: principal.characterId, sessionId: principal.sessionId, authority: { kind: "conversation" },
              idempotencyKey, episode: candidate.episode }, "internal", principal)
            : this.deps.memoryService.append(principal, { schemaVersion: MEMORY_V6_SCHEMA_VERSION, target: candidate.target,
              kind: candidate.content.kind, title: candidate.content.title, body: candidate.content.body, preview: candidate.content.preview,
              tags: candidate.content.tags.map(({ type, value }) => ({ type, value })), idempotencyKey });
        });
        if ("error" in result) {
          const failure = responseFailure(result.error, candidateIndex);
          if (failure.effect === "none" && (execution.signal.aborted || Atomics.load(new Int32Array(execution.admission.state), 0) !== 0)) {
            failure.cause = execution.signal.aborted ? "canceled" : "revoked";
          }
          return { kind: "stopped", saved, failure, unattemptedCandidateIndexes: indexes!.slice(candidateIndex + 1) };
        }
        if (!result.entry) throw new Error("Memory append returned no confirmed entry.");
        saved.push({ candidateIndex, entryId: result.entry.id, created: result.created, replayed: result.replayed });
      } catch (error) {
        const inactive = error instanceof RuntimeTurnInactiveError;
        const none = !saveStarted || inactive || error instanceof StorageWorkerGenerationError
          || error instanceof StorageWorkerRemoteError && error.outcome !== "unknown";
        return { kind: "stopped", saved, failure: { candidateIndex, effect: none ? "none" : "unknown",
          code: inactive ? "RUNTIME_TURN_INACTIVE" : error instanceof StorageWorkerGenerationError ? "STORAGE_WORKER_GENERATION_INACTIVE" : errorCode(error),
          cause: inactive || !saveStarted && execution.signal.aborted ? execution.signal.aborted ? "canceled" : "revoked" : none ? "failed" : "unknown" },
        unattemptedCandidateIndexes: indexes!.slice(candidateIndex + 1) };
      }
    }
    return { kind: "saved", saved };
  }
}
