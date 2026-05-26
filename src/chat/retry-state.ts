import type { AuditLogSummary, LiveSessionRunState } from "../runtime-state.js";
import type { Message } from "../session-state.js";

export type RetryBannerKind = "interrupted" | "failed" | "canceled";

export type RetryBannerState = {
  kind: RetryBannerKind;
  badge: string;
  title: string;
  stopSummary: string;
  lastRequestText: string;
};

export function defaultRetryBannerDetailsOpen(kind: RetryBannerKind): boolean {
  return kind !== "canceled";
}

export function resolveRetryBannerKind(input: {
  runState: string | null | undefined;
  latestTerminalAuditLogPhase?: AuditLogSummary["phase"] | null;
}): RetryBannerKind | null {
  if (input.runState === "interrupted") {
    return "interrupted";
  }

  if (input.runState === "error") {
    return "failed";
  }

  if (input.runState === "idle" && input.latestTerminalAuditLogPhase === "canceled") {
    return "canceled";
  }

  return null;
}

export function shouldProtectRetryEditDraft(input: {
  retryBanner: Pick<RetryBannerState, "lastRequestText"> | null;
  draft: string;
}): boolean {
  return !!input.retryBanner
    && input.draft.trim().length > 0
    && input.draft !== input.retryBanner.lastRequestText;
}

export function shouldShowRetryBanner(input: {
  hasActiveAuxiliarySession: boolean;
  hasLastUserMessage: boolean;
  isReadOnly: boolean;
  runState: string | null | undefined;
}): boolean {
  return !input.hasActiveAuxiliarySession
    && input.hasLastUserMessage
    && !input.isReadOnly
    && input.runState !== "running";
}

export function isRetryActionDisabled(input: {
  retryBanner: RetryBannerState | null;
  hasLastUserMessage: boolean;
  composerBlocked: boolean;
  isReadOnly: boolean;
  runState: string | null | undefined;
}): boolean {
  return !input.retryBanner
    || !input.hasLastUserMessage
    || input.composerBlocked
    || input.isReadOnly
    || input.runState === "running";
}

function getLastNonEmptyValue(values: Array<string | null | undefined>): string {
  for (let index = values.length - 1; index >= 0; index -= 1) {
    const candidate = values[index]?.trim();
    if (candidate) {
      return candidate;
    }
  }

  return "";
}

export function buildRetryStopSummary(
  kind: RetryBannerKind,
  liveRun: LiveSessionRunState | null,
  latestTerminalAuditLog: AuditLogSummary | null,
  lastAssistantMessage: Message | null,
): string {
  const liveRunSummary = getLastNonEmptyValue((liveRun?.steps ?? []).map((step) => step.summary));
  if (liveRunSummary) {
    return liveRunSummary;
  }

  if (kind === "interrupted") {
    return "停止地点は復元できませんでした。";
  }

  const auditOperationSummary = getLastNonEmptyValue(
    (latestTerminalAuditLog?.operations ?? []).map((operation) => operation.summary),
  );
  if (auditOperationSummary) {
    return auditOperationSummary;
  }

  const artifactOperationSummary = getLastNonEmptyValue(
    (lastAssistantMessage?.artifact?.operationTimeline ?? []).map((operation) => operation.summary),
  );
  if (artifactOperationSummary) {
    return artifactOperationSummary;
  }

  const artifactActivitySummary = getLastNonEmptyValue(lastAssistantMessage?.artifact?.activitySummary ?? []);
  if (artifactActivitySummary) {
    return artifactActivitySummary;
  }

  if (kind === "failed") {
    const errorSummary = latestTerminalAuditLog?.errorMessage.trim() ?? "";
    if (errorSummary && errorSummary !== "ユーザーがキャンセルしたよ。") {
      return errorSummary;
    }
  }

  switch (kind) {
    case "failed":
      return "エラー箇所は復元できませんでした。";
    case "canceled":
      return "停止位置は記録されていません。";
    default:
      return "";
  }
}
