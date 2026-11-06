import { AsyncLocalStorage } from "node:async_hooks";

export type RuntimeTurnAdmission = {
  state: SharedArrayBuffer;
  isCurrent?: () => boolean;
  /** Diagnostic-only; reporting must not alter the operation or its public response. */
  onOperationError?: (error: unknown) => void;
};

export class RuntimeTurnInactiveError extends Error {
  readonly effect = "none";

  constructor() {
    super("The captured runtime turn is no longer active.");
    this.name = "RuntimeTurnInactiveError";
  }
}

const admission = new AsyncLocalStorage<RuntimeTurnAdmission>();

export function runWithRuntimeTurnAdmission<T>(context: RuntimeTurnAdmission, operation: () => T): T {
  return admission.run(context, () => {
    assertRuntimeTurnAdmission();
    return operation();
  });
}

export function assertRuntimeTurnAdmission(): void {
  const context = admission.getStore();
  if (context && (
    context.isCurrent?.() === false
    || Atomics.load(new Int32Array(context.state), 0) !== 0
  )) {
    throw new RuntimeTurnInactiveError();
  }
}

export function currentRuntimeTurnAdmissionState(): SharedArrayBuffer | undefined {
  return admission.getStore()?.state;
}

export function reportRuntimeTurnOperationError(error: unknown): void {
  try { admission.getStore()?.onOperationError?.(error); }
  catch { /* Diagnostics do not change confirmed effects or public errors. */ }
}
