const DEFAULT_FEEDBACK = "Mate 成長の手動適用が完了したよ。";

export type ApplyPendingGrowthResult = {
  candidateCount?: unknown;
  appliedCount?: unknown;
  skippedCount?: unknown;
  revisionId?: unknown;
};

export function buildApplyPendingGrowthFeedback(result: unknown): string {
  if (result === null || typeof result !== "object") {
    return DEFAULT_FEEDBACK;
  }

  const typedResult = result as ApplyPendingGrowthResult;
  const parts: string[] = [];

  if (typeof typedResult.candidateCount === "number") {
    parts.push(`候補 ${typedResult.candidateCount} 件`);
  }
  if (typeof typedResult.appliedCount === "number") {
    parts.push(`適用 ${typedResult.appliedCount} 件`);
  }
  if (typeof typedResult.skippedCount === "number") {
    parts.push(`スキップ ${typedResult.skippedCount} 件`);
  }
  if (typeof typedResult.revisionId === "string") {
    parts.push(`revisionId ${typedResult.revisionId}`);
  }

  if (parts.length === 0) {
    return DEFAULT_FEEDBACK;
  }

  return `Mate 成長を手動適用したよ（${parts.join(" / ")}）。`;
}
