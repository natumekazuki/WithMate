import type {
  AuditLogOperation,
  AuditLogPhase,
  LiveRunStep,
  ProviderQuotaSnapshot,
  ProviderQuotaTelemetry,
  SessionBackgroundActivityState,
  SessionContextTelemetry,
} from "./app-state.js";
import { liveRunStepStatusLabel } from "./ui-utils.js";

export type ContextPaneTabKey = "latest-command" | "memory-generation" | "monologue";

export const CONTEXT_PANE_TAB_ORDER: ContextPaneTabKey[] = ["latest-command", "memory-generation", "monologue"];

export type LatestCommandView = {
  status: string;
  summary: string;
  details?: string;
  sourceLabel: string;
  riskLabels: string[];
};

export type CopilotQuotaProjection = {
  snapshot: ProviderQuotaSnapshot | null;
  remainingPercentLabel: string;
  remainingRequestsLabel: string;
  resetLabel: string;
};

export type ContextPaneProjection = {
  activeTab: ContextPaneTabKey;
  badgeLabel: string;
  toneClassName: string;
  latestCommandToneClassName: string;
  latestCommandStatusLabel: string;
  latestCommandSourceCopy: string;
  memoryGenerationToneClassName: string;
  monologueToneClassName: string;
};

export type SessionContextTelemetryProjection = {
  summaryLabel: string;
  currentTokensLabel: string;
  tokenLimitLabel: string;
  messagesLengthLabel: string;
  systemTokensLabel: string;
  conversationTokensLabel: string;
};

export function liveRunStepToneClassName(status: string): string {
  switch (status) {
    case "in_progress":
    case "completed":
    case "failed":
    case "canceled":
    case "pending":
      return status;
    default:
      return "unknown";
  }
}

export function buildCommandRiskLabels(command: string): string[] {
  const normalizedCommand = command.toLowerCase();
  const labels: string[] = [];

  if (
    /\b(rm|del|rmdir|rd|truncate|delete|remove)\b/.test(normalizedCommand)
    || /\b(remove-item|remove-itemproperty)\b/.test(normalizedCommand)
  ) {
    labels.push("DELETE");
  }

  if (
    /\b(mv|move|cp|copy|mkdir|md|touch|tee|create|edit|replace|insert|write|rename)\b/.test(normalizedCommand)
    || /\b(new-item|set-content|add-content|out-file|rename-item|move-item|copy-item)\b/.test(normalizedCommand)
    || /\b(git apply|git checkout|git restore|git clean)\b/.test(normalizedCommand)
  ) {
    labels.push("WRITE");
  }

  if (
    /\b(curl|wget)\b/.test(normalizedCommand)
    || /\b(invoke-webrequest|invoke-restmethod|iwr|irm)\b/.test(normalizedCommand)
    || /\b(npm|pnpm|yarn|pip|uv|cargo|go)\s+(install|add|get)\b/.test(normalizedCommand)
  ) {
    labels.push("NETWORK");
  }

  return labels;
}

export function buildLatestCommandView({
  latestLiveCommandStep,
  latestAuditCommandOperation,
  latestTerminalAuditPhase,
}: {
  latestLiveCommandStep: LiveRunStep | null;
  latestAuditCommandOperation: AuditLogOperation | null;
  latestTerminalAuditPhase: AuditLogPhase | null | undefined;
}): LatestCommandView | null {
  if (latestLiveCommandStep) {
    return {
      status: latestLiveCommandStep.status,
      summary: latestLiveCommandStep.summary,
      details: latestLiveCommandStep.details,
      sourceLabel: "live",
      riskLabels: buildCommandRiskLabels(latestLiveCommandStep.summary),
    };
  }

  if (latestAuditCommandOperation) {
    return {
      status: latestTerminalAuditPhase === "failed"
        ? "failed"
        : latestTerminalAuditPhase === "canceled"
          ? "canceled"
          : "completed",
      summary: latestAuditCommandOperation.summary,
      details: latestAuditCommandOperation.details,
      sourceLabel: "latest run",
      riskLabels: buildCommandRiskLabels(latestAuditCommandOperation.summary),
    };
  }

  return null;
}

export function selectPrimaryQuotaSnapshot(telemetry: ProviderQuotaTelemetry | null): ProviderQuotaSnapshot | null {
  if (!telemetry || telemetry.snapshots.length === 0) {
    return null;
  }

  const preferredKeys = ["premium_interactions", "premium_requests", "premium", "chat"];
  for (const preferredKey of preferredKeys) {
    const matched = telemetry.snapshots.find((snapshot) => snapshot.quotaKey === preferredKey);
    if (matched) {
      return matched;
    }
  }

  return telemetry.snapshots[0] ?? null;
}

