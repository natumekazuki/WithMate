export type CancelSessionRunDeps = {
  getActiveExecutionId(sessionId: string): string | undefined;
  markExecutionCanceled(executionId: string): void;
  cancelRuntimeRun(sessionId: string): void;
};

export function cancelSessionRun(
  deps: CancelSessionRunDeps,
  sessionId: string,
  expectedExecutionId?: string,
): void {
  const activeExecutionId = deps.getActiveExecutionId(sessionId);
  if (expectedExecutionId && activeExecutionId !== expectedExecutionId) {
    throw new Error("The active Session execution does not match the cancel request.");
  }
  if (activeExecutionId) {
    deps.markExecutionCanceled(activeExecutionId);
  }
  deps.cancelRuntimeRun(sessionId);
}
