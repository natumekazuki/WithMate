import { AsyncLocalStorage } from "node:async_hooks";

/** Main と Worker の境界を越える処理のための、シリアライズ可能な権限情報。 */
export type WorkerRuntimeTurnAdmission = {
  state: SharedArrayBuffer;
  binding?: { state: SharedArrayBuffer; expiresAtMs: number | null };
};

export type RuntimeTurnAdmission = WorkerRuntimeTurnAdmission & {
  isCurrent?: () => boolean;
  /** 診断専用。報告によって操作や公開応答が変わってはならない。 */
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

/** 共有の失効フラグと有効期限だけを渡し、認証情報やコールバックは渡さない。 */
export function currentWorkerRuntimeTurnAdmission(): WorkerRuntimeTurnAdmission | undefined {
  const context = admission.getStore();
  return context && { state: context.state, ...(context.binding ? { binding: context.binding } : {}) };
}

/** 受理されて永続化される処理は、開始したランタイムの Turn の所有から離れる。 */
export function runWithoutRuntimeTurnAdmission<T>(operation: () => T): T {
  return admission.exit(operation);
}

export function reportRuntimeTurnOperationError(error: unknown): void {
  try { admission.getStore()?.onOperationError?.(error); }
  catch { /* 診断は確認済みの副作用や公開エラーを変えない。 */ }
}