export function formatQuotaResetLabel(resetDate: string | undefined): string {
  if (!resetDate?.trim()) {
    return "未確認";
  }

  const parsed = new Date(resetDate);
  if (Number.isNaN(parsed.getTime())) {
    return resetDate;
  }

  return parsed.toLocaleString("ja-JP", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function buildCopilotQuotaProjection(telemetry: ProviderQuotaTelemetry | null): CopilotQuotaProjection {
  const snapshot = selectPrimaryQuotaSnapshot(telemetry);
  if (!snapshot) {
    return {
      snapshot: null,
      remainingPercentLabel: "unavailable",
      remainingRequestsLabel: "usage unavailable",
      resetLabel: "未確認",
    };
  }

  const remainingRequests = Math.max(0, snapshot.entitlementRequests - snapshot.usedRequests);
  return {
    snapshot,
    remainingPercentLabel: `${Math.max(0, Math.round(snapshot.remainingPercentage))}% left`,
    remainingRequestsLabel: `${remainingRequests} / ${snapshot.entitlementRequests} left`,
    resetLabel: formatQuotaResetLabel(snapshot.resetDate),
  };
}

export function buildSessionContextTelemetryProjection(
  telemetry: SessionContextTelemetry | null,
): SessionContextTelemetryProjection {
  if (!telemetry) {
    return {
      summaryLabel: "unavailable",
      currentTokensLabel: "-",
      tokenLimitLabel: "-",
      messagesLengthLabel: "-",
      systemTokensLabel: "-",
      conversationTokensLabel: "-",
    };
  }

  return {
    summaryLabel: `${telemetry.currentTokens.toLocaleString()} / ${telemetry.tokenLimit.toLocaleString()}`,
    currentTokensLabel: telemetry.currentTokens.toLocaleString(),
    tokenLimitLabel: telemetry.tokenLimit.toLocaleString(),
    messagesLengthLabel: telemetry.messagesLength.toLocaleString(),
    systemTokensLabel: telemetry.systemTokens?.toLocaleString() ?? "-",
    conversationTokensLabel: telemetry.conversationTokens?.toLocaleString() ?? "-",
  };
}

export function sessionBackgroundActivityStatusLabel(status: string): string {
  switch (status) {
    case "running":
      return "実行中";
    case "completed":
      return "完了";
    case "failed":
      return "失敗";
    case "canceled":
      return "キャンセル";
    default:
      return status;
  }
}

export function contextPaneTabLabel(tab: ContextPaneTabKey): string {
  switch (tab) {
    case "latest-command":
      return "LatestCommand";
    case "memory-generation":
      return "MemoryGeneration";
    case "monologue":
      return "Monologue";
    default:
      return tab;
  }
}

export function resolveAutoContextPaneTab({
  isSelectedSessionRunning,
  selectedMemoryGenerationActivity,
  selectedMonologueActivity,
}: {
  isSelectedSessionRunning: boolean;
  selectedMemoryGenerationActivity: SessionBackgroundActivityState | null;
  selectedMonologueActivity: SessionBackgroundActivityState | null;
}): ContextPaneTabKey | null {
  if (isSelectedSessionRunning) {
    return "latest-command";
  }

  if (selectedMemoryGenerationActivity?.status === "running") {
    return "memory-generation";
  }

  if (selectedMonologueActivity?.status === "running") {
    return "monologue";
  }

  return null;
}

export function cycleContextPaneTab(currentTab: ContextPaneTabKey, direction: -1 | 1): ContextPaneTabKey {
  const currentIndex = CONTEXT_PANE_TAB_ORDER.indexOf(currentTab);
  const safeIndex = currentIndex >= 0 ? currentIndex : 0;
  const nextIndex = (safeIndex + direction + CONTEXT_PANE_TAB_ORDER.length) % CONTEXT_PANE_TAB_ORDER.length;
  return CONTEXT_PANE_TAB_ORDER[nextIndex] ?? "latest-command";
}

export function buildContextPaneProjection({
  activeContextPaneTab,
  latestCommandView,
  selectedMemoryGenerationActivity,
  selectedMonologueActivity,
}: {
  activeContextPaneTab: ContextPaneTabKey;
  latestCommandView: LatestCommandView | null;
  selectedMemoryGenerationActivity: SessionBackgroundActivityState | null;
  selectedMonologueActivity: SessionBackgroundActivityState | null;
}): ContextPaneProjection {
  const latestCommandToneClassName = latestCommandView ? liveRunStepToneClassName(latestCommandView.status) : "unknown";
  const latestCommandStatusLabel = latestCommandView ? liveRunStepStatusLabel(latestCommandView.status) : "待機";
  const latestCommandSourceCopy = latestCommandView?.sourceLabel === "live" ? "RUN LIVE" : "LAST RUN";
  const memoryGenerationToneClassName = selectedMemoryGenerationActivity?.status ?? "unknown";
  const monologueToneClassName = selectedMonologueActivity?.status ?? "unknown";

  let badgeLabel = "";
  switch (activeContextPaneTab) {
    case "memory-generation":
      badgeLabel = selectedMemoryGenerationActivity
        ? sessionBackgroundActivityStatusLabel(selectedMemoryGenerationActivity.status)
        : "";
      break;
    case "monologue":
      badgeLabel = selectedMonologueActivity
        ? sessionBackgroundActivityStatusLabel(selectedMonologueActivity.status)
        : "";
      break;
    default:
      badgeLabel = "";
      break;
  }

  let toneClassName = "unknown";
  switch (activeContextPaneTab) {
    case "latest-command":
      toneClassName = latestCommandToneClassName;
      break;
    case "memory-generation":
      toneClassName = memoryGenerationToneClassName;
      break;
    case "monologue":
      toneClassName = monologueToneClassName;
      break;
    default:
      toneClassName = "unknown";
      break;
  }

  return {
    activeTab: activeContextPaneTab,
    badgeLabel,
    toneClassName,
    latestCommandToneClassName,
    latestCommandStatusLabel,
    latestCommandSourceCopy,
    memoryGenerationToneClassName,
    monologueToneClassName,
  };
}
