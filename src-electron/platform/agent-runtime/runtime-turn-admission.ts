import { AsyncLocalStorage } from "node:async_hooks";

/** Serializable authority for work crossing the main/Worker boundary. */
export type WorkerRuntimeTurnAdmission = {
  state: SharedArrayBuffer;
  binding?: { state: SharedArrayBuffer; expiresAtMs: number | null };
};

export type RuntimeTurnAdmission = WorkerRuntimeTurnAdmission & {
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
    || (context.binding && (
      Atomics.load(new Int32Array(context.binding.state), 0) !== 0
      || (context.binding.expiresAtMs !== null && Date.now() >= context.binding.expiresAtMs)
    ))
  )) {
    throw new RuntimeTurnInactiveError();
  }
}

/** Transfers only the shared revocation flags and expiry, not the credentials or callbacks. */
export function currentWorkerRuntimeTurnAdmission(): WorkerRuntimeTurnAdmission | undefined {
  const context = admission.getStore();
  return context && { state: context.state, ...(context.binding ? { binding: context.binding } : {}) };
}

/** Accepted durable work is no longer owned by the initiating runtime Turn. */
export function runWithoutRuntimeTurnAdmission<T>(operation: () => T): T {
  return admission.exit(operation);
}

export function reportRuntimeTurnOperationError(error: unknown): void {
  try { admission.getStore()?.onOperationError?.(error); }
  catch { /* Diagnostics do not change confirmed effects or public errors. */ }
}
