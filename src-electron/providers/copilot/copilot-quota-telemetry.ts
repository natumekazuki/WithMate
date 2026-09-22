import type {
  ProviderQuotaSnapshot,
  ProviderQuotaTelemetry,
  SessionContextTelemetry,
} from "../../../src-shared/session/runtime-state.js";

export type CopilotQuotaSnapshotLike = {
  entitlementRequests: number;
  usedRequests: number;
  remainingPercentage: number;
  overage?: number;
  overageAllowedWithExhaustedQuota?: boolean;
  resetDate?: string;
};

export function isCopilotQuotaSnapshotLike(value: unknown): value is CopilotQuotaSnapshotLike {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<CopilotQuotaSnapshotLike>;
  return typeof candidate.entitlementRequests === "number"
    && typeof candidate.usedRequests === "number"
    && typeof candidate.remainingPercentage === "number";
}

export function readCopilotQuotaSnapshots(value: unknown): Record<string, CopilotQuotaSnapshotLike> | null {
  if (!value || typeof value !== "object" || !("quotaSnapshots" in value)) return null;
  const quotaSnapshots = (value as { quotaSnapshots?: unknown }).quotaSnapshots;
  if (!quotaSnapshots || typeof quotaSnapshots !== "object") return null;
  const normalized: Record<string, CopilotQuotaSnapshotLike> = {};
  for (const [quotaKey, snapshot] of Object.entries(quotaSnapshots)) {
    if (isCopilotQuotaSnapshotLike(snapshot)) normalized[quotaKey] = snapshot;
  }
  return normalized;
}

function normalizeQuotaRemainingPercentage(value: number): number {
  if (Number.isNaN(value) || !Number.isFinite(value)) return 0;
  return value >= 0 && value <= 1 ? value * 100 : value;
}

export function toProviderQuotaSnapshots(
  snapshots: Record<string, CopilotQuotaSnapshotLike | undefined> | null | undefined,
): ProviderQuotaSnapshot[] {
  if (!snapshots) return [];
  return Object.entries(snapshots)
    .filter((entry): entry is [string, CopilotQuotaSnapshotLike] => isCopilotQuotaSnapshotLike(entry[1]))
    .map(([quotaKey, snapshot]) => ({
      quotaKey,
      entitlementRequests: snapshot.entitlementRequests,
      usedRequests: snapshot.usedRequests,
      remainingPercentage: normalizeQuotaRemainingPercentage(snapshot.remainingPercentage),
      overage: snapshot.overage ?? 0,
      overageAllowedWithExhaustedQuota: snapshot.overageAllowedWithExhaustedQuota ?? false,
      resetDate: snapshot.resetDate,
    }))
    .sort((left, right) => left.quotaKey.localeCompare(right.quotaKey));
}

export function buildCopilotProviderQuotaTelemetry(
  providerId: string,
  snapshots: Record<string, CopilotQuotaSnapshotLike | undefined> | null | undefined,
  updatedAt: string,
): ProviderQuotaTelemetry | null {
  const normalizedSnapshots = toProviderQuotaSnapshots(snapshots);
  return normalizedSnapshots.length === 0 ? null : { provider: providerId, updatedAt, snapshots: normalizedSnapshots };
}

export function buildCopilotSessionContextTelemetry(
  providerId: string,
  sessionId: string,
  data: {
    tokenLimit: number;
    currentTokens: number;
    messagesLength: number;
    systemTokens?: number;
    conversationTokens?: number;
    toolDefinitionsTokens?: number;
  },
  updatedAt: string,
): SessionContextTelemetry {
  return { provider: providerId, sessionId, updatedAt, ...data };
}
