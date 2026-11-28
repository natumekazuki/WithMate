import type { WorkspaceDirectoryValidationResult } from "../../src-shared/window/workspace-directory-validation.js";

/** 入力が落ち着いてからディレクトリの検証を開始するまでの既定時間。 */
export const DIRECTORY_PATH_VALIDATION_DEBOUNCE_MS = 300;

/** 入力待ち、検証待ち、検証中、現在の入力に対する結果を区別する表示状態。 */
export type DirectoryPathValidationState =
  "idle" | "debouncing" | "pending" | "valid" | "invalid";

/** 予約済みの検証を取り消すのに使うタイマーハンドル。 */
type TimeoutHandle = ReturnType<typeof setTimeout>;

/** 検証の実行先と、予約・開始・確定結果を呼び出し元の入力状態に反映する通知先。 */
type DirectoryPathValidationControllerOptions = {
  validate: (targetPath: string) => Promise<WorkspaceDirectoryValidationResult>;
  onScheduled: (targetPath: string) => void;
  onValidationStart: (targetPath: string) => void;
  onResult: (
    targetPath: string,
    result: WorkspaceDirectoryValidationResult,
  ) => void;
  delayMs?: number;
  setTimer?: (callback: () => void, delayMs: number) => TimeoutHandle;
  clearTimer?: (handle: TimeoutHandle) => void;
};

/** 入力値を検証する予約を差し替え、不要になった結果を破棄できる操作の組。 */
export type DirectoryPathValidationController = {
  /** 最新の入力を通知し、空でなければ待機時間後に検証する。 */
  schedule(targetPath: string): void;
  /** 予約を取り消し、開始済みの検証から後で届く結果も無効にする。 */
  cancel(): void;
};

/** 入力が変わるたびに以前の世代を無効にし、最新世代の検証結果だけを通知する。 */
export function createDirectoryPathValidationController({
  validate,
  onScheduled,
  onValidationStart,
  onResult,
  delayMs = DIRECTORY_PATH_VALIDATION_DEBOUNCE_MS,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
}: DirectoryPathValidationControllerOptions): DirectoryPathValidationController {
  let generation = 0;
  let timeout: TimeoutHandle | null = null;

  /** 予約済みタイマーを解除し、進行中の検証は世代の更新で反映対象から外す。 */
  const cancel = () => {
    generation += 1;
    if (timeout !== null) {
      clearTimer(timeout);
      timeout = null;
    }
  };

  return {
    /** 予約時の世代を保持し、失敗時もその世代が最新の場合だけ利用不可として通知する。 */
    schedule(targetPath) {
      cancel();
      onScheduled(targetPath);
      if (targetPath.length === 0) {
        return;
      }

      const requestGeneration = generation;
      timeout = setTimer(() => {
        timeout = null;
        onValidationStart(targetPath);
        void validate(targetPath)
          .then((result) => {
            if (requestGeneration === generation) {
              onResult(targetPath, result);
            }
          })
          .catch(() => {
            if (requestGeneration === generation) {
              onResult(targetPath, { valid: false, reason: "unavailable" });
            }
          });
      }, delayMs);
    },
    cancel,
  };
}
