import type {
  ProviderQuotaSnapshot,
  ProviderQuotaTelemetry,
  SessionContextTelemetry,
} from "../../../src-shared/session/runtime-state.js";

/** Copilot から取得する利用枠。件数と残量は必須で、超過・リセット情報は省略できる。 */
export type CopilotQuotaSnapshotLike = {
  entitlementRequests: number;
  usedRequests: number;
  remainingPercentage: number;
  overage?: number;
  overageAllowedWithExhaustedQuota?: boolean;
  resetDate?: string;
};

/** 利用枠に必要な 3 項目が数値型かを確認する。任意項目や数値の範囲は検査しない。 */
export function isCopilotQuotaSnapshotLike(
  value: unknown,
): value is CopilotQuotaSnapshotLike {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<CopilotQuotaSnapshotLike>;
  return (
    typeof candidate.entitlementRequests === "number" &&
    typeof candidate.usedRequests === "number" &&
    typeof candidate.remainingPercentage === "number"
  );
}

/** 利用枠の入れ物がなければ null を返し、あれば必須項目がそろった枠だけをキー付きで取り出す。 */
export function readCopilotQuotaSnapshots(
  value: unknown,
): Record<string, CopilotQuotaSnapshotLike> | null {
  if (!value || typeof value !== "object" || !("quotaSnapshots" in value))
    return null;
  const quotaSnapshots = (value as { quotaSnapshots?: unknown }).quotaSnapshots;
  if (!quotaSnapshots || typeof quotaSnapshots !== "object") return null;
  const normalized: Record<string, CopilotQuotaSnapshotLike> = {};
  for (const [quotaKey, snapshot] of Object.entries(quotaSnapshots)) {
    if (isCopilotQuotaSnapshotLike(snapshot)) normalized[quotaKey] = snapshot;
  }
  return normalized;
}

/** 0 以上 1 以下の残量を比率として百分率へ変換し、範囲外の値はそのまま返す。 */
function normalizeQuotaRemainingPercentage(value: number): number {
  return value >= 0 && value <= 1 ? value * 100 : value;
}

/** 有効な枠だけを共通形式へ写し、超過の既定値を補って枠のキー順に並べる。 */
export function toProviderQuotaSnapshots(
  snapshots:
    Record<string, CopilotQuotaSnapshotLike | undefined> | null | undefined,
): ProviderQuotaSnapshot[] {
  if (!snapshots) return [];
  return Object.entries(snapshots)
    .filter((entry): entry is [string, CopilotQuotaSnapshotLike] =>
      isCopilotQuotaSnapshotLike(entry[1]),
    )
    .map(([quotaKey, snapshot]) => ({
      quotaKey,
      entitlementRequests: snapshot.entitlementRequests,
      usedRequests: snapshot.usedRequests,
      remainingPercentage: normalizeQuotaRemainingPercentage(
        snapshot.remainingPercentage,
      ),
      overage: snapshot.overage ?? 0,
      overageAllowedWithExhaustedQuota:
        snapshot.overageAllowedWithExhaustedQuota ?? false,
      resetDate: snapshot.resetDate,
    }))
    .sort((left, right) => left.quotaKey.localeCompare(right.quotaKey));
}

/** 取得時刻付きの利用枠を組み立てる。表示できる枠が一つもなければ null を返す。 */
export function buildCopilotProviderQuotaTelemetry(
  providerId: string,
  snapshots:
    Record<string, CopilotQuotaSnapshotLike | undefined> | null | undefined,
  updatedAt: string,
): ProviderQuotaTelemetry | null {
  const normalizedSnapshots = toProviderQuotaSnapshots(snapshots);
  return normalizedSnapshots.length === 0
    ? null
    : { provider: providerId, updatedAt, snapshots: normalizedSnapshots };
}

/** SDK が報告するコンテキスト使用量を、プロバイダー・Session・取得時刻にひも付ける。 */
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
