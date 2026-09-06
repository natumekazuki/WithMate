import type { Session } from "../src/session-state.js";
import type { SessionExecutionDispatchResult } from "./session-execution-service.js";
import type { ExternalSessionTurnResult } from "./session-runtime-service.js";

export async function runSessionExecutionDispatch(input: {
  runTurn(): Promise<ExternalSessionTurnResult>;
  isCanceled(): boolean;
}): Promise<SessionExecutionDispatchResult> {
  try {
    const outcome = await input.runTurn();
    if (outcome.terminalState === "canceled") {
      return {
        state: "canceled",
        result: null,
        reason: "user_requested",
        ...(outcome.providerTerminationPending ? { providerTerminationPending: true } : {}),
      };
    }
    if (outcome.terminalState === "failed") {
      return {
        state: "failed",
        result: null,
        errorCode: "PROVIDER_FAILURE",
        reason: "provider_turn_failed",
        ...(outcome.providerTerminationPending ? { providerTerminationPending: true } : {}),
      };
    }
    const session: Session = outcome.session;
    const assistantText = [...session.messages]
      .reverse()
      .find((message) => message.role === "assistant")?.text ?? "";
    return { state: "completed", result: { assistantText } };
  } catch (error) {
    if (input.isCanceled()) {
      return { state: "canceled", result: null, reason: "user_requested" };
    }
    throw error;
  }
}
