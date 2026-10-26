import type { ProviderQuotaTelemetry, ProviderRateLimitWindow } from "../../../src-shared/session/runtime-state.js";

const WINDOWS = [
  { key: "rolling", label: "5 hours", minutes: 300 },
  { key: "weekly", label: "7 days", minutes: 10_080 },
  { key: "monthly", label: "1 month" },
] as const;

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid OpenCode Go quota response");
  return value as Record<string, unknown>;
}

export async function fetchOpenCodeQuotaTelemetry(apiKey: string, callerSignal?: AbortSignal, fetcher: typeof fetch = fetch): Promise<ProviderQuotaTelemetry> {
  const signal = AbortSignal.any([AbortSignal.timeout(30_000), ...(callerSignal ? [callerSignal] : [])]);
  let value: unknown;
  try {
    signal.throwIfAborted();
    const response = await fetcher("https://opencode.ai/inference/go/v1/usage", {
      method: "GET",
      headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
      redirect: "error",
      signal,
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error("Unsuccessful quota response");
    }
    value = await response.json();
    signal.throwIfAborted();
  } catch {
    // Response bodies and transport errors may contain credentials; never propagate them.
    throw new Error(signal.aborted ? "OpenCode Go quota request canceled" : "OpenCode Go quota request failed");
  }
  const usage = record(record(value).usage);
  const rateLimits: ProviderRateLimitWindow[] = [];
  for (const definition of WINDOWS) {
    const value = usage[definition.key];
    if (value === undefined || value === null) continue;
    const window = record(value);
    if (window.status !== "ok" && window.status !== "rate-limited") throw new Error("Invalid OpenCode Go quota status");
    if (typeof window.percent !== "number" || !Number.isFinite(window.percent) || window.percent < 0 || window.percent > 100) {
      throw new Error("Invalid OpenCode Go quota percentage");
    }
    if (typeof window.resetsAt !== "string" || !Number.isFinite(Date.parse(window.resetsAt))) throw new Error("Invalid OpenCode Go quota reset");
    rateLimits.push({
      quotaKey: definition.key,
      label: definition.label,
      usedPercentage: window.percent,
      ...("minutes" in definition ? { windowDurationMinutes: definition.minutes } : {}),
      resetDate: window.resetsAt,
    });
  }
  if (!rateLimits.length) throw new Error("OpenCode Go quota response contains no usable windows");
  return { provider: "opencode", updatedAt: new Date().toISOString(), snapshots: [], rateLimits, status: "ready" };
}
