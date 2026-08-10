import type { AffectEventInput } from "../src/character-affect/affect-contract.js";
import type {
  CharacterAffectAppraiseResponse,
  CharacterContextErrorResponse,
  CharacterContextResponse,
} from "../src/character-context/character-context-contract.js";
import { isCharacterContextError } from "../src/character-context/character-context-contract.js";
import type {
  CharacterAffectTurnAppraisalEffect,
  PendingCharacterAffectTurnSettlement,
} from "./character-affect-turn-settlement-storage.js";

export type CharacterAffectTurnSettlementResult =
  | { status: "settled"; appraisal: CharacterAffectAppraiseResponse | null }
  | { status: "pending"; error: CharacterContextErrorResponse };

export function characterAffectTurnIdempotencyPrefix(
  correlationId: string,
  evaluationAttempt: number,
): string {
  return evaluationAttempt === 0
    ? correlationId
    : `${correlationId}:evaluation:${evaluationAttempt}`;
}

function appraisalEffect(error: CharacterContextErrorResponse): CharacterAffectTurnAppraisalEffect {
  return error.error.effect ?? "unknown";
}

function savedCandidateIndices(error: CharacterContextErrorResponse): number[] {
  const details = error.error.details;
  const saved = Array.isArray(details?.saved) ? details.saved : [];
  const indices = saved.flatMap((item) => {
    if (!item || typeof item !== "object") {
      return [];
    }
    const candidateIndex = (item as { candidateIndex?: unknown }).candidateIndex;
    return Number.isInteger(candidateIndex) ? [candidateIndex as number] : [];
  });
  const failedCandidateIndex = details?.failedCandidateIndex;
  if (Number.isInteger(failedCandidateIndex) && error.error.effect === "committed") {
    indices.push(failedCandidateIndex as number);
  }
  return [...new Set(indices)].sort((a, b) => a - b);
}

export async function settleCharacterAffectTurnWithRetry(deps: {
  correlationId: string;
  getPending(): PendingCharacterAffectTurnSettlement | null;
  getContext(): Promise<CharacterContextResponse | CharacterContextErrorResponse>;
  evaluate(context: CharacterContextResponse, idempotencyPrefix: string): Promise<AffectEventInput[]>;
  persistEvaluation(input: {
    evaluationAttempt: number;
    expectedVersion: string;
    candidates: AffectEventInput[];
  }): void;
  appraise(
    expectedVersion: string,
    candidates: AffectEventInput[],
  ): Promise<CharacterAffectAppraiseResponse | CharacterContextErrorResponse>;
  recordAppraisalFailure(input: {
    evaluationAttempt: number;
    effect: CharacterAffectTurnAppraisalEffect;
    savedCandidateIndices: number[];
    prepareReevaluation: boolean;
  }): { reevaluationPrepared: boolean };
  markSettled(): void;
}): Promise<CharacterAffectTurnSettlementResult> {
  let pending = deps.getPending();
  if (!pending) {
    return { status: "settled", appraisal: null };
  }

  if (!pending.evaluation) {
    const context = await deps.getContext();
    if (isCharacterContextError(context)) {
      return { status: "pending", error: context };
    }
    const candidates = await deps.evaluate(
      context,
      characterAffectTurnIdempotencyPrefix(deps.correlationId, pending.evaluationAttempt),
    );
    deps.persistEvaluation({
      evaluationAttempt: pending.evaluationAttempt,
      expectedVersion: context.affect.version,
      candidates,
    });
    pending = deps.getPending();
    if (!pending?.evaluation) {
      throw new Error("Character affect turn evaluation was not readable after persistence.");
    }
  }

  const evaluation = pending.evaluation;
  if (evaluation.candidates.length === 0) {
    deps.markSettled();
    return { status: "settled", appraisal: null };
  }

  const appraisal = await deps.appraise(evaluation.expectedVersion, evaluation.candidates);
  if (!isCharacterContextError(appraisal)) {
    deps.markSettled();
    return { status: "settled", appraisal };
  }

  const effect = appraisalEffect(appraisal);
  deps.recordAppraisalFailure({
    evaluationAttempt: evaluation.evaluationAttempt,
    effect,
    savedCandidateIndices: savedCandidateIndices(appraisal),
    prepareReevaluation: appraisal.error.code === "version_conflict" && effect === "none",
  });
  return { status: "pending", error: appraisal };
}
