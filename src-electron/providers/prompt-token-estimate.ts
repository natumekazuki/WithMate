import type { ProviderLogicalPrompt } from "../../src-shared/session/runtime-state.js";

/** 文字列長と、それを基にした概算トークン数。プロバイダーによる実測値ではない。 */
export type PromptTokenEstimate = {
  charCount: number;
  estimatedTokens: number;
};

/** システム指示、入力、結合済みプロンプトそれぞれの概算値。 */
export type LogicalPromptTokenEstimate = {
  system: PromptTokenEstimate;
  input: PromptTokenEstimate;
  composed: PromptTokenEstimate;
};

/** UTF-16 のコード単位を 4 個で約 1 トークンと見なし、端数は切り上げる。空文字列は 0。 */
export function estimatePromptTokens(text: string): PromptTokenEstimate {
  const charCount = text.length;
  return {
    charCount,
    estimatedTokens: charCount === 0 ? 0 : Math.ceil(charCount / 4),
  };
}

/** 区切りの文字も含めるため、結合版はシステム・入力の見積もりを足さず、実際の結合文字列から算出する。 */
export function estimateLogicalPromptTokens(
  logicalPrompt: ProviderLogicalPrompt,
): LogicalPromptTokenEstimate {
  return {
    system: estimatePromptTokens(logicalPrompt.systemText),
    input: estimatePromptTokens(logicalPrompt.inputText),
    composed: estimatePromptTokens(logicalPrompt.composedText),
  };
}
