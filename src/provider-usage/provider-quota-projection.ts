import type { ProviderQuotaTelemetry } from "../../src-shared/session/runtime-state.js";

/** 利用枠の残量・リセット時刻と、要約に含めるかを表す表示行。 */
export type QuotaRemainingWindow = {
  key: string;
  label: string;
  remaining: string;
  resetDate?: string;
  summary: boolean;
};

/** 既知の Provider は表示名に置き換え、それ以外は ID をそのまま使う。 */
export function providerQuotaName(providerId: string): string {
  return (
    (
      {
        codex: "Codex",
        claude: "Claude",
        copilot: "Copilot",
        opencode: "OpenCode Go",
      } as Record<string, string>
    )[providerId] ?? providerId
  );
}

/** 0〜100 の有限値を小数1桁に丸め、範囲外や不明な値はダッシュで示す。 */
function percentage(value: number): string {
  return Number.isFinite(value) && value >= 0 && value <= 100
    ? `${Number(value.toFixed(1))}%`
    : "—";
}

/** 正の期間を割り切れる最大単位（日・時・分）で表し、不明な期間は省く。 */
function periodLabel(minutes: number | undefined): string | null {
  if (minutes === undefined || !Number.isFinite(minutes) || minutes <= 0)
    return null;
  if (minutes % 1440 === 0) return `${minutes / 1440}d`;
  if (minutes % 60 === 0) return `${minutes / 60}h`;
  return `${minutes}m`;
}

/** 使用率と残率を残量表示に統一し、Provider 別の主要枠と詳細専用の追加枠を区別する。 */
export function projectQuotaRemaining(
  telemetry: ProviderQuotaTelemetry | null,
): QuotaRemainingWindow[] {
  if (!telemetry) return [];
  const windows: QuotaRemainingWindow[] = (telemetry.rateLimits ?? []).map(
    (window) => {
      const period = periodLabel(window.windowDurationMinutes);
      const summary =
        telemetry.provider === "claude"
          ? window.quotaKey === "five_hour" || window.quotaKey === "seven_day"
          : telemetry.provider === "opencode"
            ? ["rolling", "weekly", "monthly"].includes(window.quotaKey)
            : telemetry.provider === "codex" &&
              /^codex:(primary|secondary)$/.test(window.quotaKey);
      return {
        key: window.quotaKey,
        label: summary
          ? (period ?? window.label ?? window.quotaKey)
          : telemetry.provider === "codex"
            ? [
                window.label ?? window.quotaKey,
                period ?? (window.label ? window.quotaKey : null),
              ]
                .filter(Boolean)
                .join(" · ")
            : (window.label ??
              [window.quotaKey, period].filter(Boolean).join(" · ")),
        remaining: percentage(100 - window.usedPercentage),
        resetDate: window.resetDate,
        summary,
      };
    },
  );
  const preferredKeys = [
    "ai_credits",
    "ai_credit",
    "aiu",
    "premium_interactions",
    "premium_requests",
    "premium",
    "chat",
  ];
  const primary =
    preferredKeys
      .map((key) =>
        telemetry.snapshots.find((snapshot) => snapshot.quotaKey === key),
      )
      .find(Boolean) ?? telemetry.snapshots[0];
  for (const snapshot of telemetry.snapshots) {
    windows.push({
      key: snapshot.quotaKey,
      label: ["ai_credits", "ai_credit", "aiu"].includes(snapshot.quotaKey)
        ? "AI Credits"
        : snapshot === primary && snapshot.quotaKey.startsWith("premium")
          ? "Premium"
          : snapshot.quotaKey.replaceAll("_", " "),
      remaining: percentage(snapshot.remainingPercentage),
      resetDate: snapshot.resetDate,
      summary: snapshot === primary,
    });
  }
  return windows;
}

/** 有効な日時を利用環境のタイムゾーンで表示し、空または無効な日時は利用不可とする。 */
export function formatQuotaTimestamp(value: string | null | undefined): string {
  if (!value || !Number.isFinite(Date.parse(value))) return "Not Available";
  return new Date(value).toLocaleString("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
  });
}
