import type { AppSettings } from "../../src-shared/settings/provider-settings-state.js";
import type { ProviderBackgroundAdapter } from "../providers/provider-runtime.js";
import type { AppLogService } from "../app/app-log-service.js";
import { getSessionIncarnationId, type SessionSummary } from "../../src-shared/session/session-state.js";
import type { SessionMetadataResult, SessionMessageIdentityInput, SessionMessageIdentity } from "../session/session-runtime-storage-contract.js";
import type { CharacterRuntimeSnapshot } from "../../src-shared/character/character-catalog.js";
import { CHARACTER_CONTEXT_SCHEMA_VERSION, isCharacterContextError } from "../../src-shared/character-context/character-context-contract.js";
import {
  buildCharacterAffectTurnPrompt,
  normalizeCharacterAffectTurnEvaluation,
  toAffectEventInputs,
} from "./character-affect-turn-evaluator.js";
import { settleCharacterAffectTurnWithRetry } from "./character-affect-turn-settler.js";
import {
  characterAffectTurnThrownFailureCode,
  createCharacterAffectTurnFailureDiagnostic,
  createCharacterAffectTurnRecoveryFailureLogData,
  resolveCharacterAffectTurnContextFailureStage,
} from "./character-affect-turn-recovery.js";
import { drainCharacterAffectTurnSettlementBatch, type CharacterAffectTurnDrainCursor } from "./character-affect-turn-drain.js";
import {
  hasSettlementSessionOwner,
  type PendingCharacterAffectTurnSettlement,
  type CharacterAffectTurnFailureStage,
  type CharacterAffectTurnSettlementStorageAccess,
} from "./character-affect-turn-settlement-storage.js";
import type { MemoryV6RuntimeApiHandle } from "../memory/memory-v6-runtime.js";
import type { Awaitable } from "../storage/persistent-store-lifecycle-service.js";

export type CharacterAffectTurnLifecycleRuntime = {
  characterContextService: Pick<MemoryV6RuntimeApiHandle["characterContextService"], "getContext" | "appraise">;
};

