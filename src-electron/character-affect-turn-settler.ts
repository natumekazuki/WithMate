import type {
  CharacterAffectAppraiseResponse,
  CharacterContextErrorResponse,
  CharacterContextResponse,
} from "../src/character-context/character-context-contract.js";
import { isCharacterContextError } from "../src/character-context/character-context-contract.js";
import type { AffectEventInput } from "../src/character-affect/affect-contract.js";

export type CharacterAffectTurnSettlementResult =
  | { status: "settled"; appraisal: CharacterAffectAppraiseResponse | null }
  | { status: "pending"; error: CharacterContextErrorResponse };

export async function settleCharacterAffectTurnWithRetry(deps: {
  getContext(): Promise<CharacterContextResponse | CharacterContextErrorResponse>;
  evaluate(context: CharacterContextResponse): Promise<AffectEventInput[]>;
  appraise(
    context: CharacterContextResponse,
    candidates: AffectEventInput[],
  ): Promise<CharacterAffectAppraiseResponse | CharacterContextErrorResponse>;
  markSettled(): void;
}): Promise<CharacterAffectTurnSettlementResult> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const context = await deps.getContext();
    if (isCharacterContextError(context)) {
      return { status: "pending", error: context };
    }
    const candidates = await deps.evaluate(context);
    if (candidates.length === 0) {
      deps.markSettled();
      return { status: "settled", appraisal: null };
    }
    const appraisal = await deps.appraise(context, candidates);
    if (isCharacterContextError(appraisal)) {
      if (appraisal.error.code === "version_conflict" && attempt === 0) {
        continue;
      }
      return { status: "pending", error: appraisal };
    }
    deps.markSettled();
    return { status: "settled", appraisal };
  }
  throw new Error("Character affect turn settlement exhausted its bounded retry unexpectedly.");
}
