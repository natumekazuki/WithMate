import type { CharacterContextErrorResponse } from "../src/character-context/character-context-contract.js";
import type {
  CharacterAffectTurnFailureDiagnostic,
  CharacterAffectTurnFailureStage,
} from "./character-affect-turn-settlement-storage.js";

const CONTEXT_STAGE_MAP = {
  affect_state: "context_affect_state",
  memory_search: "context_memory_search",
  response_assembly: "context_response_assembly",
} as const;

export function resolveCharacterAffectTurnContextFailureStage(
  response: CharacterContextErrorResponse,
): CharacterAffectTurnFailureStage {
  const failureStage = response.error.details?.failureStage;
  return typeof failureStage === "string" && failureStage in CONTEXT_STAGE_MAP
    ? CONTEXT_STAGE_MAP[failureStage as keyof typeof CONTEXT_STAGE_MAP]
    : "context_response_assembly";
}

export function createCharacterAffectTurnFailureDiagnostic(input: {
  code: string;
  stage: CharacterAffectTurnFailureStage;
  error?: unknown;
  durationMs: number;
}): CharacterAffectTurnFailureDiagnostic {
  const rawErrorName = input.error instanceof Error && input.error.name.trim()
    ? input.error.name.trim()
    : input.error === undefined
      ? "CharacterContextError"
      : "UnknownError";
  const errorName = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(rawErrorName)
    ? rawErrorName
    : "UnknownError";
  return {
    code: input.code,
    stage: input.stage,
    errorName,
    safeMessage: `Character affect turn ${input.stage} failed with ${input.code}.`,
    durationMs: Math.max(0, Math.floor(input.durationMs)),
  };
}

export function characterAffectTurnThrownFailureCode(
  error: unknown,
  stage: CharacterAffectTurnFailureStage,
): string {
  if (error instanceof Error && error.name === "AbortError") {
    return stage === "evaluation" ? "provider_timeout" : "operation_aborted";
  }
  return "unexpected_failure";
}

export function createCharacterAffectTurnRecoveryFailureLogData(error: unknown): {
  code: string;
  stage: CharacterAffectTurnFailureStage;
  errorName: string;
} {
  const diagnostic = createCharacterAffectTurnFailureDiagnostic({
    code: "recovery_failure",
    stage: "runtime",
    error,
    durationMs: 0,
  });
  return {
    code: diagnostic.code,
    stage: diagnostic.stage,
    errorName: diagnostic.errorName,
  };
}
