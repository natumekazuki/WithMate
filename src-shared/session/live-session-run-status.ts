import type { LiveSessionRunState } from "./runtime-state.js";

export type LiveSessionRunStatus = Pick<
  LiveSessionRunState,
  "runState" | "cancellationState"
>;

export function projectLiveSessionRunStatus(
  state: LiveSessionRunState | null,
): LiveSessionRunStatus | null {
  if (state === null) return null;
  return {
    runState: state.runState,
    cancellationState: state.cancellationState,
  };
}
