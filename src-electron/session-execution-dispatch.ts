import type { Session } from "../src/session-state.js";
import type { SessionExecutionDispatchResult } from "./session-execution-service.js";

export async function runSessionExecutionDispatch(input: {
  runTurn(): Promise<Session>;
  isCanceled(): boolean;
}): Promise<SessionExecutionDispatchResult> {
  try {
    const session = await input.runTurn();
    if (session.runState === "error") {
      return {
        state: "failed",
        result: null,
        errorCode: "PROVIDER_FAILURE",
        reason: "provider_turn_failed",
      };
    }
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
