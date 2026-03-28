import type {
  AuditTransportPayload,
  ProviderQuotaSnapshot,
  ProviderQuotaTelemetry,
} from "../src/app-state.js";

function selectPrimaryQuotaSnapshot(telemetry: ProviderQuotaTelemetry | null): ProviderQuotaSnapshot | null {
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

export function appendQuotaTelemetryToTransportPayload(
  payload: AuditTransportPayload | null,
  telemetry: ProviderQuotaTelemetry | null | undefined,
): AuditTransportPayload | null {
  if (!payload) {
    return payload;
  }

  const snapshot = selectPrimaryQuotaSnapshot(telemetry ?? null);
  if (!snapshot) {
    return payload;
  }

  const remainingRequests = Math.max(0, snapshot.entitlementRequests - snapshot.usedRequests);
  return {
    ...payload,
    fields: [
      ...payload.fields,
      { label: "quotaKey", value: snapshot.quotaKey },
      { label: "remainingPercentage", value: `${Math.max(0, Math.round(snapshot.remainingPercentage))}%` },
      { label: "remainingRequests", value: `${remainingRequests} / ${snapshot.entitlementRequests}` },
      { label: "resetDate", value: snapshot.resetDate ?? "unknown" },
    ],
  };
}
