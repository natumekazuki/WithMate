import type { ProviderQuotaTelemetry, ProviderRateLimitWindow } from "../../../src-shared/session/runtime-state.js";

const WINDOWS = [
  ["five_hour", "5 hours", 300],
  ["seven_day", "7 days", 10_080],
  ["seven_day_oauth_apps", "OAuth apps · 7 days", 10_080],
  ["seven_day_opus", "Opus · 7 days", 10_080],
  ["seven_day_sonnet", "Sonnet · 7 days", 10_080],
] as const;

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid Claude quota response");
  return value as Record<string, unknown>;
}

export function projectClaudeQuotaTelemetry(value: unknown): ProviderQuotaTelemetry | null {
  const response = record(value);
  if (response.rate_limits_available === false) return null;
  if (response.rate_limits_available !== true) throw new Error("Invalid Claude quota availability");
  const limits = record(response.rate_limits);
  const rateLimits: ProviderRateLimitWindow[] = [];
  const add = (value: unknown, quotaKey: string, label: string, windowDurationMinutes: number) => {
    if (value === undefined || value === null) return;
    const window = record(value);
    if (window.utilization === null) return;
    if (typeof window.utilization !== "number" || !Number.isFinite(window.utilization) || window.utilization < 0 || window.utilization > 100) {
      throw new Error("Invalid Claude quota utilization");
    }
    const reset = window.resets_at;
    if (reset !== null && (typeof reset !== "string" || !Number.isFinite(Date.parse(reset)))) throw new Error("Invalid Claude quota reset");
    if (rateLimits.some((entry) => entry.quotaKey === quotaKey)) throw new Error("Duplicate Claude quota window");
    rateLimits.push({ quotaKey, label, usedPercentage: window.utilization, windowDurationMinutes,
      ...(typeof reset === "string" ? { resetDate: reset } : {}) });
  };
  for (const [key, label, minutes] of WINDOWS) add(limits[key], key, label, minutes);
  if (limits.model_scoped !== undefined) {
    if (!Array.isArray(limits.model_scoped)) throw new Error("Invalid Claude model quota windows");
    for (const value of limits.model_scoped) {
      const window = record(value);
      if (typeof window.display_name !== "string" || !window.display_name.trim()) throw new Error("Invalid Claude model quota label");
      add(window, `model_scoped:${window.display_name}`, `${window.display_name} · 7 days`, 10_080);
    }
  }
  if (!rateLimits.length) throw new Error("Claude quota response contains no usable windows");
  return { provider: "claude", updatedAt: new Date().toISOString(), snapshots: [], rateLimits, status: "ready" };
}
