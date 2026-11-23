import type { ModelReasoningEffort } from "./model-catalog.js";

export const WITHMATE_REVIEW_PROVIDER_IDS = ["codex", "claude"] as const;
export type WithMateReviewProviderId = (typeof WITHMATE_REVIEW_PROVIDER_IDS)[number];

export type WithMateAutoReviewSettings = {
  providerId: WithMateReviewProviderId;
  model: string;
  reasoningEffort: ModelReasoningEffort | "";
};

export function isWithMateReviewProvider(providerId: unknown): providerId is WithMateReviewProviderId {
  return WITHMATE_REVIEW_PROVIDER_IDS.some((id) => id === providerId);
}

export function supportsWithMateAutoReview(providerId: string): boolean {
  return providerId === "copilot" || providerId === "opencode";
}

/** An incomplete or unrecognized setting never enables automatic decisions. */
export function normalizeWithMateAutoReview(value: unknown): WithMateAutoReviewSettings | null {
  if (!value || typeof value !== "object") return null;
  const { providerId, model, reasoningEffort } = value as Partial<WithMateAutoReviewSettings>;
  if (!isWithMateReviewProvider(providerId) || typeof model !== "string" || !model.trim()
    || typeof reasoningEffort !== "string" || reasoningEffort.trim() !== reasoningEffort) return null;
  return { providerId, model: model.trim(), reasoningEffort };
}
