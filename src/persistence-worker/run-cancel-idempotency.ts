import { createHash } from "node:crypto";

import type { RunCancelAdmissionResult } from "../shared/repository-write-model.js";

export function prepareRunCancelIdempotency(
  input: Readonly<{
    sessionId: string;
    workspaceKey: string;
    runId: string;
  }>,
): Readonly<{ fingerprint: string }> {
  return {
    fingerprint: createHash("sha256")
      .update(
        JSON.stringify({
          operation: "run.cancel.admit",
          sessionId: input.sessionId,
          workspaceKey: input.workspaceKey,
          runId: input.runId,
        }),
        "utf8",
      )
      .digest("hex"),
  };
}

export function projectRunCancelAdmissionResult(
  input: Readonly<{
    sessionId: string;
    runId: string;
    phase: unknown;
    cancelRequestedAt: unknown;
    cancelAcknowledgedAt: unknown;
    terminalAt: unknown;
  }>,
): RunCancelAdmissionResult | undefined {
  const { phase, cancelRequestedAt, cancelAcknowledgedAt, terminalAt } = input;
  if (
    (cancelRequestedAt !== null && (!Number.isSafeInteger(cancelRequestedAt) || (cancelRequestedAt as number) < 0)) ||
    (cancelAcknowledgedAt !== null &&
      (!Number.isSafeInteger(cancelAcknowledgedAt) || (cancelAcknowledgedAt as number) < 0)) ||
    (terminalAt !== null && (!Number.isSafeInteger(terminalAt) || (terminalAt as number) < 0))
  ) {
    return undefined;
  }
  if (phase === "canceling") {
    return cancelRequestedAt !== null && cancelAcknowledgedAt === null && terminalAt === null
      ? {
          sessionId: input.sessionId,
          runId: input.runId,
          phase,
          cancelRequestedAt: cancelRequestedAt as number,
          cancelAcknowledgedAt: null,
          terminalAt: null,
        }
      : undefined;
  }
  if (
    (phase !== "completed" && phase !== "failed" && phase !== "canceled" && phase !== "interrupted") ||
    terminalAt === null
  ) {
    return undefined;
  }
  if (
    (cancelRequestedAt !== null && (terminalAt as number) < (cancelRequestedAt as number)) ||
    (cancelAcknowledgedAt !== null &&
      (cancelRequestedAt === null ||
        (cancelAcknowledgedAt as number) < (cancelRequestedAt as number) ||
        (cancelAcknowledgedAt as number) > (terminalAt as number)))
  ) {
    return undefined;
  }
  if ((phase === "completed" || phase === "failed" || phase === "interrupted") && cancelAcknowledgedAt !== null) {
    return undefined;
  }
  if (
    phase === "canceled" &&
    !(
      (cancelRequestedAt === null && cancelAcknowledgedAt === null) ||
      (cancelRequestedAt !== null && cancelAcknowledgedAt !== null)
    )
  ) {
    return undefined;
  }
  if (phase === "completed" || phase === "failed" || phase === "interrupted") {
    return {
      sessionId: input.sessionId,
      runId: input.runId,
      phase,
      cancelRequestedAt: cancelRequestedAt as number | null,
      cancelAcknowledgedAt: null,
      terminalAt: terminalAt as number,
    };
  }
  return cancelRequestedAt === null
    ? {
        sessionId: input.sessionId,
        runId: input.runId,
        phase,
        cancelRequestedAt: null,
        cancelAcknowledgedAt: null,
        terminalAt: terminalAt as number,
      }
    : {
        sessionId: input.sessionId,
        runId: input.runId,
        phase,
        cancelRequestedAt: cancelRequestedAt as number,
        cancelAcknowledgedAt: cancelAcknowledgedAt as number,
        terminalAt: terminalAt as number,
      };
}
