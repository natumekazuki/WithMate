import type { WorkspaceDirectoryValidationResult } from "../../src-shared/window/workspace-directory-validation.js";

export const DIRECTORY_PATH_VALIDATION_DEBOUNCE_MS = 300;

export type DirectoryPathValidationState = "idle" | "debouncing" | "pending" | "valid" | "invalid";

type TimeoutHandle = ReturnType<typeof setTimeout>;

type DirectoryPathValidationControllerOptions = {
  validate: (targetPath: string) => Promise<WorkspaceDirectoryValidationResult>;
  onScheduled: (targetPath: string) => void;
  onValidationStart: (targetPath: string) => void;
  onResult: (targetPath: string, result: WorkspaceDirectoryValidationResult) => void;
  delayMs?: number;
  setTimer?: (callback: () => void, delayMs: number) => TimeoutHandle;
  clearTimer?: (handle: TimeoutHandle) => void;
};

export type DirectoryPathValidationController = {
  schedule(targetPath: string): void;
  cancel(): void;
};

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

  const cancel = () => {
    generation += 1;
    if (timeout !== null) {
      clearTimer(timeout);
      timeout = null;
    }
  };

  return {
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
