import type { ModelReasoningEffort } from "./model-catalog.js";

/** WithMateの自動レビューで判断する側として選択できるProvider。 */
export const WITHMATE_REVIEW_PROVIDER_IDS = ["codex", "claude"] as const;
/** レビューを受ける側のProviderではなく、判断役を指定するID。 */
export type WithMateReviewProviderId =
  (typeof WITHMATE_REVIEW_PROVIDER_IDS)[number];

/** 判断役のProviderとモデル設定。推論レベルを指定しない場合は空文字列。 */
export type WithMateAutoReviewSettings = {
  providerId: WithMateReviewProviderId;
  model: string;
  reasoningEffort: ModelReasoningEffort | "";
};

/** 保存値が判断役として認識されているProviderかを調べる。 */
export function isWithMateReviewProvider(
  providerId: unknown,
): providerId is WithMateReviewProviderId {
  return WITHMATE_REVIEW_PROVIDER_IDS.some((id) => id === providerId);
}

/** 実行先のProviderにWithMate側の自動レビューを提供するかを判定する。 */
export function supportsWithMateAutoReview(providerId: unknown): boolean {
  return providerId === "copilot" || providerId === "opencode";
}

/** 不完全または未認識の設定で自動判断が有効になることはない。 */
export function normalizeWithMateAutoReview(
  value: unknown,
): WithMateAutoReviewSettings | null {
  if (!value || typeof value !== "object") return null;
  const { providerId, model, reasoningEffort } =
    value as Partial<WithMateAutoReviewSettings>;
  if (
    !isWithMateReviewProvider(providerId) ||
    typeof model !== "string" ||
    !model.trim() ||
    typeof reasoningEffort !== "string" ||
    reasoningEffort.trim() !== reasoningEffort
  )
    return null;
  return { providerId, model: model.trim(), reasoningEffort };
}
