import { z } from "zod";
import {
  AFFECT_COMPOSITION_INSTRUCTIONS, affectCompositionOutputSchema, validateAffectCompositionOutput,
  type AffectCompositionOutput,
} from "../../src-shared/character-affect/affect-composition.js";
import type {
  BackgroundCallInput, BackgroundCallResult, BackgroundCallService, BackgroundSaveResult,
} from "../providers/background-call-service.js";
import type { BackgroundAffectApplicationService } from "./background-affect-application-service.js";

export type BackgroundAffectCallInput = Omit<BackgroundCallInput<AffectCompositionOutput>, "final" | "save">;

const finalSchema = z.toJSONSchema(affectCompositionOutputSchema, { io: "input" });

/** Purpose-specific composition only; the common call owns generation and execution lifetime. */
export class BackgroundAffectCallService {
  constructor(private readonly deps: {
    calls: Pick<BackgroundCallService, "runOnce">;
    application: Pick<BackgroundAffectApplicationService, "apply">;
  }) {}

  runOnce(input: BackgroundAffectCallInput): Promise<BackgroundCallResult> {
    return this.deps.calls.runOnce({
      ...input,
      userInput: `${AFFECT_COMPOSITION_INSTRUCTIONS}\n\n${input.userInput}`,
      final: { schema: finalSchema, parse: validateAffectCompositionOutput },
      save: async (output, execution): Promise<BackgroundSaveResult> => {
        const result = await this.deps.application.apply(execution, output);
        if (result.kind === "no_change") return { kind: "none" };
        const confirmedSavedCount = result.saved.length;
        if (result.kind === "saved") return { kind: "saved", confirmedSavedCount };
        const { code, effect } = result.failure;
        const cause = effect === "unknown" ? "unknown" : code === "canceled" ? "revoked"
          : code === "save_failed" || code === "source_unavailable" ? "failed" : "rejected";
        return { kind: "stopped", confirmedSavedCount, cause, code };
      },
    });
  }
}