export function createCharacterAffectTurnMainLifecycle(deps: {
  getSettlementStorage(): Awaitable<CharacterAffectTurnSettlementStorageAccess | null>;
  getRuntimeApi(): CharacterAffectTurnLifecycleRuntime | null;
  getCharacterSnapshot(characterId: string): Awaitable<CharacterRuntimeSnapshot | null>;
  getAppSettings(): Awaitable<AppSettings>;
  getProviderBackgroundAdapter(providerId: string | null | undefined): Pick<ProviderBackgroundAdapter, "runBackgroundStructuredPrompt">;
  getSessionMetadata(sessionId: string): Promise<SessionMetadataResult | null>;
  getSessionMessageIdentity(input: SessionMessageIdentityInput): Promise<SessionMessageIdentity | null>;
  startupRecoveryCutoff: string;
  runAppraisalExclusive<T>(operation: () => T | Promise<T>): Promise<T>;
  writeAppLog(log: Parameters<AppLogService["write"]>[0]): void;
  getDrainCursor(): CharacterAffectTurnDrainCursor | undefined;
  setDrainCursor(cursor: CharacterAffectTurnDrainCursor | undefined): void;
}) {
  const requireStorage = async () => {
    const storage = await deps.getSettlementStorage();
    if (!storage) {
      throw new Error("Character affect turn settlement storage is not initialized.");
    }
    return storage;
  };

  async function settleCharacterAffectTurn(item: PendingCharacterAffectTurnSettlement): Promise<boolean> {
    const request = item;
    let sessionForLog: SessionSummary | null = null;
    const settlementStorage = await requireStorage();
    const attemptCount = await settlementStorage.recordAttempt(request.correlationId);
    if (attemptCount === null) {
      return true;
    }
    const runtimeApi = deps.getRuntimeApi();
    const isCurrentGeneration = async () => settlementStorage === await deps.getSettlementStorage()
      && runtimeApi === deps.getRuntimeApi();
    const reportInvalidatedSettlement = async (): Promise<boolean> => {
      if (settlementStorage === await deps.getSettlementStorage()) {
        await settlementStorage.recoverInterruptedAttempts(new Date().toISOString(), request.correlationId);
      }
      deps.writeAppLog({
        level: "info",
        kind: "character-affect.lifecycle.settlement-invalidated",
        process: "main",
        message: "Character affect settlement stopped after its storage or runtime was replaced",
        data: { sessionId: item.sessionId, correlationId: request.correlationId },
      });
      return true;
    };
    let activeStage: CharacterAffectTurnFailureStage = "runtime";
    let stageStartedAt = Date.now();
    let dispositionFailure: unknown;
    const recordFailure = async (input: {
      code: string;
      retryable: boolean;
      effect?: string;
      error?: unknown;
    }): Promise<boolean> => {
      if (!await isCurrentGeneration()) {
        return reportInvalidatedSettlement();
      }
      const diagnostic = createCharacterAffectTurnFailureDiagnostic({
        code: input.code,
        stage: activeStage,
        error: input.error,
        durationMs: Date.now() - stageStartedAt,
      });
      let disposition: Awaited<ReturnType<CharacterAffectTurnSettlementStorageAccess["recordFailure"]>>;
      try {
        disposition = await settlementStorage.recordFailure({
          correlationId: request.correlationId,
          retryable: input.retryable,
          diagnostic,
        });
      } catch (error) {
        dispositionFailure = error;
        await settlementStorage.recoverInterruptedAttempts(new Date().toISOString(), request.correlationId);
        throw error;
      }
      deps.writeAppLog({
        level: "warn",
        kind: disposition.state === "quarantined"
          ? "character-affect.lifecycle.settlement-quarantined"
          : "character-affect.lifecycle.settlement-deferred",
        process: "main",
        message: disposition.state === "quarantined"
          ? "Character affect appraisal was quarantined after a bounded failure"
          : "Character affect appraisal was deferred after a retryable failure",
        data: {
          sessionId: item.sessionId,
          correlationId: request.correlationId,
          provider: sessionForLog?.provider,
          model: sessionForLog?.model,
          userMessageLength: request.userMessage.length,
          assistantMessageLength: request.assistantMessage.length,
          attemptCount: disposition.attemptCount,
          code: diagnostic.code,
          retryable: input.retryable,
          effect: input.effect ?? "none",
          stage: diagnostic.stage,
          errorName: diagnostic.errorName,
          durationMs: diagnostic.durationMs,
          nextAttemptAt: disposition.nextAttemptAt,
          quarantinedAt: disposition.quarantinedAt,
        },
      });
      return disposition.state === "quarantined";
    };
    try {
      const getCommittedOwner = async () => {
        const current = await deps.getSessionMetadata(item.sessionId);
        if (!await isCurrentGeneration() || !current || !hasSettlementSessionOwner(current.summary, item)) return null;
        const message = await deps.getSessionMessageIdentity({
          sessionId: item.sessionId,
          incarnationId: getSessionIncarnationId(current.summary),
          messageIndex: item.assistantMessageIndex,
        });
        return message?.role === "assistant" && message.text === item.assistantMessage ? current : null;
      };
      const metadata = await getCommittedOwner();
      if (!await isCurrentGeneration()) return reportInvalidatedSettlement();
      if (!metadata || metadata.summary.sessionKind !== "default" || !metadata.summary.characterId) {
        await settlementStorage.markDiscarded(item.correlationId);
        return true;
      }
      const session = { ...metadata.summary, characterRuntimeSnapshot: metadata.characterRuntimeSnapshot };
      sessionForLog = session;
      if (!runtimeApi) return recordFailure({ code: "runtime_unavailable", retryable: true });
      const character = session.characterRuntimeSnapshot ?? await deps.getCharacterSnapshot(session.characterId);
      if (!character) return recordFailure({ code: "unknown_character", retryable: false });
      const settlement = await settleCharacterAffectTurnWithRetry({
        correlationId: request.correlationId,
        isCurrentGeneration,
        getPending: () => settlementStorage.getPending(request.correlationId),
        getContext: async () => {
          activeStage = "context_response_assembly";
          stageStartedAt = Date.now();
          const result = await runtimeApi.characterContextService.getContext({
            schemaVersion: CHARACTER_CONTEXT_SCHEMA_VERSION,
            characterId: session.characterId!,
            sessionId: session.id,
            query: request.userMessage,
            memoryLimit: 3,
          }, "lifecycle");
          if (isCharacterContextError(result)) {
            activeStage = resolveCharacterAffectTurnContextFailureStage(result);
          }
          return result;
        },
        evaluate: async (context, idempotencyPrefix) => {
          activeStage = "evaluation";
          stageStartedAt = Date.now();
          const backgroundAdapter = deps.getProviderBackgroundAdapter(session.provider);
          const prompt = buildCharacterAffectTurnPrompt({
            character,
            context,
            userMessage: request.userMessage,
            assistantMessage: request.assistantMessage,
          });
          const evaluationResult = await backgroundAdapter.runBackgroundStructuredPrompt({
            providerId: session.provider,
            workspacePath: session.workspacePath,
            appSettings: await deps.getAppSettings(),
            model: session.model,
            reasoningEffort: session.reasoningEffort,
            timeoutMs: 15_000,
            approvalMode: session.approvalMode,
            codexSandboxMode: session.codexSandboxMode,
            prompt,
          });
          const evaluation = normalizeCharacterAffectTurnEvaluation(
            evaluationResult.output ?? evaluationResult.structuredOutput ?? evaluationResult.parsedJson,
          );
          if (!evaluation) {
            throw new Error("Character affect evaluator returned an invalid structured result.");
          }
          return toAffectEventInputs({
            evaluation,
            characterId: session.characterId!,
            sessionId: session.id,
            userId: "local-user",
            occurredAt: request.occurredAt,
            idempotencyPrefix,
          });
        },
        persistEvaluation: async (input) => {
          await settlementStorage.saveEvaluation({ correlationId: request.correlationId, ...input });
        },
        appraise: (expectedVersion, candidates) => {
          activeStage = "appraisal";
          stageStartedAt = Date.now();
          return runtimeApi.characterContextService.appraise({
            schemaVersion: CHARACTER_CONTEXT_SCHEMA_VERSION,
            characterId: session.characterId!,
            sessionId: session.id,
            expectedVersion,
            authority: { kind: "conversation" },
            candidates,
          }, "lifecycle");
        },
        recordAppraisalFailure: async (input) => {
          return await settlementStorage.recordAppraisalFailure({ correlationId: request.correlationId, ...input });
        },
        runAppraisalExclusive: deps.runAppraisalExclusive,
        validateOwner: async () => await getCommittedOwner() !== null,
        markDiscarded: async () => {
          await settlementStorage.markDiscarded(request.correlationId);
        },
        markSettled: async () => {
          await settlementStorage.markSettled(request.correlationId);
        },
      });
      if (settlement.status === "invalidated") {
        return reportInvalidatedSettlement();
      }
      if (settlement.status === "pending") {
        if (settlement.phase === "appraisal") {
          activeStage = "appraisal";
        }
        return recordFailure({
          code: settlement.error.error.code,
          retryable: settlement.error.error.retryable,
          effect: settlement.error.error.effect,
        });
      }
      if (settlement.appraisal && settlement.appraisal.rejected.length > 0) {
        deps.writeAppLog({
          level: "warn",
          kind: "character-affect.lifecycle.candidate-rejected",
          process: "main",
          message: "One or more Character affect candidates were rejected",
          data: {
            sessionId: session.id,
            rejected: settlement.appraisal.rejected.map((candidate) => ({
              candidateIndex: candidate.candidateIndex,
              code: candidate.code,
            })),
          },
        });
      }
      return true;
    } catch (error) {
      if (error === dispositionFailure) {
        throw error;
      }
      return recordFailure({
        code: characterAffectTurnThrownFailureCode(error, activeStage),
        retryable: true,
        error,
      });
    }
  }

  async function drainPendingCharacterAffectTurns(): Promise<boolean> {
    const settlementStorage = await requireStorage();
    const result = await drainCharacterAffectTurnSettlementBatch({
      storage: settlementStorage,
      isCurrentGeneration: async () => settlementStorage === await deps.getSettlementStorage(),
      startupRecoveryCutoff: deps.startupRecoveryCutoff,
      readyCursor: deps.getDrainCursor(),
      getSessionMetadata: deps.getSessionMetadata,
      getSessionMessageIdentity: deps.getSessionMessageIdentity,
      settle: async (item) => settlementStorage !== await deps.getSettlementStorage()
        ? true
        : settleCharacterAffectTurn(item),
      onDiscard: (item) => {
        deps.writeAppLog({
          level: "warn",
          kind: "character-affect.lifecycle.recovery-discarded",
          process: "main",
          message: "Pending Character affect appraisal had no committed Session owner",
          data: { sessionId: item.sessionId },
        });
      },
      onFailure: (item, error) => {
        deps.writeAppLog({
          level: "warn",
          kind: "character-affect.lifecycle.recovery-failed",
          process: "main",
          message: "Pending Character affect appraisal remains available for recovery",
          data: {
            sessionId: item.sessionId,
            correlationId: item.correlationId,
            ...createCharacterAffectTurnRecoveryFailureLogData(error),
          },
        });
      },
    }).catch(async (error: unknown) => {
      if (settlementStorage !== await deps.getSettlementStorage()) {
        return { retryRequired: await deps.getSettlementStorage() !== null, nextReadyCursor: undefined };
      }
      throw error;
    });
    if (settlementStorage !== await deps.getSettlementStorage()) {
      return await deps.getSettlementStorage() !== null;
    }
    deps.setDrainCursor(result.nextReadyCursor);
    return result.retryRequired;
  }

  return { drain: drainPendingCharacterAffectTurns };
}
