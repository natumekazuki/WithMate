import type { LiveSessionRunState } from "./runtime-state.js";

/** 実行・中断と入力待ちだけを伝え、会話や承認要求の本文は含まない。 */
export type LiveSessionRunStatus = Pick<
  LiveSessionRunState,
  "runState" | "cancellationState"
> & { approvalPending?: boolean };

/** 稼働情報がなければnullを返し、あれば承認または質問待ちかを要約する。 */
export function projectLiveSessionRunStatus(
  state: LiveSessionRunState | null,
): LiveSessionRunStatus | null {
  if (state === null) return null;
  return {
    runState: state.runState,
    cancellationState: state.cancellationState,
    ...(state.approvalRequest ||
    state.elicitationRequest ||
    state.elicitationRequests?.length
      ? { approvalPending: true }
      : {}),
  };
}
