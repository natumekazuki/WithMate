import type { ProviderQuotaTelemetry, ProviderRateLimitWindow } from "../../../src-shared/session/runtime-state.js";

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid Codex rate limits response");
  }
  return value as Record<string, unknown>;
}

export function projectCodexQuotaTelemetry(value: unknown, provider: string): ProviderQuotaTelemetry {
  const response = record(value);
  const buckets = response.rateLimitsByLimitId == null
    ? [[undefined, record(response.rateLimits)] as const]
    : Object.entries(record(response.rateLimitsByLimitId)).map(([id, bucket]) => [id, record(bucket)] as const);
  const rateLimits: ProviderRateLimitWindow[] = [];
  for (const [key, bucket] of buckets) {
    const id = key ?? bucket.limitId ?? "codex";
    if (!("primary" in bucket) && !("secondary" in bucket)
      || typeof id !== "string" || !id.trim()
      || bucket.limitId != null && bucket.limitId !== id
      || bucket.limitName != null && typeof bucket.limitName !== "string") {
      throw new Error("Invalid Codex rate limits response");
    }
    for (const name of ["primary", "secondary"] as const) {
      if (bucket[name] == null) continue;
      const window = record(bucket[name]);
      if (typeof window.usedPercent !== "number" || !Number.isFinite(window.usedPercent)
        || window.usedPercent < 0 || window.usedPercent > 100
        || window.windowDurationMins != null && (typeof window.windowDurationMins !== "number"
          || !Number.isFinite(window.windowDurationMins) || window.windowDurationMins <= 0)
        || window.resetsAt != null && (typeof window.resetsAt !== "number"
          || !Number.isFinite(window.resetsAt) || window.resetsAt < 0
          || !Number.isFinite(new Date(window.resetsAt * 1000).getTime()))) {
        throw new Error("Invalid Codex rate limits response");
      }
      rateLimits.push({
        quotaKey: `${id}:${name}`,
        ...(typeof bucket.limitName === "string" ? { label: bucket.limitName } : {}),
        usedPercentage: window.usedPercent,
        ...(typeof window.windowDurationMins === "number" ? { windowDurationMinutes: window.windowDurationMins } : {}),
        ...(typeof window.resetsAt === "number" ? { resetDate: new Date(window.resetsAt * 1000).toISOString() } : {}),
      });
    }
  }
  return { provider, updatedAt: new Date().toISOString(), snapshots: [], rateLimits, status: "ready" };
}
