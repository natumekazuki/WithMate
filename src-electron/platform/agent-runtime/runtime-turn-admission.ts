import { AsyncLocalStorage } from "node:async_hooks";

/** Main と Worker の境界を越える処理のための、シリアライズ可能な権限情報。 */
export type WorkerRuntimeTurnAdmission = {
  state: SharedArrayBuffer;
  binding?: { state: SharedArrayBuffer; expiresAtMs: number | null };
};

/** Worker に渡せる失効状態に、現在のプロセス内だけの再確認と診断の操作を加えた実行コンテキスト。 */
export type RuntimeTurnAdmission = WorkerRuntimeTurnAdmission & {
  isCurrent?: () => boolean;
  /** 診断専用。報告によって操作や公開応答が変わってはならない。 */
  onOperationError?: (error: unknown) => void;
};

/** 捕捉した Turn が失効していて実行できないことを、副作用なしとして表す。 */
export class RuntimeTurnInactiveError extends Error {
  readonly effect = "none";

  /** 実行コンテキストの期限切れ・失効を呼び出し元が識別できるエラーにする。 */
  constructor() {
    super("The captured runtime turn is no longer active.");
    this.name = "RuntimeTurnInactiveError";
  }
}

const admission = new AsyncLocalStorage<RuntimeTurnAdmission>();

/** 非同期呼び出しの範囲に Turn の権限を設定し、有効であることを確認してから処理を開始する。 */
export function runWithRuntimeTurnAdmission<T>(
  context: RuntimeTurnAdmission,
  operation: () => T,
): T {
  return admission.run(context, () => {
    assertRuntimeTurnAdmission();
    return operation();
  });
}

/** 捕捉済みの Turn と紐付けの失効・有効期限を確認する。捕捉していない処理は制限しない。 */
export function assertRuntimeTurnAdmission(): void {
  const context = admission.getStore();
  if (
    context &&
    (context.isCurrent?.() === false ||
      Atomics.load(new Int32Array(context.state), 0) !== 0 ||
      (context.binding &&
        (Atomics.load(new Int32Array(context.binding.state), 0) !== 0 ||
          (context.binding.expiresAtMs !== null &&
            Date.now() >= context.binding.expiresAtMs))))
  ) {
    throw new RuntimeTurnInactiveError();
  }
}

/** 共有の失効フラグと有効期限だけを渡し、認証情報やコールバックは渡さない。 */
export function currentWorkerRuntimeTurnAdmission():
  WorkerRuntimeTurnAdmission | undefined {
  const context = admission.getStore();
  return (
    context && {
      state: context.state,
      ...(context.binding ? { binding: context.binding } : {}),
    }
  );
}

/** 受理されて永続化される処理は、開始したランタイムの Turn の所有から離れる。 */
export function runWithoutRuntimeTurnAdmission<T>(operation: () => T): T {
  return admission.exit(operation);
}

/** 現在の Turn の診断先にエラーを通知し、診断そのものの失敗は伝播させない。 */
export function reportRuntimeTurnOperationError(error: unknown): void {
  try {
    admission.getStore()?.onOperationError?.(error);
  } catch {
    /* 診断は確認済みの副作用や公開エラーを変えない。 */
  }
}
