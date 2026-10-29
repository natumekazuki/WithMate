import type { ProviderQuotaTelemetry } from "../../src-shared/session/runtime-state.js";

export type QuotaRemainingWindow = {
  key: string;
  label: string;
  remaining: string;
  resetDate?: string;
  summary: boolean;
};

export function providerQuotaName(providerId: string): string {
  return ({ codex: "Codex", claude: "Claude", copilot: "Copilot", opencode: "OpenCode" } as Record<string, string>)[providerId] ?? providerId;
}

function percentage(value: number): string {
  return Number.isFinite(value) && value >= 0 && value <= 100
    ? `${Number(value.toFixed(1))}%` : "—";
}

function periodLabel(minutes: number | undefined): string | null {
  if (minutes === undefined || !Number.isFinite(minutes) || minutes <= 0) return null;
  if (minutes % 1440 === 0) return `${minutes / 1440}d`;
  if (minutes % 60 === 0) return `${minutes / 60}h`;
  return `${minutes}m`;
}

export function projectQuotaRemaining(telemetry: ProviderQuotaTelemetry | null): QuotaRemainingWindow[] {
  if (!telemetry) return [];
  const windows: QuotaRemainingWindow[] = (telemetry.rateLimits ?? []).map((window) => {
    const period = periodLabel(window.windowDurationMinutes);
    const summary = telemetry.provider === "claude"
      ? window.quotaKey === "five_hour" || window.quotaKey === "seven_day"
      : telemetry.provider === "codex" && /^codex:(primary|secondary)$/.test(window.quotaKey);
    return {
      key: window.quotaKey,
      label: summary ? period ?? window.label ?? window.quotaKey
        : telemetry.provider === "codex"
          ? [window.label ?? window.quotaKey, period ?? (window.label ? window.quotaKey : null)].filter(Boolean).join(" · ")
          : window.label ?? [window.quotaKey, period].filter(Boolean).join(" · "),
      remaining: percentage(100 - window.usedPercentage),
      resetDate: window.resetDate,
      summary,
    };
  });
  const preferredKeys = ["ai_credits", "ai_credit", "aiu", "premium_interactions", "premium_requests", "premium", "chat"];
  const primary = preferredKeys.map((key) => telemetry.snapshots.find((snapshot) => snapshot.quotaKey === key)).find(Boolean)
    ?? telemetry.snapshots[0];
  for (const snapshot of telemetry.snapshots) {
    windows.push({
      key: snapshot.quotaKey,
      label: ["ai_credits", "ai_credit", "aiu"].includes(snapshot.quotaKey) ? "AI Credits"
        : snapshot === primary && snapshot.quotaKey.startsWith("premium") ? "Premium"
          : snapshot.quotaKey.replaceAll("_", " "),
      remaining: percentage(snapshot.remainingPercentage),
      resetDate: snapshot.resetDate,
      summary: snapshot === primary,
    });
  }
  return windows;
}

export function formatQuotaTimestamp(value: string | null | undefined): string {
  if (!value || !Number.isFinite(Date.parse(value))) return "Not Available";
  return new Date(value).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" });
}
