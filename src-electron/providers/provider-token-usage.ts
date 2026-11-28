import type { ProviderUsage } from "../../src-shared/session/runtime-state.js";

/** Codex の使用量から参照する snake_case の項目。値の型と欠落は正規化時に確認する。 */
export type CodexTokenUsageLike = {
  input_tokens?: unknown;
  cached_input_tokens?: unknown;
  output_tokens?: unknown;
  reasoning_output_tokens?: unknown;
  total_tokens?: unknown;
};

/** Copilot の使用量から参照する項目。キャッシュ読み取りと推論には別名も受け付ける。 */
export type CopilotTokenUsageLike = {
  inputTokens?: unknown;
  cacheReadTokens?: unknown;
  cachedInputTokens?: unknown;
  outputTokens?: unknown;
  reasoningTokens?: unknown;
  reasoningOutputTokens?: unknown;
  totalTokens?: unknown;
};

/** 有限の数値だけを受け付け、文字列や非有限値は欠測として扱う。 */
function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** 入力・キャッシュ・出力のすべてが欠測なら null を返す。明示の合計がなければ入力と出力の和を使う。 */
function normalizeTokenUsage(input: {
  inputTokens?: unknown;
  cachedInputTokens?: unknown;
  outputTokens?: unknown;
  reasoningOutputTokens?: unknown;
  totalTokens?: unknown;
}): ProviderUsage | null {
  const inputTokens = finiteNumber(input.inputTokens);
  const cachedInputTokens = finiteNumber(input.cachedInputTokens);
  const outputTokens = finiteNumber(input.outputTokens);

  if (
    inputTokens === null &&
    cachedInputTokens === null &&
    outputTokens === null
  ) {
    return null;
  }

  const normalized: ProviderUsage = {
    inputTokens: inputTokens ?? 0,
    cachedInputTokens: cachedInputTokens ?? 0,
    outputTokens: outputTokens ?? 0,
  };

  const reasoningOutputTokens = finiteNumber(input.reasoningOutputTokens);
  if (reasoningOutputTokens !== null) {
    normalized.reasoningOutputTokens = reasoningOutputTokens;
  }

  const totalTokens = finiteNumber(input.totalTokens);
  normalized.totalTokens =
    totalTokens ?? normalized.inputTokens + normalized.outputTokens;

  return normalized;
}

/** Codex の使用量を共通形式に写し、使用量そのものがなければ null を返す。 */
export function normalizeCodexTokenUsage(
  usage: CodexTokenUsageLike | null | undefined,
): ProviderUsage | null {
  if (!usage) {
    return null;
  }

  return normalizeTokenUsage({
    inputTokens: usage.input_tokens,
    cachedInputTokens: usage.cached_input_tokens,
    outputTokens: usage.output_tokens,
    reasoningOutputTokens: usage.reasoning_output_tokens,
    totalTokens: usage.total_tokens,
  });
}

/** Copilot の使用量を共通形式に写す。キャッシュと推論の主項目が nullish のときだけ別名を使う。 */
export function normalizeCopilotTokenUsage(
  usage: CopilotTokenUsageLike | null | undefined,
): ProviderUsage | null {
  if (!usage) {
    return null;
  }

  return normalizeTokenUsage({
    inputTokens: usage.inputTokens,
    cachedInputTokens: usage.cachedInputTokens ?? usage.cacheReadTokens,
    outputTokens: usage.outputTokens,
    reasoningOutputTokens: usage.reasoningOutputTokens ?? usage.reasoningTokens,
    totalTokens: usage.totalTokens,
  });
}
