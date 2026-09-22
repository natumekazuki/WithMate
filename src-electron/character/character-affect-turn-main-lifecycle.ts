import type { AppSettings } from "../../src-shared/settings/provider-settings-state.js";
import type { ProviderBackgroundAdapter } from "../providers/provider-runtime.js";
import type { AppLogService } from "../app/app-log-service.js";
import { getSessionIncarnationId, type Session } from "../../src-shared/session/session-state.js";
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
  hasCommittedAssistantMessage,
  type CharacterAffectTurnFailureStage,
  type CharacterAffectTurnSettlementStorageAccess,
} from "./character-affect-turn-settlement-storage.js";
import type { MemoryV6RuntimeApiHandle } from "../memory/memory-v6-runtime.js";
import type { Awaitable } from "../storage/persistent-store-lifecycle-service.js";

type CharacterAffectTurnSettlementRequest = {
  session: Session;
  correlationId: string;
  userMessage: string;
  assistantMessage: string;
  assistantMessageIndex: number;
  occurredAt: string;
};

export type CharacterAffectTurnLifecycleRuntime = {
  characterContextService: Pick<MemoryV6RuntimeApiHandle["characterContextService"], "getContext" | "appraise">;
};

export function createCharacterAffectTurnMainLifecycle(deps: {
  getSettlementStorage(): Awaitable<CharacterAffectTurnSettlementStorageAccess | null>;
  getRuntimeApi(): CharacterAffectTurnLifecycleRuntime | null;
  getCharacterSnapshot(characterId: string): Awaitable<CharacterRuntimeSnapshot | null>;
  getAppSettings(): Awaitable<AppSettings>;
  getProviderBackgroundAdapter(providerId: string | null | undefined): Pick<ProviderBackgroundAdapter, "runBackgroundStructuredPrompt">;
  getSession(sessionId: string): Promise<Session | null>;
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

  async function settleCharacterAffectTurn(request: CharacterAffectTurnSettlementRequest): Promise<boolean> {
    if (request.session.sessionKind !== "default" || !request.session.characterId) {
      return true;
    }
    const settlementStorage = await requireStorage();
    if (!hasCommittedAssistantMessage(request.session.messages, request)) {
      await settlementStorage.markDiscarded(request.correlationId);
      return true;
    }
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
        data: { sessionId: request.session.id, correlationId: request.correlationId },
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
          sessionId: request.session.id,
          correlationId: request.correlationId,
          provider: request.session.provider,
          model: request.session.model,
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
    if (!runtimeApi) {
      return recordFailure({ code: "runtime_unavailable", retryable: true });
    }
    const character = request.session.characterRuntimeSnapshot
      ?? await deps.getCharacterSnapshot(request.session.characterId);
    if (!character) {
      return recordFailure({ code: "unknown_character", retryable: false });
    }

    try {
      const settlement = await settleCharacterAffectTurnWithRetry({
        correlationId: request.correlationId,
        isCurrentGeneration,
        getPending: () => settlementStorage.getPending(request.correlationId),
        getContext: async () => {
          activeStage = "context_response_assembly";
          stageStartedAt = Date.now();
          const result = await runtimeApi.characterContextService.getContext({
            schemaVersion: CHARACTER_CONTEXT_SCHEMA_VERSION,
            characterId: request.session.characterId!,
            sessionId: request.session.id,
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
          const backgroundAdapter = deps.getProviderBackgroundAdapter(request.session.provider);
          const prompt = buildCharacterAffectTurnPrompt({
            character,
            context,
            userMessage: request.userMessage,
            assistantMessage: request.assistantMessage,
          });
          const evaluationResult = await backgroundAdapter.runBackgroundStructuredPrompt({
            providerId: request.session.provider,
            workspacePath: request.session.workspacePath,
            appSettings: await deps.getAppSettings(),
            model: request.session.model,
            reasoningEffort: request.session.reasoningEffort,
            timeoutMs: 15_000,
            approvalMode: request.session.approvalMode,
            codexSandboxMode: request.session.codexSandboxMode,
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
            characterId: request.session.characterId!,
            sessionId: request.session.id,
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
            characterId: request.session.characterId!,
            sessionId: request.session.id,
            expectedVersion,
            authority: { kind: "conversation" },
            candidates,
          }, "lifecycle");
        },
        recordAppraisalFailure: async (input) => {
          return await settlementStorage.recordAppraisalFailure({ correlationId: request.correlationId, ...input });
        },
        runAppraisalExclusive: deps.runAppraisalExclusive,
        validateOwner: async () => {
          const currentSession = await deps.getSession(request.session.id);
          return Boolean(
            currentSession
            && getSessionIncarnationId(currentSession) === getSessionIncarnationId(request.session)
            && currentSession.characterId === request.session.characterId
            && hasCommittedAssistantMessage(currentSession.messages, request),
          );
        },
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
            sessionId: request.session.id,
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
      getSession: deps.getSession,
      settle: async (item, session) => settlementStorage !== await deps.getSettlementStorage()
        ? true
        : settleCharacterAffectTurn({
          session,
          correlationId: item.correlationId,
          userMessage: item.userMessage,
          assistantMessage: item.assistantMessage,
          assistantMessageIndex: item.assistantMessageIndex,
          occurredAt: item.occurredAt,
        }),
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
