import type { SessionRuntimePublicExecution } from "../src/session-external-runtime-contract.js";

export function projectTerminalFailureNotificationPrompt(input: {
  sourceSessionId: string;
  sourceExecution: SessionRuntimePublicExecution;
}): string {
  const execution = input.sourceExecution;
  if (execution.state !== "failed" && execution.state !== "interrupted") {
    throw new TypeError("Terminal failure notification requires a failed or interrupted source execution.");
  }
  const terminalAt = execution.completedAt ?? execution.updatedAt;
  const errorCode = execution.errorCode || "none";
  const reason = execution.reason || "none";
  return [
    "WithMate Session execution terminal failure notification",
    `Source Session ID: ${input.sourceSessionId}`,
    `Source execution ID: ${execution.id}`,
    `Terminal state: ${execution.state}`,
    `Terminal timestamp: ${terminalAt}`,
    `Safe error code: ${errorCode}`,
    `Public reason: ${reason}`,
    `Inspect with turn.get using sessionId=${input.sourceSessionId} and executionId=${execution.id}.`,
  ].join("\n");
}
