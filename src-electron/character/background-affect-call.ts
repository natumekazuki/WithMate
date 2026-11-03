import { buildAffectCompositionInput, type AffectCompositionInput } from "../../src-shared/character-affect/affect-composition.js";
import type { BackgroundCallInput, BackgroundCallService } from "../providers/background-call-service.js";

/** Registration happens through the tools of this same Agent invocation. */
export function runBackgroundAffectCall(
  calls: Pick<BackgroundCallService, "runOnce">,
  input: Omit<BackgroundCallInput, "userInput"> & AffectCompositionInput,
) {
  return calls.runOnce({
    context: input.context,
    selection: input.selection,
    onAdmitted: input.onAdmitted,
    userInput: buildAffectCompositionInput(input, input.context.scope),
  });
}
